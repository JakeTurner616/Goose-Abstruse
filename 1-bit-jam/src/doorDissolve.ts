// src/doorDissolve.ts
import type { TiledWorld } from "./tiled";
import { GID_MASK } from "./tiled";

export type DoorDissolve = {
  active: boolean;
  total: number;
  removed: number;
  order: Uint32Array;
  rate: number; // tiles/sec
};

export type DoorDissolveOpts = {
  localIndexes: number[];
  layers?: string[];

  // Make this longer to slow it down (seconds).
  durationSec?: number;

  // Optional hard clamps (tiles/sec). If you set a long duration you usually don't need these.
  minRate?: number;
  maxRate?: number;

  seed?: number;

  cellPx?: number;
  orderedDither?: boolean;
};

const DEFAULT_LAYERS = ["tile", "collide"];

const BAYER_4x4 = new Uint8Array([
  0, 8, 2, 10,
  12, 4, 14, 6,
  3, 11, 1, 9,
  15, 7, 13, 5,
]);

function u32(x: number) {
  return x >>> 0;
}

function mix32(a: number, b: number) {
  let x = u32(a ^ (b * 0x9e3779b1));
  x ^= x >>> 16;
  x = u32(x * 0x85ebca6b);
  x ^= x >>> 13;
  x = u32(x * 0xc2b2ae35);
  x ^= x >>> 16;
  return x >>> 0;
}

function tileThreshold16(tx: number, ty: number, cellTiles: number, seed: number, ordered: boolean) {
  const cx = (tx / cellTiles) | 0;
  const cy = (ty / cellTiles) | 0;

  if (ordered) {
    const bx = cx & 3;
    const by = cy & 3;
    const t0 = BAYER_4x4[(by << 2) | bx]; // 0..15
    const phase = (mix32(seed, (cx * 1013) ^ (cy * 1619)) >>> 28) & 15;
    const t = (t0 + phase) & 15;
    return (t * 4369) & 0xffff; // 0..65535-ish
  }

  // hashed cell threshold
  const h = mix32(seed ^ (cx * 73856093), cy * 19349663);
  // 0..65535
  return (h ^ (h >>> 16)) & 0xffff;
}

export function createDoorDissolve() {
  const state: DoorDissolve = {
    active: false,
    total: 0,
    removed: 0,
    order: new Uint32Array(0),
    rate: 0,
  };

  function begin(world: TiledWorld, nowTime: number, opts: DoorDissolveOpts) {
    const { map, ts } = world;

    const layers = opts.layers ?? DEFAULT_LAYERS;

    // SLOWER DEFAULT: ~1.4s instead of 0.55s
    const durationSec = opts.durationSec ?? 1.4;

    // Also slow the minimum clamp so it can't "snap" too fast on small doors
    const minRate = opts.minRate ?? 6;

    // Cap max rate too so big doors still show the pattern
    const maxRate = opts.maxRate ?? 36;

    const cellPx = opts.cellPx ?? 4;
    const orderedDither = opts.orderedDither ?? true;

    const tilePx = map.tw | 0;
    const cellTiles = Math.max(1, ((cellPx / Math.max(1, tilePx)) + 0.999) | 0);

    const doorGids = opts.localIndexes.map((n) => u32(ts.firstgid + (n - 1)));
    const isDoor = (gidRaw: number) => {
      const g = u32(gidRaw & GID_MASK);
      for (let i = 0; i < doorGids.length; i++) if (g === doorGids[i]) return true;
      return false;
    };

    const seen = new Uint8Array(map.w * map.h);
    const tmp: number[] = [];

    for (let li = 0; li < layers.length; li++) {
      const L = (map as any)[layers[li]] as Uint32Array | undefined;
      if (!L) continue;
      for (let i = 0; i < L.length; i++) {
        if (!seen[i] && isDoor(L[i] >>> 0)) {
          seen[i] = 1;
          tmp.push(i);
        }
      }
    }

    if (!tmp.length) return false;

    const seed =
      (opts.seed ??
        u32((map.w * 1315423911) ^ (map.h * 2654435761) ^ u32(((nowTime * 1000) | 0) * 374761393))) >>> 0;

    tmp.sort((ia, ib) => {
      const ax = (ia % map.w) | 0, ay = ((ia / map.w) | 0);
      const bx = (ib % map.w) | 0, by = ((ib / map.w) | 0);
      const ta = tileThreshold16(ax, ay, cellTiles, seed, orderedDither);
      const tb = tileThreshold16(bx, by, cellTiles, seed, orderedDither);
      return ta - tb || (ia - ib);
    });

    const order = new Uint32Array(tmp.length);
    for (let i = 0; i < tmp.length; i++) order[i] = tmp[i] >>> 0;

    state.active = true;
    state.total = order.length;
    state.removed = 0;
    state.order = order;

    // rate from duration (tiles/sec), clamped
    const rawRate = order.length / Math.max(0.15, durationSec);
    state.rate = Math.max(minRate, Math.min(maxRate, rawRate));

    return true;
  }

  function step(world: TiledWorld, dt: number, opts?: { layers?: string[] }) {
    if (!state.active) return;

    const layers = opts?.layers ?? DEFAULT_LAYERS;
    const { map } = world;

    // accumulate fractional progress so slow rates still advance smoothly
    // (otherwise dt quantization makes it "burst" in chunks)
    // Store fractional remainder in rate itself? no — keep a tiny hidden accumulator:
    (state as any)._acc = ((state as any)._acc ?? 0) + state.rate * dt;
    let n = (state as any)._acc | 0;
    if (n < 1) return;
    (state as any)._acc -= n;

    const want = Math.min(state.total, state.removed + n);

    while (state.removed < want) {
      const idx = state.order[state.removed] | 0;
      for (let li = 0; li < layers.length; li++) {
        const L = (map as any)[layers[li]] as Uint32Array | undefined;
        if (L) L[idx] = 0;
      }
      state.removed++;
    }

    if (state.removed >= state.total) {
      state.active = false;
      (state as any)._acc = 0;
    }
  }

  function isActive() {
    return state.active;
  }

  function progress() {
    return { active: state.active, removed: state.removed, total: state.total };
  }

  return { state, begin, step, isActive, progress };
}
