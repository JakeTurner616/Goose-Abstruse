// src/game/drawMap.ts
import type { TiledWorld } from "../tiled";
import { drawTile, GID_MASK } from "../tiled";
import { clamp } from "./math";
import type { Cam } from "./types";

export function drawWorldMap(offCtx: CanvasRenderingContext2D, world: TiledWorld, cam: Cam, vw: number, vh: number) {
  const { map, ts } = world;
  const tw = map.tw;
  const th = map.th;

  // draw from integer camera to keep tiles 1-bit crisp
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
