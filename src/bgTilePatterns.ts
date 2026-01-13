// src/bgTilePatterns.ts
import type { TiledWorld } from "./tiled";
import { GID_MASK } from "./tiled";

export type Cam = { x: number; y: number };

export type PatternOpts = {
  // which base layer to read tiles from (default "tile")
  layerName?: string;

  // which tileset local index to target (1-based; index 1 => firstgid)
  localIndex?: number; // default 3

  // emoji / unicode glyph to repeat
  glyph?: string; // default "✦"

  // size (in pixels) of the repeating pattern cell (must be >= 8; default 16)
  cell?: number;

  // font size (px) used to draw the glyph into the cell (default cell-2)
  fontPx?: number;

  // pixel-stepped drift amount (px/sec), world-locked + optional gentle motion
  driftX?: number; // default 0
  driftY?: number; // default 0
};

const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);

// Support either map.<name> convenience or map.layers["name"]
function getLayer(map: any, name: string): Uint32Array | null {
  const a = map?.[name];
  if (a && a.length) return a as Uint32Array;
  const b = map?.layers?.[name];
  if (b && b.length) return b as Uint32Array;
  return null;
}

// Make a crisp 1-bit-ish glyph stamp by thresholding the drawn emoji.
// This prevents “soft” edges from becoming mushy patterns after 1-bit blit.
function makeEmojiPattern(ctxForPattern: CanvasRenderingContext2D, glyph: string, cell: number, fontPx: number) {
  const c = document.createElement("canvas");
  c.width = cell;
  c.height = cell;

  const g = c.getContext("2d", { alpha: true })!;
  g.imageSmoothingEnabled = false;

  // Draw on transparent
  g.clearRect(0, 0, cell, cell);

  // Center glyph in the cell
  g.fillStyle = "#fff";
  g.textAlign = "center";
  g.textBaseline = "middle";
  g.font = `${fontPx}px "Apple Color Emoji","Segoe UI Emoji","Noto Color Emoji",sans-serif`;

  // small nudge tends to look better for many emoji fonts
  g.fillText(glyph, (cell >> 1) + 0.5, (cell >> 1) + 0.5);

  // Threshold to 0/255 alpha to keep it chunky and stable.
  const id = g.getImageData(0, 0, cell, cell);
  const d = id.data;

  // you can tighten/loosen this to taste
  const A_CUT = 48;
  const L_CUT = 120;

  for (let i = 0; i < d.length; i += 4) {
    const a = d[i + 3] | 0;
    if (a < A_CUT) {
      d[i + 3] = 0;
      continue;
    }
    // luma threshold
    const r = d[i] | 0;
    const g2 = d[i + 1] | 0;
    const b = d[i + 2] | 0;
    const l = (77 * r + 150 * g2 + 29 * b) >> 8;
    const on = l >= L_CUT;
    d[i] = 255;
    d[i + 1] = 255;
    d[i + 2] = 255;
    d[i + 3] = on ? 255 : 0;
  }

  g.putImageData(id, 0, 0);

  // Create repeating pattern
  const pat = ctxForPattern.createPattern(c, "repeat");
  return pat;
}

// cache patterns by key so we don’t recreate each frame
const patternCache = new Map<string, CanvasPattern | null>();

function getCachedPattern(
  ctx: CanvasRenderingContext2D,
  glyph: string,
  cell: number,
  fontPx: number
) {
  const key = `${glyph}|${cell}|${fontPx}`;
  const hit = patternCache.get(key);
  if (hit !== undefined) return hit;
  const pat = makeEmojiPattern(ctx, glyph, cell, fontPx);
  patternCache.set(key, pat);
  return pat;
}

export function drawTilePatterns(
  ctx: CanvasRenderingContext2D,
  world: TiledWorld,
  cam: Cam,
  vw: number,
  vh: number,
  t: number,
  opts: PatternOpts = {}
) {
  const layerName = opts.layerName ?? "tile";
  const localIndex = opts.localIndex ?? 3;

  const glyph = opts.glyph ?? "✦";
  const cell = Math.max(8, (opts.cell ?? 16) | 0);
  const fontPx = Math.max(6, (opts.fontPx ?? (cell - 2)) | 0);

  const driftX = (opts.driftX ?? 0);
  const driftY = (opts.driftY ?? 0);

  const { map, ts } = world;
  const tw = map.tw, th = map.th;

  const layer = getLayer(map as any, layerName);
  if (!layer) return;

  // localIndex is 1-based relative to tileset
  const targetGid = ((ts.firstgid + (localIndex - 1)) >>> 0);

  // Visible tile bounds
  const x0 = clamp((cam.x / tw) | 0, 0, map.w);
  const y0 = clamp((cam.y / th) | 0, 0, map.h);
  const x1 = clamp(((cam.x + vw + tw - 1) / tw) | 0, 0, map.w);
  const y1 = clamp(((cam.y + vh + th - 1) / th) | 0, 0, map.h);

  const ox = cam.x - x0 * tw;
  const oy = cam.y - y0 * th;

  const pat = getCachedPattern(ctx, glyph, cell, fontPx);
  if (!pat) return;

  // Pixel-stepped pattern drift (optional)
  const px = ((t * driftX) | 0);
  const py = ((t * driftY) | 0);

  // World-lock the pattern to the map so it doesn't “swim” in screen space:
  // - translate pattern origin by -(cam) plus optional drift
  // - plus a tiny stable offset so pattern seams don’t align too perfectly
  const worldPhaseX = ((-cam.x + px + 3) | 0);
  const worldPhaseY = ((-cam.y + py + 5) | 0);

  ctx.save();
  ctx.fillStyle = pat;

  // Shift pattern origin (CanvasPattern inherits the current transform)
  ctx.translate(worldPhaseX, worldPhaseY);

  for (let ty = y0; ty < y1; ty++) {
    const row = ty * map.w;
    const dy = (((ty - y0) * th - oy) | 0);

    for (let tx = x0; tx < x1; tx++) {
      const gidRaw = layer[row + tx] >>> 0;
      const gid = (gidRaw & GID_MASK) >>> 0;
      if (!gid || gid !== targetGid) continue;

      const dx = (((tx - x0) * tw - ox) | 0);

      // clip to tile region (mask)
      ctx.save();
      ctx.beginPath();
      ctx.rect(dx - worldPhaseX, dy - worldPhaseY, tw, th);
      ctx.clip();

      // fill with repeating emoji pattern
      ctx.fillRect(dx - worldPhaseX, dy - worldPhaseY, tw, th);
      ctx.restore();
    }
  }

  ctx.restore();
}
