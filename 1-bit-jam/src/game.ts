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
import { createSoundSystem } from "./sound";
import { loadSoundBank, type SoundBank } from "./soundBank";

import { createUiMessageSystem } from "./uiMessage";
import { createUiHudSystem } from "./uiHud";

const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);

type Cam = { x: number; y: number };

type SpawnKind = "goose" | "gooseling" | "key";
type SpawnPoint = { kind: SpawnKind; x: number; y: number };

let keysTotal = 0;
let keysCollected = 0;

function spawnKindFromGid(gidMasked: number, firstgid: number): SpawnKind | null {
  if (gidMasked === 1) return "goose";
  if (gidMasked === 2) return "gooseling";

  if (gidMasked === (firstgid >>> 0)) return "goose"; // index 1
  if (gidMasked === ((firstgid + 1) >>> 0)) return "gooseling"; // index 2

  if (gidMasked === ((firstgid + 8) >>> 0)) return "key"; // index 9
  return null;
}

function scanSpawnPoints(w: TiledWorld): SpawnPoint[] {
  const out: SpawnPoint[] = [];
  const { map, ts } = w;
  const L = (map as any).spawns as Uint32Array;

  for (let i = 0; i < L.length; i++) {
    const gidRaw = L[i] >>> 0;
    const gid = (gidRaw & GID_MASK) >>> 0;
    if (!gid) continue;

    const kind = spawnKindFromGid(gid, ts.firstgid >>> 0);
    if (!kind) continue;

    const tx = (i % map.w) | 0;
    const ty = (i / map.w) | 0;

    out.push({
      kind,
      x: tx * map.tw,
      y: ty * map.th,
    });
  }
  return out;
}

export type Game = {
  cam: Cam;
  get invert(): boolean;
  toggleInvert(): void;

  mountainBG: ReturnType<typeof createMountainBG>;
  userGesture(): void;

  /** Explicitly load a level by index (0..levels-1). Out-of-range clamps. */
  loadLevel(i: number): void;
  /** Convenience: load next level (wraps to 0). */
  nextLevel(): void;
  /** Useful for UI/debug */
  getLevelIndex(): number;
  getLevelCount(): number;

  update(dt: number, keys: Keys): void;
  draw(offCtx: CanvasRenderingContext2D, vw: number, vh: number): void;
};

export type CreateGameOpts = {
  sound?: SoundSystem; // injected shared sound system (from main)
  /** Optional level list; defaults to a single sample map. */
  levels?: string[];
  /** Optional starting level index; defaults to 0. */
  startLevel?: number;
};

// --- entity collision (revised weighting + stability)

const COLLIDER_FRAC = 16 / 64;
const COLLIDER_MIN = 4;

type CAABB = { x: number; y: number; w: number; h: number };

function entityCollider(p: Player): CAABB {
  const cw = Math.max(COLLIDER_MIN, (p.w * COLLIDER_FRAC + 0.5) | 0);
  const ch = Math.max(COLLIDER_MIN, (p.h * COLLIDER_FRAC + 0.5) | 0);
  const cx = p.x + (p.w - cw) * 0.5;
  const cy = p.y + (p.h - ch) * 0.5;
  return { x: cx, y: cy, w: cw, h: ch };
}

function aabbOverlaps(a: CAABB, b: CAABB) {
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
}

// KeyEntity is anchored at bottom-center; its nominal untrimmed (w,h) come from atlas sourceSize.
function keyCollider(k: KeyEntity): CAABB {
  const s = k.scale || 1;
  const w = k.w * s;
  const h = k.h * s;
  return { x: k.x - w * 0.5, y: k.y - h, w, h };
}

// small stable hash for pair tie-breaks
function pairHash(i: number, j: number) {
  const a = i < j ? i : j;
  const b = i < j ? j : i;
  let h = (a * 73856093) ^ (b * 19349663);
  h = (h ^ (h >>> 16)) >>> 0;
  return h;
}

function isControllable(p: Player): boolean {
  return !!(p as any)?._dbg?.controllable;
}

function separationWeights(a: Player, b: Player) {
  const ca = isControllable(a);
  const cb = isControllable(b);

  if (ca === cb) return { wa: 0.5, wb: 0.5 };
  if (ca && !cb) return { wa: 0.15, wb: 0.85 };
  return { wa: 0.85, wb: 0.15 };
}

