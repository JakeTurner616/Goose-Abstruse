// src/game.ts
import { loadTiled, drawTile, type TiledWorld, GID_MASK } from "./tiled";
import { createMountainBG } from "./bgMountains";
import { drawWaterfalls } from "./bgWaterfall";
import { drawTilePatterns } from "./bgTilePatterns";
import { createPlayer, createGooseEntity, type Player } from "./player";
import type { Keys } from "./input";

import { loadKeyAtlas, createKeyEntity, type KeyEntity, type KeyAtlas } from "./key";
import { createDoorDissolve } from "./doorDissolve";

import type { SoundSystem } from "./sound";
import { createUiMessageSystem } from "./uiMessage";
import { createUiHudSystem } from "./uiHud";

import { clamp } from "./game/math";
import type { Cam } from "./game/types";
import { scanSpawnPoints, type SpawnPoint } from "./game/spawn";
import { entityCollider, hazardCollider, aabbOverlaps, keyCollider } from "./game/colliders";
import { resolveEntityCollisions } from "./game/entitySeparation";
import { aabbOverlapsTileLocalIndex } from "./game/tileOverlap";
import { snapToPixel } from "./game/pixel";
import { createAudioRig } from "./game/audioRig";

export type Game = {
  cam: Cam;
  get invert(): boolean;
  toggleInvert(): void;

  mountainBG: ReturnType<typeof createMountainBG>;
  userGesture(): void;

  loadLevel(i: number): void;
  nextLevel(): void;
  getLevelIndex(): number;
  getLevelCount(): number;

  update(dt: number, keys: Keys): void;
  draw(offCtx: CanvasRenderingContext2D, vw: number, vh: number): void;
};

export type CreateGameOpts = {
  sound?: SoundSystem;
  levels?: string[];
  startLevel?: number;
};

const DOOR_LOCAL_INDEXES = [64, 65, 79, 80];

// UI trigger tile: tileset-local index (1-based)
const UI_TRIGGER_LOCAL_INDEX = 77;

// Finish tile: tileset-local index (1-based)
const FINISH_LOCAL_INDEX = 77;

// Spikes tile: tileset-local index (1-based)
const SPIKE_LOCAL_INDEX = 76;

// Win sequence timing
const WIN_HOLD_SEC = 1.2;

// Death/respawn timing
const DEATH_HOLD_SEC = 0.65;

