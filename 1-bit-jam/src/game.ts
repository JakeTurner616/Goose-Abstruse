// src/game.ts
import type { TiledWorld } from "./tiled";
import { createMountainBG } from "./bgMountains";
import { drawWaterfalls } from "./bgWaterfall";
import { drawTilePatterns } from "./bgTilePatterns";
import type { Player } from "./player";
import type { Keys } from "./input";

import { createDoorDissolve } from "./doorDissolve";

import type { SoundSystem } from "./sound";
import { createUiMessageSystem } from "./uiMessage";
import { createUiHudSystem } from "./uiHud";

import type { Cam } from "./game/types";
import { entityCollider, hazardCollider, aabbOverlaps, keyCollider } from "./game/colliders";
import { resolveEntityCollisions } from "./game/entitySeparation";
import { aabbOverlapsTileLocalIndex } from "./game/tileOverlap";
import { createAudioRig } from "./game/audioRig";
import { createCameraFocusController } from "./game/cameraFocus";
import { drawWorldMap } from "./game/drawMap";
import { createLevelRuntime } from "./game/levelRuntime";
import { createSequenceController } from "./game/sequences";
import {
  CAM_PAN_SEC,
  DEATH_HOLD_SEC,
  DOOR_LOCAL_INDEXES,
  FINISH_LOCAL_INDEX,
  SPIKE_LOCAL_INDEXES,
  WIN_HOLD_SEC,
} from "./game/constants";

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

  // music hooks (main.ts owns the ogg players)
  onWinMusicBegin?: () => void;
  onWinMusicEnd?: () => void;
};

type Aabb = { x: number; y: number; w: number; h: number };

function aabbOverlapsAabb(a: Aabb, b: Aabb) {
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
}

// standard ray-cast point-in-poly
function pointInPoly(px: number, py: number, pts: { x: number; y: number }[]) {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const xi = pts[i].x,
      yi = pts[i].y;
    const xj = pts[j].x,
      yj = pts[j].y;

    const intersect =
      yi > py !== yj > py && px < ((xj - xi) * (py - yi)) / (yj - yi + 1e-12) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

// AABB vs polygon overlap heuristic (fast + solid for “player enters zone” triggers):
// - quick AABB reject
// - if any AABB corner inside poly => overlap
// - if any poly vertex inside AABB => overlap
function aabbOverlapsPoly(a: Aabb, pts: { x: number; y: number }[], polyAabb: Aabb) {
  if (!aabbOverlapsAabb(a, polyAabb)) return false;

  const x0 = a.x,
    y0 = a.y;
  const x1 = a.x + a.w,
    y1 = a.y + a.h;

  // AABB corners + center
  const cx = (x0 + x1) * 0.5;
  const cy = (y0 + y1) * 0.5;

  if (pointInPoly(x0, y0, pts)) return true;
  if (pointInPoly(x1, y0, pts)) return true;
  if (pointInPoly(x0, y1, pts)) return true;
  if (pointInPoly(x1, y1, pts)) return true;
  if (pointInPoly(cx, cy, pts)) return true;

  // any vertex inside AABB
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    if (p.x >= x0 && p.x <= x1 && p.y >= y0 && p.y <= y1) return true;
  }

  return false;
}

