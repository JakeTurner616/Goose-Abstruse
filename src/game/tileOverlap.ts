// src/game/tileOverlap.ts
import { type TiledWorld, GID_MASK } from "../tiled";

export function aabbOverlapsTileLocalIndex(
  w: TiledWorld,
  aabb: { x: number; y: number; w: number; h: number },
  localIndex: number,
  layers: string[] = ["tile", "collide"]
) {
  return aabbOverlapsAnyTileLocalIndex(w, aabb, [localIndex], layers);
}

export function aabbOverlapsAnyTileLocalIndex(
  w: TiledWorld,
  aabb: { x: number; y: number; w: number; h: number },
  localIndexes: number[],
  layers: string[] = ["tile", "collide"]
) {
  const { map, ts } = w;
  const tw = map.tw | 0;
  const th = map.th | 0;

  const x0 = (aabb.x / tw) | 0;
  const y0 = (aabb.y / th) | 0;
  const x1 = ((aabb.x + aabb.w - 1) / tw) | 0;
  const y1 = ((aabb.y + aabb.h - 1) / th) | 0;

  const first = ts.firstgid >>> 0;

  // tiny fast set: local indexes are small ints
  // (avoid Set alloc in hot path)
  const L0 = localIndexes[0] | 0;
  const L1 = (localIndexes.length > 1 ? localIndexes[1] : -1) | 0;
  const L2 = (localIndexes.length > 2 ? localIndexes[2] : -1) | 0;

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

        if (li === L0 || li === L1 || li === L2) return true;
      }
    }
  }

  return false;
}