export async function createGame(vw: number, vh: number, opts?: CreateGameOpts): Promise<Game> {
  const cam: Cam = { x: 0, y: 0 };
  let invert = false;

  const mountainBG = createMountainBG(vw, vh);

  // sound
  const { sfx, play } = createAudioRig(opts?.sound);

  // levels
  const LEVELS = (opts?.levels?.length ? opts.levels : ["/Tiled/level1.tmx", "/Tiled/level1 copy.tmx"]).slice();
  let levelIndex = clamp(opts?.startLevel ?? 0, 0, Math.max(0, LEVELS.length - 1)) | 0;

  let loadingLevel = false;
  let pendingLoad: Promise<void> | null = null;

  // win state
  let winActive = false;
  let winT = 0;
  let winPlayed = false;

  // death state
  let deadActive = false;
  let deadT = 0;
  let deadPlayed = false;

  // world + entities
  let world: TiledWorld | null = null;
  let player: Player;
  const gooselings: Player[] = [];

  // key
  let keyAtlas: KeyAtlas | null = null;
  let key: KeyEntity | null = null;

  // misc
  const doorFx = createDoorDissolve();
  const ui = createUiMessageSystem();
  const hud = createUiHudSystem();
  let t = 0;
  let collisionSfxCooldown = 0;

  // per-level counters (NOT globals)
  let keysTotal = 0;
  let keysCollected = 0;

  function isSolidTile(tx: number, ty: number) {
    if (!world) return false;
    const { map } = world;
    if (tx < 0 || ty < 0 || tx >= map.w || ty >= map.h) return true;
    const gidRaw = (map as any).collide[ty * map.w + tx] >>> 0;
    return (gidRaw & GID_MASK) !== 0;
  }

  function updateCamera() {
    if (!player) return;
    const ww = world ? world.map.w * world.map.tw : vw;
    const wh = world ? world.map.h * world.map.th : vh;

    const targetX = player.x + (player.w >> 1) - (vw >> 1);
    const targetY = player.y + (player.h >> 1) - (vh >> 1);

    cam.x = Math.floor(clamp(targetX, 0, Math.max(0, ww - vw)));
    cam.y = Math.floor(clamp(targetY, 0, Math.max(0, wh - vh)));
  }

  async function spawnGooselings(points: SpawnPoint[]) {
    gooselings.length = 0;
    const babies = points.filter((p) => p.kind === "gooseling");
    if (!babies.length) return;

    const made = await Promise.all(
      babies.map((p) =>
        createGooseEntity({
          x: p.x,
          y: p.y,
          scale: 0.65,
          controllable: false,
        })
      )
    );

    gooselings.push(...made);
    for (const b of gooselings) snapToPixel(b);
  }

  function resetWinState() {
    winActive = false;
    winT = 0;
    winPlayed = false;
  }

  function resetDeathState() {
    deadActive = false;
    deadT = 0;
    deadPlayed = false;
  }

  function freezeAll() {
    const all = [player, ...gooselings];
    for (const e of all) {
      e.vx = 0;
      e.vy = 0;
      snapToPixel(e);
    }
  }

  function beginWinSequence() {
    if (winActive) return;
    winActive = true;
    winT = 0;
    winPlayed = false;
    freezeAll();
    ui.set("LEVEL COMPLETE!");
  }

  function beginDeathSequence() {
    if (deadActive || loadingLevel) return;
    deadActive = true;
    deadT = 0;
    deadPlayed = false;
    freezeAll();
    ui.set("OUCH!");
  }

  function isEntityOnFinish(p: Player) {
    if (!world) return false;
    return aabbOverlapsTileLocalIndex(world, entityCollider(p), FINISH_LOCAL_INDEX, ["tile"]);
  }

  function allEntitiesOnFinish() {
    if (!world) return false;
    if (!gooselings.length) return false;
    if (!isEntityOnFinish(player)) return false;
    for (const b of gooselings) if (!isEntityOnFinish(b)) return false;
    return true;
  }

  function anyEntityOnSpikes(allEntities: Player[]) {
    if (!world) return false;

    for (const e of allEntities) {
      // IMPORTANT: hazards use FEET collider, not center collider
      if (aabbOverlapsTileLocalIndex(world, hazardCollider(e), SPIKE_LOCAL_INDEX, ["tile", "collide"])) return true;
    }
    return false;
  }

  async function applyLoadedWorld(nextWorld: TiledWorld) {
    world = nextWorld;

    const sp = scanSpawnPoints(world);
    keysTotal = sp.filter((s) => s.kind === "key").length | 0;
    keysCollected = 0;

    // player start
    let startX = 24;
    let startY = 0;
    const goose = sp.find((s) => s.kind === "goose");
    if (goose) {
      startX = goose.x;
      startY = goose.y;
    }

    player.x = startX;
    player.y = startY;
    player.vx = 0;
    player.vy = 0;
    snapToPixel(player);

    // babies
    await spawnGooselings(sp);

    // key entity (first key spawn)
    key = null;
    if (keyAtlas) {
      const kp = sp.find((s) => s.kind === "key");
      if (kp) {
        const tw = world.map.tw;
        const th = world.map.th;
        key = createKeyEntity(keyAtlas, { x: kp.x + (tw >> 1), y: kp.y + th, scale: 1, fps: 14 });
      }
    }

    doorFx.reset?.();
    ui.clear();
    resetWinState();
    resetDeathState();
    updateCamera();
  }

  function loadLevel(i: number) {
    if (!LEVELS.length) return;

    const idx = clamp(i | 0, 0, LEVELS.length - 1) | 0;
    levelIndex = idx;

    if (loadingLevel) return;

    loadingLevel = true;
    ui.set("LOADING...");
    resetWinState();
    resetDeathState();

    const url = LEVELS[levelIndex];

    pendingLoad = (async () => {
      try {
        const next = await loadTiled(url);
        await applyLoadedWorld(next);
      } finally {
        loadingLevel = false;
        pendingLoad = null;
      }
    })();
  }

  function nextLevel() {
    if (!LEVELS.length) return;
    loadLevel(((levelIndex + 1) % LEVELS.length) | 0);
  }

  // ---------------------------------------------------------------------------
  // Initial boot
  // ---------------------------------------------------------------------------
  const [p, firstWorld, ka] = await Promise.all([
    createPlayer({ x: 24, y: 24 }),
    loadTiled(LEVELS[levelIndex]),
    loadKeyAtlas("/Key/").catch(() => null),
  ]);

  player = p;
  keyAtlas = ka;
  await applyLoadedWorld(firstWorld);

  function updateHud(dt: number) {
    hud.setCounts({
      goslings: gooselings.length | 0,
      keysCur: keysCollected | 0,
      keysTotal: keysTotal | 0,
    });
    hud.update(dt);
  }

  function update(dt: number, keys: Keys) {
    if (!player) return;

    // unlock audio on any gameplay input
    if (keys.a || keys.b || keys.start || keys.select || keys.left || keys.right || keys.up || keys.down) {
      sfx.userGesture();
    }

    if (dt > 0) t += Math.min(dt, 0.05);

    ui.update(dt);

    // Loading: keep HUD/UI stable
    if (loadingLevel || !world) {
      updateHud(dt);
      return;
    }

    // Death: freeze, then reload current
    if (deadActive) {
      deadT += dt;

      if (!deadPlayed) {
        deadPlayed = true;
        play("death", { volume: 0.7, minGapMs: 180 });
      }

      if (key) key.update(dt);
      updateHud(dt);
      updateCamera();

      if (deadT >= DEATH_HOLD_SEC) {
        ui.clear();
        loadLevel(levelIndex);
      }
      return;
    }

    // Win: freeze, then advance
    if (winActive) {
      winT += dt;

      if (!winPlayed) {
        winPlayed = true;
        play("uiConfirm", { volume: 0.65, minGapMs: 120 });
      }

      if (key) key.update(dt);
      updateHud(dt);
      updateCamera();

      if (winT >= WIN_HOLD_SEC) {
        ui.clear();
        nextLevel();
      }
      return;
    }

    // normal update path
    if (key) key.update(dt);
    if (collisionSfxCooldown > 0) collisionSfxCooldown = Math.max(0, collisionSfxCooldown - dt);

    const allEntities: Player[] = [player, ...gooselings];
    const intentX = (keys.left ? -1 : 0) + (keys.right ? 1 : 0);

    const ww = world.map.w * world.map.tw;
    const wh = world.map.h * world.map.th;
    const tw = world.map.tw;
    const th = world.map.th;

    const worldInfo = {
      w: ww,
      h: wh,
      tw,
      th,
      tilesW: (ww / tw) | 0,
      tilesH: (wh / th) | 0,
    };

    const pvy0 = player.vy;
    player.update(dt, keys, isSolidTile, worldInfo);
    const masterJump = pvy0 >= 0 && player.vy < 0;

    if (masterJump) play("jump", { volume: 0.55, minGapMs: 40 });

    for (const b of gooselings) b.puppetStep(dt, intentX, player.vx, masterJump, isSolidTile, worldInfo);

    const collided = resolveEntityCollisions(allEntities, ww, wh, isSolidTile, tw, th);
    if (collided && collisionSfxCooldown === 0) {
      play("bump", { volume: 0.18, detune: -180, minGapMs: 70 });
      collisionSfxCooldown = 0.12;
    }

    // spikes death
    if (anyEntityOnSpikes(allEntities)) {
      beginDeathSequence();
      updateCamera();
      return;
    }

    // UI trigger
    const onTrigger = aabbOverlapsTileLocalIndex(
      world,
      entityCollider(player),
      UI_TRIGGER_LOCAL_INDEX,
      ["tile", "collide"]
    );
    if (onTrigger) ui.set("Round up the goslings! <-- / -->");
    else ui.clear();

    updateHud(dt);

    // key pickup
    if (key) {
      const kA = keyCollider(key);
      let picked = false;

      for (let i = 0; i < allEntities.length; i++) {
        if (aabbOverlaps(kA, entityCollider(allEntities[i]))) {
          picked = true;
          break;
        }
      }

      if (picked) {
        key = null;
        keysCollected = (keysCollected + 1) | 0;

        play("keyPickup", { volume: 0.65, minGapMs: 90 });
        play("doorOpen", { volume: 0.4, detune: +120, minGapMs: 120 });

        doorFx.begin(world, t, {
          localIndexes: DOOR_LOCAL_INDEXES,
          durationSec: 0.55,
          minRate: 18,
          maxRate: 140,
        });
      }
    }

    doorFx.step(world, dt);

    // win condition
    if (allEntitiesOnFinish()) {
      beginWinSequence();
      updateCamera();
      return;
    }

    updateCamera();
  }

  function drawMap(offCtx: CanvasRenderingContext2D, vw: number, vh: number) {
    if (!world) return;
    const { map, ts } = world;
    const tw = map.tw;
    const th = map.th;

    const cx = Math.floor(cam.x);
    const cy = Math.floor(cam.y);

    const x0 = clamp((cx / tw) | 0, 0, map.w);
    const y0 = clamp((cy / th) | 0, 0, map.h);
    const x1 = clamp(((cx + vw + tw) / tw) | 0, 0, map.w);
    const y1 = clamp(((cy + vh + th) / th) | 0, 0, map.h);

    const ox = (cx - x0 * tw) | 0;
    const oy = (cy - y0 * th) | 0;

    const tileLayer = (map as any).tile as Uint32Array;
    const collideLayer = (map as any).collide as Uint32Array;

    for (let ty = y0; ty < y1; ty++) {
      const row = ty * map.w;
      const dy = ((ty - y0) * th - oy) | 0;
      for (let tx = x0; tx < x1; tx++) {
        const dx = ((tx - x0) * tw - ox) | 0;

        const gidA = tileLayer[row + tx] >>> 0;
        if ((gidA & GID_MASK) !== 0) drawTile(offCtx, ts, gidA, dx, dy);

        const gidB = collideLayer[row + tx] >>> 0;
        if ((gidB & GID_MASK) !== 0) drawTile(offCtx, ts, gidB, dx, dy);
      }
    }
  }

  function drawHud(offCtx: CanvasRenderingContext2D) {
    hud.draw(offCtx, vw, vh, invert);
    offCtx.fillStyle = invert ? "#000" : "#fff";
    offCtx.font = "10px monospace";
  }

  function draw(offCtx: CanvasRenderingContext2D, vw: number, vh: number) {
    offCtx.fillStyle = "#000";
    offCtx.fillRect(0, 0, vw, vh);

    drawMap(offCtx, vw, vh);

    if (world) {
      drawWaterfalls(offCtx, world, cam, vw, vh, t, {
        layerName: "waterfall",
        localIndex: 2,
        speed: 12,
        foamSpeed: 6,
      });

      void drawTilePatterns;
    }

    if (key) key.draw(offCtx, cam);

    const bob = winActive ? (((Math.sin(winT * 10) * 2) | 0) as number) : 0;

    if (bob) {
      offCtx.save();
      offCtx.translate(0, bob);
      for (const b of gooselings) b.draw(offCtx, cam);
      player.draw(offCtx, cam);
      offCtx.restore();
    } else {
      for (const b of gooselings) b.draw(offCtx, cam);
      player.draw(offCtx, cam);
    }

    ui.draw(offCtx, vw, vh, invert);
    drawHud(offCtx);
  }

  return {
    cam,
    get invert() {
      return invert;
    },
    toggleInvert() {
      invert = !invert;
      play("invert", { volume: 0.2, detune: invert ? +160 : -160, minGapMs: 60 });
    },
    mountainBG,
    userGesture() {
      sfx.userGesture();
    },

    loadLevel,
    nextLevel,
    getLevelIndex() {
      return levelIndex | 0;
    },
    getLevelCount() {
      return LEVELS.length | 0;
    },

    update,
    draw,
  };
}