export async function createGame(vw: number, vh: number, opts?: CreateGameOpts): Promise<Game> {
  const cam: Cam = { x: 0, y: 0 };
  let invert = false;

  const mountainBG = createMountainBG(vw, vh);

  // sound
  const { sfx, play } = createAudioRig(opts?.sound);

  const doorFx = createDoorDissolve();
  const ui = createUiMessageSystem();
  const hud = createUiHudSystem();

  let t = 0;
  let collisionSfxCooldown = 0;

  // camera focus controller (X / keys.b)
  const camFocus = createCameraFocusController(cam, {
    vw,
    vh,
    panSec: CAM_PAN_SEC,
    playUiClick: () => play("uiClick", { volume: 0.25, minGapMs: 80 }),
  });

  // world/entities + loading
  const runtime = createLevelRuntime({
    levels: opts?.levels,
    startLevel: opts?.startLevel,
    keyAtlasPath: "/Key/",
    setUiMessage: (m) => ui.set(m),
    onWorldApplied: (w) => camFocus.setWorld(w),
    onEntitiesPlaced: (player, babies) => {
      camFocus.setTargets(player, babies);
      camFocus.reset();
      camFocus.update(0);
    },
    onResetForNewLevel: () => {
      doorFx.reset?.();
      ui.clear();
      sequences.resetAll();
      camFocus.reset();
      try {
        opts?.onWinMusicEnd?.();
      } catch {}
    },
  });

  // sequences (win/death hold)
  const sequences = createSequenceController({
    winHoldSec: WIN_HOLD_SEC,
    deathHoldSec: DEATH_HOLD_SEC,
    getAllEntities: () => [runtime.player, ...runtime.gooselings],
    setUiMessage: (m) => ui.set(m),
    clearUi: () => ui.clear(),
    playWinSfx: () => play("uiConfirm", { volume: 0.65, minGapMs: 120 }),
    playDeathSfx: () => play("death", { volume: 0.7, minGapMs: 180 }),
    onWinBegin: () => {
      try {
        opts?.onWinMusicBegin?.();
      } catch {}
      runtime.preloadNextLevel();
    },
    onWinEnd: () => {
      try {
        opts?.onWinMusicEnd?.();
      } catch {}
    },
    onWinDone: () => runtime.nextLevel(),
    onDeathDone: () => runtime.loadLevel(runtime.levelIndex),
  });

  await runtime.init();

  function updateHud(dt: number) {
    hud.setCounts({
      goslings: runtime.gooselings.length | 0,
      keysCur: runtime.keysCollected | 0,
      keysTotal: runtime.keysTotal | 0,
    });
    hud.update(dt);
  }

  function isEntityOnFinish(world: TiledWorld, p: Player) {
    return aabbOverlapsTileLocalIndex(world, entityCollider(p), FINISH_LOCAL_INDEX, ["tile"]);
  }

  function allEntitiesOnFinish(world: TiledWorld) {
    const babies = runtime.gooselings;
    if (!babies.length) return false;

    if (!isEntityOnFinish(world, runtime.player)) return false;
    for (const b of babies) if (!isEntityOnFinish(world, b)) return false;
    return true;
  }

  function anyEntityOnSpikes(world: TiledWorld, allEntities: Player[]) {
  const spikeIdx = SPIKE_LOCAL_INDEXES;

  // Make goslings a bit more forgiving than the player.
  // (Bigger inset + slightly lifted feet check.)
  const PAD_PLAYER = 2;
  const PAD_BABY = 4;
  const LIFT_PLAYER = 0;
  const LIFT_BABY = 1;

  for (const e of allEntities) {
    const isBaby = e !== runtime.player;

    const pad = isBaby ? PAD_BABY : PAD_PLAYER;
    const lift = isBaby ? LIFT_BABY : LIFT_PLAYER;

    // IMPORTANT: hazards use FEET collider, not center collider
    const collider = hazardCollider(e);

    // shrink + lift so babies need a more "committed" overlap to die
    const reduced = {
      x: collider.x + pad,
      y: collider.y + pad - lift,
      w: Math.max(1, collider.w - pad * 2),
      h: Math.max(1, collider.h - pad * 2),
    };

    for (let i = 0; i < spikeIdx.length; i++) {
      if (aabbOverlapsTileLocalIndex(world, reduced, spikeIdx[i], ["tile", "collide"])) return true;
    }
  }

  return false;
}

  function update(dt: number, keys: Keys) {
    const player = runtime.player;

    // unlock audio on any gameplay input
    if (keys.a || keys.b || keys.start || keys.select || keys.left || keys.right || keys.up || keys.down) {
      sfx.userGesture();
    }

    if (dt > 0) t += Math.min(dt, 0.05);

    ui.update(dt);

    // X-to-next-goose
    camFocus.handleInput(keys);

    // Loading: keep HUD/UI stable
    const world = runtime.world;
    if (runtime.loading || !world) {
      updateHud(dt);
      return;
    }

    // sequence holds (death/win)
    const seqMode = sequences.update(dt);
    if (seqMode !== "normal") {
      if (runtime.key) runtime.key.update(dt);
      updateHud(dt);
      camFocus.update(dt);
      return;
    }

    // normal update path
    if (runtime.key) runtime.key.update(dt);
    if (collisionSfxCooldown > 0) collisionSfxCooldown = Math.max(0, collisionSfxCooldown - dt);

    const gooselings = runtime.gooselings;
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
    player.update(dt, keys, runtime.isSolidTile, worldInfo);
    const masterJump = pvy0 >= 0 && player.vy < 0;

    if (masterJump) play("jump", { volume: 0.55, minGapMs: 40 });

    for (const b of gooselings) b.puppetStep(dt, intentX, player.vx, masterJump, runtime.isSolidTile, worldInfo);

    const collided = resolveEntityCollisions(allEntities, ww, wh, runtime.isSolidTile, tw, th);
    if (collided && collisionSfxCooldown === 0) {
      play("bump", { volume: 0.18, detune: -180, minGapMs: 70 });
      collisionSfxCooldown = 0.12;
    }

    // spikes death
    if (anyEntityOnSpikes(world, allEntities)) {
      sequences.beginDeath();
      camFocus.update(dt);
      return;
    }

    // --- UI triggers from Tiled object layer "ui"
    // NOW: goslings can trigger dialogs too (any entity overlap keeps the message up)
    {
      let msg = "";
      const triggers = world.map.ui;

      // Check triggers in map order; first match wins (stable + predictable).
      for (let i = 0; i < triggers.length && !msg; i++) {
        const tr = triggers[i];

        // Check any entity (player or gosling)
        for (let j = 0; j < allEntities.length; j++) {
          const a = entityCollider(allEntities[j]);
          if (aabbOverlapsPoly(a, tr.pts, tr.aabb)) {
            msg = tr.msg;
            break;
          }
        }
      }

      if (msg) ui.set(msg);
      else ui.clear();
    }

    updateHud(dt);

    // key pickup
    const k = runtime.key;
    if (k) {
      const kA = keyCollider(k);
      let picked = false;

      for (let i = 0; i < allEntities.length; i++) {
        if (aabbOverlaps(kA, entityCollider(allEntities[i]))) {
          picked = true;
          break;
        }
      }

      if (picked && runtime.consumeKey()) {
        runtime.incKeysCollected();

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
    if (allEntitiesOnFinish(world)) {
      sequences.beginWin();
      camFocus.update(dt);
      return;
    }

    camFocus.update(dt);
  }

  function drawHud(offCtx: CanvasRenderingContext2D) {
    hud.draw(offCtx, vw, vh, invert);
    offCtx.fillStyle = invert ? "#000" : "#fff";
    offCtx.font = "10px monospace";
  }

  function draw(offCtx: CanvasRenderingContext2D, vw: number, vh: number) {
    offCtx.fillStyle = "#000";
    offCtx.fillRect(0, 0, vw, vh);

    const world = runtime.world;
    if (world) drawWorldMap(offCtx, world, cam, vw, vh);

    if (world) {
      drawWaterfalls(offCtx, world, cam, vw, vh, t, {
        layerName: "waterfall",
        localIndex: 2,
        speed: 12,
        foamSpeed: 6,
      });

      void drawTilePatterns;
    }

    if (runtime.key) runtime.key.draw(offCtx, cam);

    const bob = sequences.mode === "win" ? (((Math.sin(sequences.winT * 10) * 2) | 0) as number) : 0;

    if (bob) {
      offCtx.save();
      offCtx.translate(0, bob);
      for (const b of runtime.gooselings) b.draw(offCtx, cam);
      runtime.player.draw(offCtx, cam);
      offCtx.restore();
    } else {
      for (const b of runtime.gooselings) b.draw(offCtx, cam);
      runtime.player.draw(offCtx, cam);
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

    loadLevel: (i: number) => runtime.loadLevel(i),
    nextLevel: () => runtime.nextLevel(),
    getLevelIndex() {
      return runtime.levelIndex | 0;
    },
    getLevelCount() {
      return runtime.levelCount | 0;
    },

    update,
    draw,
  };
}
