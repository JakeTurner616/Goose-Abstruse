// src/bgWaterfall.ts
import type { TiledWorld } from "./tiled";
import { GID_MASK } from "./tiled";

export type Cam = { x: number; y: number };

type WaterfallOpts = {
  layerName?: string;  // default "waterfall"
  localIndex?: number; // default 2 (1-based in Tiled tileset view; local index here is 1..)
  speed?: number;      // px/sec (default 10)  // vertical streak speed (pixel-stepped)
  foamSpeed?: number;  // px/sec (default 6)   // foam lateral drift (pixel-stepped)
};

const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);

// Support either map.waterfall convenience or map.layers["waterfall"]
function getLayer(map: any, name: string): Uint32Array | null {
  const a = map?.[name];
  if (a && a.length) return a as Uint32Array;
  const b = map?.layers?.[name];
  if (b && b.length) return b as Uint32Array;
  return null;
}

// "solid" = any nonzero gid in collide layer
function isSolidCollide(map: any, tx: number, ty: number) {
  const C = map?.collide as Uint32Array | undefined;
  if (!C) return false;
  if (tx < 0 || ty < 0 || tx >= map.w || ty >= map.h) return true;
  return ((C[ty * map.w + tx] >>> 0) & GID_MASK) !== 0;
}

// small deterministic "noise" (stable per tile + column)
function h8(x: number, y: number, s: number) {
  let n = (x * 374761393 + y * 668265263 + s * 1442695041) | 0;
  n ^= n >>> 13;
  n = (n * 1274126177) | 0;
  return (n >>> 24) & 255;
}

function drawWaterfallTile(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  tw: number,
  th: number,
  t: number,
  speed: number,
  foamSpeed: number,
  drawFoam: boolean,
  tileSeedX: number,
  tileSeedY: number
) {
  // Pixel-stepped motion (no fractional blending)
  const pix = (t * speed) | 0;
  const base = (pix % (th + 8)) | 0;

  // Foam drift is also pixel-stepped
  const fpix = (t * foamSpeed) | 0;

  ctx.save();
  ctx.beginPath();
  ctx.rect(x, y, tw, th);
  ctx.clip();

  ctx.fillStyle = "#fff";

  // Stable streak columns (no random gating -> no "flashing")
  const step = 2;
  for (let lx = 0; lx < tw; lx += step) {
    // per-column phase (stable)
    const ph = ((lx * 7 + (lx << 2)) & 7) | 0;
    const y0 = ((base + ph) % (th + 8)) | 0;

    ctx.fillRect(x + lx, y + ((y0 - 6) | 0), 1, 4);
    ctx.fillRect(x + lx, y + ((y0 + 2) | 0), 1, 3);

    // add a faint secondary strand between columns (still stable)
    if (tw >= 8 && (lx & 3) === 0) {
      const y1 = ((base + ph + 3) % (th + 8)) | 0;
      ctx.fillRect(x + lx + 1, y + ((y1 - 3) | 0), 1, 2);
    }
  }

  // Foam ONLY where waterfall meets collide tile below.
  // Make it feel more "waterfall-like" by:
  // - lateral drift (pixel-stepped)
  // - a 2-row froth band with a moving notch pattern
  // - a few rising "spray" dots that move with the drift
  if (drawFoam) {
    const foamRow = (y + th - 1) | 0;
    const foamRow2 = (y + th - 2) | 0;

    // drift phase (wrap small)
    const phase = fpix & 7;

    // base froth: 2 rows, pattern shifts sideways
    for (let lx = 0; lx < tw; lx++) {
      // choose which pixels exist based on a moving pattern + a stable per-tile offset
      const n = (h8(tileSeedX, tileSeedY, 91) & 3) | 0;
      const k = (lx + phase + n) & 3;

      // bottom row: denser
      if (k !== 1) ctx.fillRect(x + lx, foamRow, 1, 1);

      // row above: sparser + offset
      if (((lx + (phase >> 1) + n) & 7) === 0) ctx.fillRect(x + lx, foamRow2, 1, 1);
    }

    // spray dots: rise 0..2 px above foam, drift sideways with phase
    // (deterministic per tile + time step; "moves" but doesn't random-flash)
    const burst = (fpix >> 2) & 3; // slow cycling 0..3
    for (let i = 0; i < 3; i++) {
      const sx = ((h8(tileSeedX, tileSeedY, 33 + i) % tw) | 0);
      const dx = (sx + phase + (i << 1)) % tw;

      // height cycles (0..2) with slight per-dot phase
      const ph = (h8(tileSeedX, tileSeedY, 44 + i) & 3) | 0;
      const up = ((burst + ph) % 3) | 0;

      // only draw if it won't go out of tile bounds
      const yy = foamRow - 1 - up;
      if (yy >= y) ctx.fillRect(x + dx, yy, 1, 1);
    }
  }

  ctx.restore();
}

export function drawWaterfalls(
  ctx: CanvasRenderingContext2D,
  world: TiledWorld,
  cam: Cam,
  vw: number,
  vh: number,
  t: number,
  opts: WaterfallOpts = {}
) {
  const layerName = opts.layerName ?? "waterfall";
  const localIndex = opts.localIndex ?? 2;
  const speed = opts.speed ?? 10;
  const foamSpeed = opts.foamSpeed ?? 6;

  const { map, ts } = world;
  const tw = map.tw,
    th = map.th;

  const waterfallLayer = getLayer(map as any, layerName);
  if (!waterfallLayer) return;

  // localIndex is 1-based relative to tileset (index 1 => firstgid)
  const targetGid = ((ts.firstgid + (localIndex - 1)) >>> 0);

  const x0 = clamp((cam.x / tw) | 0, 0, map.w);
  const y0 = clamp((cam.y / th) | 0, 0, map.h);
  const x1 = clamp(((cam.x + vw + tw - 1) / tw) | 0, 0, map.w);
  const y1 = clamp(((cam.y + vh + th - 1) / th) | 0, 0, map.h);

  const ox = cam.x - x0 * tw;
  const oy = cam.y - y0 * th;

  for (let ty = y0; ty < y1; ty++) {
    const row = ty * map.w;
    const dy = (((ty - y0) * th - oy) | 0);

    for (let tx = x0; tx < x1; tx++) {
      const gidRaw = waterfallLayer[row + tx] >>> 0;
      const gid = (gidRaw & GID_MASK) >>> 0;
      if (!gid || gid !== targetGid) continue;

      // foam only if the tile directly BELOW is solid in collide layer
      const foam = isSolidCollide(map as any, tx, ty + 1);

      const dx = (((tx - x0) * tw - ox) | 0);
      drawWaterfallTile(ctx, dx, dy, tw, th, t, speed, foamSpeed, foam, tx, ty);
    }
  }
}