function separatePair(a: Player, b: Player, i: number, j: number, worldW: number, worldH: number) {
  const A = entityCollider(a);
  const B = entityCollider(b);

  const ax2 = A.x + A.w;
  const ay2 = A.y + A.h;
  const bx2 = B.x + B.w;
  const by2 = B.y + B.h;

  if (ax2 <= B.x || bx2 <= A.x || ay2 <= B.y || by2 <= A.y) return false;

  const ox = Math.min(ax2, bx2) - Math.max(A.x, B.x);
  const oy = Math.min(ay2, by2) - Math.max(A.y, B.y);
  if (ox <= 0 || oy <= 0) return false;

  const SLOP = 0.15;
  let oxs = ox - SLOP;

  const MIN_PUSH = 0.25;
  if (oxs < MIN_PUSH) oxs = MIN_PUSH;

  const acx = A.x + A.w * 0.5;
  const bcx = B.x + B.w * 0.5;

  let dx = acx - bcx;

  const EPS = 1e-6;
  if (Math.abs(dx) < EPS) {
    const h = pairHash(i, j);
    dx = h & 1 ? 1 : -1;
  }

  const { wa, wb } = separationWeights(a, b);

  const dir = dx < 0 ? -1 : 1;
  const push = oxs;

  if (wa) a.x = clamp(a.x + dir * push * wa, 0, worldW - a.w);
  if (wb) b.x = clamp(b.x - dir * push * wb, 0, worldW - b.w);

  if (wa) a.vx *= 0.6;
  if (wb) b.vx *= 0.6;

  return true;
}

function resolveEntityCollisions(entities: Player[], worldW: number, worldH: number) {
  const ITERS = 1;
  let anyEver = false;

  for (let it = 0; it < ITERS; it++) {
    let any = false;
    for (let i = 0; i < entities.length; i++) {
      for (let j = i + 1; j < entities.length; j++) {
        if (separatePair(entities[i], entities[j], i, j, worldW, worldH)) any = true;
      }
    }

    if (!any) break;
  }

  return anyEver;
}

function snapToPixel(p: Player) {
  p.x = (p.x + 0.5) | 0;
  p.y = (p.y + 0.5) | 0;
}

const DOOR_LOCAL_INDEXES = [64, 65, 79, 80];

// UI trigger tile: tileset-local index (1-based)
const UI_TRIGGER_LOCAL_INDEX = 77;

// Finish tile: tileset-local index (1-based)
// Put your “finish line” tile on the *tile* layer (or collide layer if you want).
const FINISH_LOCAL_INDEX = 77;

// Win sequence timing
const WIN_HOLD_SEC = 1.2;

// IMPORTANT: keep this consistent with your filesystem: public/Sounds/*.json
const SFX_PATHS: Record<string, string> = {
  uiClick: "/Sounds/uiClick.json",
  uiConfirm: "/Sounds/uiConfirm.json",
  invert: "/Sounds/invert.json",
  jump: "/Sounds/jump.json",
  bump: "/Sounds/bump.json",
  keyPickup: "/Sounds/keyPickup.json",
  doorOpen: "/Sounds/doorOpen.json",
};

function aabbOverlapsTileLocalIndex(
  w: TiledWorld,
  aabb: { x: number; y: number; w: number; h: number },
  localIndex: number,
  layers: string[] = ["tile", "collide"]
) {
  const { map, ts } = w;
  const tw = map.tw | 0;
  const th = map.th | 0;

  const x0 = (aabb.x / tw) | 0;
  const y0 = (aabb.y / th) | 0;
  const x1 = (((aabb.x + aabb.w - 1) / tw) | 0);
  const y1 = (((aabb.y + aabb.h - 1) / th) | 0);

  const first = ts.firstgid >>> 0;

  for (const layerName of layers) {
    const L = (map as any)[layerName] as Uint32Array | undefined;
    if (!L) continue;

    for (let ty = y0; ty <= y1; ty++) {
      if (ty < 0 || ty >= map.h) continue;
      const row = ty * map.w;

      for (let tx = x0; tx <= x1; tx++) {
        if (tx < 0 || tx >= map.w) continue;

        const gidRaw = L[row + tx] >>> 0;
        const gid = (gidRaw & GID_MASK) >>> 0;
        if (!gid) continue;

        // tileset-local index is 1-based
        const li = ((gid - first + 1) | 0);
        if (li === localIndex) return true;
      }
    }
  }

  return false;
}

