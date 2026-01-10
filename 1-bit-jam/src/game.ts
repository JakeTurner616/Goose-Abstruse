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

const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);

type Cam = { x: number; y: number };

type SpawnKind = "goose" | "gooseling" | "key";
type SpawnPoint = { kind: SpawnKind; x: number; y: number };

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

  update(dt: number, keys: Keys): void;
  draw(offCtx: CanvasRenderingContext2D, vw: number, vh: number): void;
};

export type CreateGameOpts = {
  sound?: SoundSystem; // injected shared sound system (from main)
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
  let oys = oy - SLOP;

  const MIN_PUSH = 0.25;
  if (oxs < MIN_PUSH) oxs = MIN_PUSH;
  if (oys < MIN_PUSH) oys = MIN_PUSH;

  const acx = A.x + A.w * 0.5;
  const bcx = B.x + B.w * 0.5;
  const acy = A.y + A.h * 0.5;
  const bcy = B.y + B.h * 0.5;

  let dx = acx - bcx;
  let dy = acy - bcy;

  const EPS = 1e-6;
  if (Math.abs(dx) < EPS && Math.abs(dy) < EPS) {
    const h = pairHash(i, j);
    dx = h & 1 ? 1 : -1;
    dy = h & 2 ? 1 : -1;
  }

  const AXIS_EPS = 0.01;
  const chooseX =
    oxs + AXIS_EPS < oys ? true : oys + AXIS_EPS < oxs ? false : Math.abs(dx) >= Math.abs(dy);

  const { wa, wb } = separationWeights(a, b);

  if (chooseX) {
    const dir = dx < 0 ? -1 : 1;
    const push = oxs;

    if (wa) a.x = clamp(a.x + dir * push * wa, 0, worldW - a.w);
    if (wb) b.x = clamp(b.x - dir * push * wb, 0, worldW - b.w);

    if (wa) a.vx *= 0.6;
    if (wb) b.vx *= 0.6;
  } else {
    const dir = dy < 0 ? -1 : 1;
    const push = oys;

    if (wa) a.y = clamp(a.y + dir * push * wa, 0, worldH - a.h);
    if (wb) b.y = clamp(b.y - dir * push * wb, 0, worldH - b.h);

    if (wa) a.vy *= 0.6;
    if (wb) b.vy *= 0.6;
  }

  return true;
}

function resolveEntityCollisions(entities: Player[], worldW: number, worldH: number) {
  const ITERS = 4;
  let anyEver = false;

  for (let it = 0; it < ITERS; it++) {
    let any = false;
    for (let i = 0; i < entities.length; i++) {
      for (let j = i + 1; j < entities.length; j++) {
        if (separatePair(entities[i], entities[j], i, j, worldW, worldH)) any = true;
      }
    }
    if (any) anyEver = true;
    if (!any) break;
  }

  return anyEver;
}

function snapToPixel(p: Player) {
  p.x = (p.x + 0.5) | 0;
  p.y = (p.y + 0.5) | 0;
}

const DOOR_LOCAL_INDEXES = [64, 65, 79, 80];

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

export async function createGame(vw: number, vh: number, opts?: CreateGameOpts): Promise<Game> {
  const cam: Cam = { x: 0, y: 0 };
  let invert = false;

  const mountainBG = createMountainBG(vw, vh);

  // ---- sound: USE injected shared sound system (from main) if provided
  const sfx: SoundSystem = opts?.sound ?? createSoundSystem({ volume: 0.15 });
  let bank: SoundBank | null = null;

  // If any individual file fails, soundBank implementations vary:
  // - some reject everything
  // - some resolve but omit missing sounds
  // So: we treat bank as “best effort” and still fallback per-sound.
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
    else sfx.playPreset("click", opts2);
  }

  function play(name: string, opts2?: { volume?: number; detune?: number; minGapMs?: number }) {
    if (!bank) {
      fallbackPlay(name, opts2);
      return;
    }

    // Bank exists, but the sound may still be missing depending on loadSoundBank behavior.
    // If bank.play throws, we fallback.
    try {
      bank.play(name, opts2);
    } catch {
      fallbackPlay(name, opts2);
    }
  }

  let world: TiledWorld | null = null;
  let player: Player;
  const gooselings: Player[] = [];

  let keyAtlas: KeyAtlas | null = null;
  let key: KeyEntity | null = null;

  const doorFx = createDoorDissolve();

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

  const [p, w, ka] = await Promise.all([
    createPlayer({ x: 24, y: 24 }),
    loadTiled("/Tiled/sample-map.tmx"),
    loadKeyAtlas("/Key/").catch(() => null),
  ]);

  player = p;
  world = w;
  keyAtlas = ka;

  let startX = 24;
  let startY = 0;

  if (world) {
    const sp = scanSpawnPoints(world);

    const goose = sp.find((s) => s.kind === "goose");
    if (goose) {
      startX = goose.x;
      startY = goose.y;
    }

    player.x = startX;
    player.y = startY;

    await spawnGooselings(sp);

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
  } else {
    player.x = startX;
    player.y = startY;
  }

  updateCamera();

  function update(dt: number, keys: Keys) {
    if (!player || !world) return;

    // unlock audio on any gameplay input
    if (keys.a || keys.b || keys.start || keys.select || keys.left || keys.right || keys.up || keys.down) {
      sfx.userGesture();
    }

    if (dt > 0) t += Math.min(dt, 0.05);
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

    if (masterJump) {
      // This should now play /Sounds/jump.json once bank loads.
      play("jump", { volume: 0.55, minGapMs: 40 });
    }

    for (const b of gooselings) {
      b.puppetStep(dt, intentX, player.vx, masterJump, isSolidTile, worldInfo);
    }

    const collided = resolveEntityCollisions(allEntities, ww, wh);
    if (collided && collisionSfxCooldown === 0) {
      play("bump", { volume: 0.18, detune: -180, minGapMs: 70 });
      collisionSfxCooldown = 0.12;
    }

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
    offCtx.fillStyle = invert ? "#000" : "#fff";
    offCtx.font = "10px monospace";
    const g = player?.grounded ? "G" : " ";
    const inv = invert ? "INV" : "   ";
    const cnt = gooselings.length | 0;
    const k = key ? "KEY" : "   ";
    const pr = doorFx.progress();
    const d = pr.active ? `D${pr.removed}/${pr.total}` : " ";
    offCtx.fillText(world ? `MAP OK ${g} ${inv} ${k} ${d} BABIES:${cnt}` : "LOADING...", 4, 12);
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

    for (const b of gooselings) b.draw(offCtx, cam);
    player.draw(offCtx, cam);

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
    update,
    draw,
  };
}
