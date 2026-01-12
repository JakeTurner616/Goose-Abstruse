// src/spriteBake.ts
// 1-bit baking guarantees:
// - alpha is ONLY 0 or 255 (ANY alpha > 0 becomes opaque)
// - no blended draws while baking ("copy" compositing)
// - no smoothing during raster steps
// Prevents “ghosting/opacity” artifacts, especially when downscaling.

import { assetUrl } from "./assetUrl";

export type AnimName = "idle" | "walk" | "flap";

type BakedFrame = HTMLCanvasElement;
type BBox = { x0: number; y0: number; x1: number; y1: number };

export type BakedSet = {
  idle: BakedFrame[];
  walk: BakedFrame[];
  flap: BakedFrame[];
  w: number;
  h: number;
};

const ALPHA_CUT = 1; // ANY nonzero alpha is solid (critical for downscale)
const EMPTY: BBox = { x0: 0, y0: 0, x1: 0, y1: 0 };

const reset2D = (ctx: CanvasRenderingContext2D) => {
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = "source-over";
  ctx.imageSmoothingEnabled = false;
};

const loadImage = (src: string) =>
  new Promise<HTMLImageElement>((res, rej) => {
    const img = new Image();
    img.decoding = "async";
    img.onload = () => res(img);
    img.onerror = rej;

    // IMPORTANT: never allow absolute-root paths on itch.
    // assetUrl() also strips leading slashes if any callers pass them.
    img.src = assetUrl(src);

    // If you ever load cross-origin images in the future, you can uncomment this:
    // img.crossOrigin = "anonymous";
  });

const unionBox = (a: BBox, b: BBox): BBox => {
  if (a.x1 <= a.x0) return { ...b };
  if (b.x1 <= b.x0) return { ...a };
  return {
    x0: Math.min(a.x0, b.x0),
    y0: Math.min(a.y0, b.y0),
    x1: Math.max(a.x1, b.x1),
    y1: Math.max(a.y1, b.y1),
  };
};

const expandBox = (b: BBox, pad: number, w: number, h: number): BBox => {
  if (b.x1 <= b.x0) return { x0: 0, y0: 0, x1: w, y1: h };
  return {
    x0: Math.max(0, b.x0 - pad),
    y0: Math.max(0, b.y0 - pad),
    x1: Math.min(w, b.x1 + pad),
    y1: Math.min(h, b.y1 + pad),
  };
};

function frameBBox(
  img: HTMLImageElement,
  i: number,
  fw: number,
  fh: number,
  alphaCut = ALPHA_CUT
): BBox {
  const c = document.createElement("canvas");
  c.width = fw;
  c.height = fh;

  const ctx = c.getContext("2d", { alpha: true })!;
  reset2D(ctx);

  ctx.globalCompositeOperation = "copy";
  ctx.drawImage(img, i * fw, 0, fw, fh, 0, 0, fw, fh);
  ctx.globalCompositeOperation = "source-over";

  const d = ctx.getImageData(0, 0, fw, fh).data;

  let x0 = fw,
    y0 = fh,
    x1 = 0,
    y1 = 0,
    any = false;

  for (let y = 0, p = 0; y < fh; y++) {
    for (let x = 0; x < fw; x++, p += 4) {
      if (d[p + 3] >= alphaCut) {
        any = true;
        if (x < x0) x0 = x;
        if (y < y0) y0 = y;
        if (x + 1 > x1) x1 = x + 1;
        if (y + 1 > y1) y1 = y + 1;
      }
    }
  }

  return any ? { x0, y0, x1, y1 } : { ...EMPTY };
}

function bakeStrip(opts: {
  img: HTMLImageElement;
  n: number;
  fw: number;
  fh: number;
  crop: BBox;
  outW: number;
  outH: number;
  bw?: number;
}): BakedFrame[] {
  const { img, n, fw, crop, outW, outH, bw = 128 } = opts;
  const cw = Math.max(1, crop.x1 - crop.x0);
  const ch = Math.max(1, crop.y1 - crop.y0);

  const frames: BakedFrame[] = [];

  for (let i = 0; i < n; i++) {
    const c = document.createElement("canvas");
    c.width = outW;
    c.height = outH;

    const ctx = c.getContext("2d", { alpha: true })!;
    reset2D(ctx);
    ctx.clearRect(0, 0, outW, outH);

    // overwrite, do NOT blend
    ctx.globalCompositeOperation = "copy";
    ctx.drawImage(img, i * fw + crop.x0, crop.y0, cw, ch, 0, 0, outW, outH);
    ctx.globalCompositeOperation = "source-over";

    // hard 1-bit RGBA
    const id = ctx.getImageData(0, 0, outW, outH);
    const d = id.data;

    for (let p = 0; p < d.length; p += 4) {
      const a = d[p + 3];
      if (a < ALPHA_CUT) {
        d[p] = d[p + 1] = d[p + 2] = 0;
        d[p + 3] = 0;
        continue;
      }

      const l = (77 * d[p] + 150 * d[p + 1] + 29 * d[p + 2]) >> 8;
      const v = l >= bw ? 255 : 0;
      d[p] = d[p + 1] = d[p + 2] = v;
      d[p + 3] = 255;
    }

    ctx.putImageData(id, 0, 0);
    frames.push(c);
  }

  return frames;
}

// --- image load (once) + bake cache (per output size)

let imgsP: Promise<Record<AnimName, HTMLImageElement>> | null = null;
const baked = new Map<string, Promise<BakedSet>>();

async function loadImgs() {
  return (
    imgsP ??
    (imgsP = (async () => ({
      // NOTE: pass paths WITHOUT leading slash; assetUrl() also tolerates it.
      idle: await loadImage("Sprites/Idle.png"),
      walk: await loadImage("Sprites/Walk.png"),
      flap: await loadImage("Sprites/Flap.png"),
    }))())
  );
}

export function getBakedForSize(outW: number, outH: number): Promise<BakedSet> {
  const key = `${outW}x${outH}`;
  const hit = baked.get(key);
  if (hit) return hit;

  const prom = (async () => {
    const imgs = await loadImgs();

    const FW = 64,
      FH = 64;
    const N: Record<AnimName, number> = { idle: 2, walk: 4, flap: 2 };
    const PAD = 2;

    // shared crop across all anims (raw alpha presence, not BW)
    let crop = { ...EMPTY };
    (["idle", "walk", "flap"] as AnimName[]).forEach((name) => {
      const img = imgs[name];
      for (let i = 0; i < N[name]; i++) crop = unionBox(crop, frameBBox(img, i, FW, FH, ALPHA_CUT));
    });
    crop = expandBox(crop, PAD, FW, FH);

    const idle = bakeStrip({ img: imgs.idle, n: N.idle, fw: FW, fh: FH, crop, outW, outH });
    const walk = bakeStrip({ img: imgs.walk, n: N.walk, fw: FW, fh: FH, crop, outW, outH });
    const flap = bakeStrip({ img: imgs.flap, n: N.flap, fw: FW, fh: FH, crop, outW, outH });

    return { idle, walk, flap, w: outW, h: outH };
  })();

  baked.set(key, prom);
  return prom;
}