export async function createGame(vw: number, vh: number, opts?: CreateGameOpts): Promise<Game> {
  const cam: Cam = { x: 0, y: 0 };
  let invert = false;

  const mountainBG = createMountainBG(vw, vh);

  // ---- sound: USE injected shared sound system (from main) if provided
  const sfx: SoundSystem = opts?.sound ?? createSoundSystem({ volume: 0.15 });
  let bank: SoundBank | null = null;

  loadSoundBank(sfx, SFX_PATHS)
    .then((b) => {
      bank = b;
    })
    .catch(() => {
      bank = null;
    });

  function fallbackPlay(name: string, opts2?: { volume?: number; detune?: number; minGapMs?: number }) {
    if (name === "jump") sfx.playPreset("jump", opts2);
    else if (name === "keyPickup") sfx.playPreset("pickupCoin", opts2);
    else if (name === "doorOpen") sfx.playPreset("powerUp", opts2);
    else if (name === "bump") sfx.playPreset("hitHurt", opts2);
    else if (name === "invert") sfx.playPreset("blipSelect", opts2);
    else if (name === "uiConfirm") sfx.playPreset("powerUp", opts2);
    else sfx.playPreset("click", opts2);
  }

  function play(name: string, opts2?: { volume?: number; detune?: number; minGapMs?: number }) {
    if (!bank) {
      fallbackPlay(name, opts2);
      return;
    }
    try {
      bank.play(name, opts2);
    } catch {
      fallbackPlay(name, opts2);
    }
  }

  // ---------------------------------------------------------------------------
  // Level system
  // ---------------------------------------------------------------------------
  const LEVELS = (opts?.levels?.length
  ? opts.levels
  : ["/Tiled/level1.tmx", "/Tiled/level1 copy.tmx"]).slice();
  let levelIndex = clamp(opts?.startLevel ?? 0, 0, Math.max(0, LEVELS.length - 1)) | 0;

  let loadingLevel = false;
  let pendingLoad: Promise<void> | null = null;

  // Win gate state
  let winActive = false;
  let winT = 0;
  let winPlayed = false;

  let world: TiledWorld | null = null;
  let player: Player;
  const gooselings: Player[] = [];

  let keyAtlas: KeyAtlas | null = null;
  let key: KeyEntity | null = null;

  const doorFx = createDoorDissolve();
  const ui = createUiMessageSystem();
  const hud = createUiHudSystem(); // FIX: create once, update in update()

  let t = 0;
  let collisionSfxCooldown = 0;

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

    cam.x = ((player.x + (player.w >> 1)) - (vw >> 1)) | 0;
    cam.y = ((player.y + (player.h >> 1)) - (vh >> 1)) | 0;

    cam.x = clamp(cam.x, 0, Math.max(0, ww - vw));
    cam.y = clamp(cam.y, 0, Math.max(0, wh - vh));
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

  function beginWinSequence() {
    if (winActive) return;
    winActive = true;
    winT = 0;
    winPlayed = false;

    // snap everyone for clean finish, kill motion
    const all = [player, ...gooselings];
    for (const e of all) {
      e.vx = 0;
      e.vy = 0;
      snapToPixel(e);
    }

    ui.set("LEVEL COMPLETE!");
  }

  function isEntityOnFinish(p: Player) {
    if (!world) return false;
    // finish tile is expected on tile layer (and/or collide if you want)
    return aabbOverlapsTileLocalIndex(world, entityCollider(p), FINISH_LOCAL_INDEX, ["tile"]);
  }

  function allEntitiesOnFinish() {
    if (!world) return false;
    if (!gooselings.length) return false; // game goal implies there are goslings to round up
    if (!isEntityOnFinish(player)) return false;
    for (const b of gooselings) if (!isEntityOnFinish(b)) return false;
    return true;
  }

  async function applyLoadedWorld(nextWorld: TiledWorld) {
    world = nextWorld;

    // scan spawns
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

    // key entity
    key = null;
    if (keyAtlas) {
      const kp = sp.find((s) => s.kind === "key");
      if (kp) {
        const tw = world.map.tw;
        const th = world.map.th;

        key = createKeyEntity(keyAtlas, {
          x: kp.x + (tw >> 1),
          y: kp.y + th,
          scale: 1,
          fps: 14,
        });
      }
    }

    // clear fx + UI
    doorFx.reset?.(); // if doorDissolve exposes reset; safe if undefined
    ui.clear();
    resetWinState();

    updateCamera();
  }

  function loadLevel(i: number) {
    if (!LEVELS.length) return;

    const idx = clamp(i | 0, 0, LEVELS.length - 1) | 0;
    levelIndex = idx;

    // If a load is already running, just let it finish; next request overrides index and triggers again.
    if (loadingLevel) return;

    loadingLevel = true;
    ui.set("LOADING...");
    resetWinState();

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
    const ni = ((levelIndex + 1) % LEVELS.length) | 0;
    loadLevel(ni);
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

  function update(dt: number, keys: Keys) {
    if (!player) return;

    // unlock audio on any gameplay input
    if (keys.a || keys.b || keys.start || keys.select || keys.left || keys.right || keys.up || keys.down) {
      sfx.userGesture();
    }

    if (dt > 0) t += Math.min(dt, 0.05);

    // keep HUD/UI ticking during loads/win (stable)
    ui.update(dt);

    // If a level is loading, keep things quiet/stable and show HUD.
    if (loadingLevel || !world) {
      hud.setCounts({
        goslings: gooselings.length | 0,
        keysCur: keysCollected | 0,
        keysTotal: keysTotal | 0,
      });
      hud.update(dt);
      return;
    }

    // Win sequence: freeze gameplay, play a short “win” hold, then advance.
    if (winActive) {
      winT += dt;

      if (!winPlayed) {
        winPlayed = true;
        play("uiConfirm", { volume: 0.65, minGapMs: 120 });
      }

      // keep key anim alive if present (nice polish)
      if (key) key.update(dt);

      // keep HUD alive
      hud.setCounts({
        goslings: gooselings.length | 0,
        keysCur: keysCollected | 0,
        keysTotal: keysTotal | 0,
      });
      hud.update(dt);

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

    for (const b of gooselings) {
      b.puppetStep(dt, intentX, player.vx, masterJump, isSolidTile, worldInfo);
    }

    const collided = resolveEntityCollisions(allEntities, ww, wh);
    if (collided && collisionSfxCooldown === 0) {
      play("bump", { volume: 0.18, detune: -180, minGapMs: 70 });
      collisionSfxCooldown = 0.12;
    }

    // --- UI trigger: show banner while player overlaps local index 77 tiles
    const onTrigger = aabbOverlapsTileLocalIndex(world, entityCollider(player), UI_TRIGGER_LOCAL_INDEX, ["tile", "collide"]);
    if (onTrigger) ui.set("Round up the goslings! <-- / -->");
    else ui.clear();

    // --- HUD: update in update() (prevents draw-phase state churn + keeps timing stable)
    hud.setCounts({
      goslings: gooselings.length | 0,
      keysCur: keysCollected | 0,
      keysTotal: keysTotal | 0,
    });
    hud.update(dt);

    // key pickup triggers door dissolve
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
        play("doorOpen", { volume: 0.40, detune: +120, minGapMs: 120 });

        doorFx.begin(world, t, {
          localIndexes: DOOR_LOCAL_INDEXES,
          durationSec: 0.55,
          minRate: 18,
          maxRate: 140,
        });
      }
    }

    doorFx.step(world, dt);

    // -----------------------------------------------------------------------
    // WIN CONDITION:
    // Player goose + ALL goslings must overlap the finish-line tile
    // -----------------------------------------------------------------------
    if (allEntitiesOnFinish()) {
      beginWinSequence();
      // early out so camera/UI reflects win immediately
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

    const x0 = clamp((cam.x / tw) | 0, 0, map.w);
    const y0 = clamp((cam.y / th) | 0, 0, map.h);
    const x1 = clamp(((cam.x + vw + tw - 1) / tw) | 0, 0, map.w);
    const y1 = clamp(((cam.y + vh + th - 1) / th) | 0, 0, map.h);

    const ox = cam.x - x0 * tw;
    const oy = cam.y - y0 * th;

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
    // New HUD (pixel-stable)
    hud.draw(offCtx, vw, vh, invert);

    // Optional debug text underneath
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

    // win “celebration” render-only bob (no physics changes)
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

    // UI banner
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
      play("invert", { volume: 0.20, detune: invert ? +160 : -160, minGapMs: 60 });
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
