// src/game.ts
import { loadTiled, drawTile, type TiledWorld, GID_MASK } from "./tiled";
import { createMountainBG } from "./bgMountains";
import { createPlayer, createGooseEntity, type Player } from "./player";
import type { Keys } from "./input";

const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);

type Cam = { x: number; y: number };

type SpawnKind = "goose" | "gooseling";
type SpawnPoint = { kind: SpawnKind; x: number; y: number };

function spawnKindFromGid(gidMasked: number, firstgid: number): SpawnKind | null {
  if (gidMasked === 1) return "goose";
  if (gidMasked === 2) return "gooseling";

  if (gidMasked === (firstgid >>> 0)) return "goose";            // index 1
  if (gidMasked === ((firstgid + 1) >>> 0)) return "gooseling";  // index 2
  return null;
}

function scanSpawnPoints(w: TiledWorld): SpawnPoint[] {
  const out: SpawnPoint[] = [];
  const { map, ts } = w;
  const L = map.spawns;

  for (let i = 0; i < L.length; i++) {
    const gidRaw = L[i] >>> 0;
    const gid = (gidRaw & GID_MASK) >>> 0;
    if (!gid) continue;

    const kind = spawnKindFromGid(gid, ts.firstgid >>> 0);
    if (!kind) continue;

    const tx = (i % map.w) | 0;
    const ty = ((i / map.w) | 0);

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

  update(dt: number, keys: Keys): void;
  draw(offCtx: CanvasRenderingContext2D, vw: number, vh: number): void;
};

// --- replace separatePair + resolveEntityCollisions with this version

const COLLIDER_FRAC = 16 / 64;
const COLLIDER_MIN = 4;

type CAABB = { x: number; y: number; w: number; h: number };

function entityCollider(p: Player): CAABB {
  const cw = Math.max(COLLIDER_MIN, (p.w * COLLIDER_FRAC + 0.5) | 0);
  const ch = Math.max(COLLIDER_MIN, (p.h * COLLIDER_FRAC + 0.5) | 0);
  const cx = p.x + ((p.w - cw) * 0.5);
  const cy = p.y + ((p.h - ch) * 0.5);
  return { x: cx, y: cy, w: cw, h: ch };
}

// small stable hash for pair tie-breaks
function pairHash(i: number, j: number) {
  // order-independent
  const a = i < j ? i : j;
  const b = i < j ? j : i;
  let h = (a * 73856093) ^ (b * 19349663);
  h = (h ^ (h >>> 16)) >>> 0;
  return h;
}

function separatePair(
  a: Player,
  b: Player,
  i: number,
  j: number,
  worldW: number,
  worldH: number
) {
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

  // slop helps reduce shimmer, but we must still resolve perfect overlaps.
  const SLOP = 0.15;
  let oxs = ox - SLOP;
  let oys = oy - SLOP;

  // If we're *exactly* overlapping, oxs/oys can be tiny or equal; ensure we push.
  // (This prevents “stuck together forever” at same spawn.)
  const MIN_PUSH = 0.25;
  if (oxs < MIN_PUSH) oxs = MIN_PUSH;
  if (oys < MIN_PUSH) oys = MIN_PUSH;

  const acx = A.x + A.w * 0.5;
  const bcx = B.x + B.w * 0.5;
  const acy = A.y + A.h * 0.5;
  const bcy = B.y + B.h * 0.5;

  // primary separation normal from center delta
  let dx = acx - bcx;
  let dy = acy - bcy;

  // tie-break: if centers coincide (or almost), use deterministic per-pair direction
  const EPS = 1e-6;
  if (Math.abs(dx) < EPS && Math.abs(dy) < EPS) {
    const h = pairHash(i, j);
    dx = (h & 1) ? 1 : -1;
    dy = (h & 2) ? 1 : -1;
  }

  // choose axis:
  // - prefer smaller penetration
  // - if close/equal, use which delta component is larger
  const AXIS_EPS = 0.01;
  const chooseX =
    oxs + AXIS_EPS < oys ? true :
    oys + AXIS_EPS < oxs ? false :
    Math.abs(dx) >= Math.abs(dy); // tie-break when overlaps ~equal

  if (chooseX) {
    const dir = dx < 0 ? -1 : 1;
    const push = oxs * 0.5;

    a.x = clamp(a.x + dir * push, 0, worldW - a.w);
    b.x = clamp(b.x - dir * push, 0, worldW - b.w);

    a.vx *= 0.6;
    b.vx *= 0.6;
  } else {
    const dir = dy < 0 ? -1 : 1;
    const push = oys * 0.5;

    a.y = clamp(a.y + dir * push, 0, worldH - a.h);
    b.y = clamp(b.y - dir * push, 0, worldH - b.h);

    a.vy *= 0.6;
    b.vy *= 0.6;
  }

  return true;
}

function resolveEntityCollisions(entities: Player[], worldW: number, worldH: number) {
  // Iterating makes stacks converge; critical when many entities overlap.
  const ITERS = 4;

  for (let it = 0; it < ITERS; it++) {
    let any = false;

    for (let i = 0; i < entities.length; i++) {
      for (let j = i + 1; j < entities.length; j++) {
        if (separatePair(entities[i], entities[j], i, j, worldW, worldH)) {
          any = true;
        }
      }
    }

    if (!any) break;
  }
}


export async function createGame(vw: number, vh: number): Promise<Game> {
  const cam: Cam = { x: 0, y: 0 };
  let invert = false;

  const mountainBG = createMountainBG(vw, vh);

  let world: TiledWorld | null = null;
  let player: Player;
  const gooselings: Player[] = [];

  function isSolidTile(tx: number, ty: number) {
    if (!world) return false;
    const { map } = world;

    if (tx < 0 || ty < 0 || tx >= map.w || ty >= map.h) return true;
    const gidRaw = map.collide[ty * map.w + tx] >>> 0;
    return (gidRaw & GID_MASK) !== 0;
  }

  function updateCamera() {
    if (!player) return;

    const ww = world ? (world.map.w * world.map.tw) : vw;
    const wh = world ? (world.map.h * world.map.th) : vh;

    // camera integer-locked (stabilizes dither phase)
    cam.x = ((player.x + (player.w >> 1)) - (vw >> 1)) | 0;
    cam.y = ((player.y + (player.h >> 1)) - (vh >> 1)) | 0;

    cam.x = clamp(cam.x, 0, Math.max(0, ww - vw));
    cam.y = clamp(cam.y, 0, Math.max(0, wh - vh));
  }

  async function spawnGooselings(points: SpawnPoint[]) {
    gooselings.length = 0;

    const babies = points.filter(p => p.kind === "gooseling");
    if (!babies.length) return;

    const made = await Promise.all(
      babies.map(p =>
        createGooseEntity({
          x: p.x,
          y: p.y,
          scale: 0.65,
          controllable: false,
        })
      )
    );

    gooselings.push(...made);
  }

  // --- boot
  player = await createPlayer({ x: 24, y: 24 });
  world = await loadTiled("/Tiled/sample-map.tmx");

  let startX = 24;
  let startY = 0;

  if (world) {
    const sp = scanSpawnPoints(world);
    const goose = sp.find(s => s.kind === "goose");
    if (goose) {
      startX = goose.x;
      startY = goose.y;
    }
    player.x = startX;
    player.y = startY;
    await spawnGooselings(sp);
  } else {
    player.x = startX;
    player.y = startY;
  }

  updateCamera();

 function update(dt: number, keys: Keys) {
  if (!player) return;

  const allEntities: Player[] = [player, ...gooselings];

  // --- MASTER INTENT (use input, not displacement)
  const intentX = (keys.left ? -1 : 0) + (keys.right ? 1 : 0);
  const intentY = (keys.up ? -1 : 0) + (keys.down ? 1 : 0); // currently unused, but kept symmetric

  if (world) {
    const ww = world.map.w * world.map.tw;
    const wh = world.map.h * world.map.th;

    const worldInfo = {
      w: ww,
      h: wh,
      tw: world.map.tw,
      th: world.map.th,
      tilesW: world.map.w,
      tilesH: world.map.h,
    };

    // Capture jump event
    const pvy0 = player.vy;

    player.update(dt, keys, isSolidTile, worldInfo);

    // True jump start this frame: vy flipped to negative
    const masterJump = (pvy0 >= 0 && player.vy < 0);

    // IMPORTANT: puppets follow INTENT, not actual dx (dx jitters when pinned / separated)
    for (const b of gooselings) {
      b.puppetStep(dt, intentX, intentY, masterJump, isSolidTile, worldInfo);
    }

    resolveEntityCollisions(allEntities, ww, wh);
  } else {
    const worldInfo = {
      w: vw,
      h: vh,
      tw: 8,
      th: 8,
      tilesW: (vw / 8) | 0,
      tilesH: (vh / 8) | 0,
    };

    const pvy0 = player.vy;

    player.update(dt, keys, () => false, worldInfo);

    const masterJump = (pvy0 >= 0 && player.vy < 0);

    for (const b of gooselings) {
      b.puppetStep(dt, intentX, intentY, masterJump, () => false, worldInfo);
    }

    resolveEntityCollisions(allEntities, vw, vh);
  }

  updateCamera();
}

  function drawMap(offCtx: CanvasRenderingContext2D, vw: number, vh: number) {
    if (!world) return;
    const { map, ts } = world;

    const tw = map.tw, th = map.th;

    const x0 = clamp((cam.x / tw) | 0, 0, map.w);
    const y0 = clamp((cam.y / th) | 0, 0, map.h);
    const x1 = clamp(((cam.x + vw + tw - 1) / tw) | 0, 0, map.w);
    const y1 = clamp(((cam.y + vh + th - 1) / th) | 0, 0, map.h);

    const ox = cam.x - x0 * tw;
    const oy = cam.y - y0 * th;

    const tileLayer = map.tile;
    const collideLayer = map.collide;

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
    offCtx.fillText(world ? `MAP OK ${g} ${inv} BABIES:${cnt}` : "LOADING...", 4, 12);
  }

  function draw(offCtx: CanvasRenderingContext2D, vw: number, vh: number) {
    offCtx.fillStyle = "#000";
    offCtx.fillRect(0, 0, vw, vh);

    drawMap(offCtx, vw, vh);

    // NOTE: gooseEntity.draw already snaps dx/dy with |0 (correct)
    for (const b of gooselings) b.draw(offCtx, cam);
    player.draw(offCtx, cam);

    drawHud(offCtx);
  }

  return {
    cam,
    get invert() { return invert; },
    toggleInvert() { invert = !invert; },

    mountainBG,

    update,
    draw,
  };
}
