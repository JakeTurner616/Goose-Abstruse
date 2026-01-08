// src/spriteBake.ts
// 1-bit baking that guarantees:
// - NO partial alpha in baked frames (alpha is ONLY 0 or 255)
// - NO blended draws while baking (first draw uses "copy")
// - NO smoothing during any raster step
// This prevents “ghosting/opacity” artifacts during movement + 1-bit blit.
//
// Key fix for gooselings:
// When downscaling, edge pixels often have small nonzero alpha.
// If you threshold alpha at 128, you punch holes in the sprite silhouette,
// which reads like opacity/ghosting while moving.
// So: ANY alpha > 0 becomes fully opaque.

type BakedFrame = HTMLCanvasElement;

type BBox = { x0: number; y0: number; x1: number; y1: number };
const EMPTY_BOX: BBox = { x0: 0, y0: 0, x1: 0, y1: 0 };

// Treat ANY nonzero alpha as solid.
// This is crucial when scaling down (gooselings) to avoid “porous” edges.
const ALPHA_CUT = 1;

// Small helper to hard-reset a 2D context (prevents inherited state)
function reset2D(ctx: CanvasRenderingContext2D) {
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = "source-over";
  ctx.imageSmoothingEnabled = false;
}

function loadImage(src: string) {
  return new Promise<HTMLImageElement>((resolve, reject) => {
    const img = new Image();
    img.decoding = "async";
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = src;
  });
}

function unionBox(a: BBox, b: BBox): BBox {
  if (a.x1 <= a.x0) return { ...b };
  if (b.x1 <= b.x0) return { ...a };
  return {
    x0: Math.min(a.x0, b.x0),
    y0: Math.min(a.y0, b.y0),
    x1: Math.max(a.x1, b.x1),
    y1: Math.max(a.y1, b.y1),
  };
}

function expandBox(b: BBox, pad: number, w: number, h: number): BBox {
  if (b.x1 <= b.x0) return { x0: 0, y0: 0, x1: w, y1: h };
  return {
    x0: Math.max(0, b.x0 - pad),
    y0: Math.max(0, b.y0 - pad),
    x1: Math.min(w, b.x1 + pad),
    y1: Math.min(h, b.y1 + pad),
  };
}

function computeFrameBBox(
  img: HTMLImageElement,
  frameIndex: number,
  srcFrameW: number,
  srcFrameH: number,
  alphaCutoff = 1
): BBox {
  const tmp = document.createElement("canvas");
  tmp.width = srcFrameW;
  tmp.height = srcFrameH;

  const tctx = tmp.getContext("2d", { alpha: true })!;
  reset2D(tctx);
  tctx.clearRect(0, 0, srcFrameW, srcFrameH);

  // copy avoids any blend with whatever is “under” (paranoia + correctness)
  tctx.globalCompositeOperation = "copy";
  tctx.drawImage(
    img,
    frameIndex * srcFrameW,
    0,
    srcFrameW,
    srcFrameH,
    0,
    0,
    srcFrameW,
    srcFrameH
  );
  tctx.globalCompositeOperation = "source-over";

  const id = tctx.getImageData(0, 0, srcFrameW, srcFrameH);
  const d = id.data;

  let x0 = srcFrameW, y0 = srcFrameH, x1 = 0, y1 = 0;
  let any = false;

  for (let y = 0; y < srcFrameH; y++) {
    let row = (y * srcFrameW) << 2;
    for (let x = 0; x < srcFrameW; x++) {
      if (d[row + 3] >= alphaCutoff) {
        any = true;
        if (x < x0) x0 = x;
        if (y < y0) y0 = y;
        if (x + 1 > x1) x1 = x + 1;
        if (y + 1 > y1) y1 = y + 1;
      }
      row += 4;
    }
  }

  return any ? { x0, y0, x1, y1 } : { ...EMPTY_BOX };
}

function bakeStripFramesAutoCrop(opts: {
  img: HTMLImageElement;
  frameCount: number;
  srcFrameW: number;
  srcFrameH: number;
  crop: BBox;
  outW: number;
  outH: number;
  bwThreshold?: number;
}): BakedFrame[] {
  const {
    img,
    frameCount,
    srcFrameW,
    srcFrameH,
    crop,
    outW,
    outH,
    bwThreshold = 128,
  } = opts;

  const cw = Math.max(1, crop.x1 - crop.x0);
  const ch = Math.max(1, crop.y1 - crop.y0);

  const frames: BakedFrame[] = [];

  for (let i = 0; i < frameCount; i++) {
    const c = document.createElement("canvas");
    c.width = outW;
    c.height = outH;

    const cctx = c.getContext("2d", { alpha: true })!;
    reset2D(cctx);

    // Absolute wipe
    cctx.clearRect(0, 0, outW, outH);

    // Compute source rect for this frame
    const sx = i * srcFrameW + crop.x0;
    const sy = crop.y0;

    // Important: overwrite, do NOT blend (prevents any lingering alpha)
    cctx.globalCompositeOperation = "copy";
    cctx.drawImage(img, sx, sy, cw, ch, 0, 0, outW, outH);
    cctx.globalCompositeOperation = "source-over";

    // Convert to hard 1-bit RGBA:
    // - alpha is ONLY 0 or 255
    // - rgb is ONLY 0 or 255
    const id = cctx.getImageData(0, 0, outW, outH);
    const d = id.data;

    for (let p = 0; p < d.length; p += 4) {
      const a = d[p + 3];

      // Key fix: only fully transparent if alpha is truly zero
      if (a < ALPHA_CUT) {
        d[p] = 0;
        d[p + 1] = 0;
        d[p + 2] = 0;
        d[p + 3] = 0;
        continue;
      }

      // Fully opaque BW (no “in-between”)
      const r = d[p];
      const g = d[p + 1];
      const b = d[p + 2];
      const l = (77 * r + 150 * g + 29 * b) >> 8;
      const v = l >= bwThreshold ? 255 : 0;

      d[p] = v;
      d[p + 1] = v;
      d[p + 2] = v;
      d[p + 3] = 255;
    }

    cctx.putImageData(id, 0, 0);
    frames.push(c);
  }

  return frames;
}

export type AnimName = "idle" | "walk" | "flap";
export type BakedSet = {
  idle: BakedFrame[];
  walk: BakedFrame[];
  flap: BakedFrame[];
  w: number;
  h: number;
};

// images loaded once; baked frames cached per output size
let spriteImgsPromise:
  | Promise<{ idle: HTMLImageElement; walk: HTMLImageElement; flap: HTMLImageElement }>
  | null = null;

const bakedBySize = new Map<string, Promise<BakedSet>>();

async function loadSpriteImgs() {
  if (!spriteImgsPromise) {
    spriteImgsPromise = (async () => {
      const idle = await loadImage("/Sprites/Idle.png");
      const walk = await loadImage("/Sprites/Walk.png");
      const flap = await loadImage("/Sprites/Flap.png");
      return { idle, walk, flap };
    })();
  }
  return spriteImgsPromise;
}

export async function getBakedForSize(outW: number, outH: number): Promise<BakedSet> {
  const key = `${outW}x${outH}`;
  const hit = bakedBySize.get(key);
  if (hit) return hit;

  const prom = (async () => {
    const { idle: idleImg, walk: walkImg, flap: flapImg } = await loadSpriteImgs();

    const SRC_FRAME_W = 64;
    const SRC_FRAME_H = 64;

    const IDLE_N = 2;
    const WALK_N = 4;
    const FLAP_N = 2;

    // NOTE: keep this small; big pad reintroduces edge pixels you probably don’t want
    const PAD = 2;

    // Crop box computed on raw alpha presence (not BW)
    let cropAll: BBox = { ...EMPTY_BOX };
    for (let i = 0; i < IDLE_N; i++)
      cropAll = unionBox(cropAll, computeFrameBBox(idleImg, i, SRC_FRAME_W, SRC_FRAME_H, 1));
    for (let i = 0; i < WALK_N; i++)
      cropAll = unionBox(cropAll, computeFrameBBox(walkImg, i, SRC_FRAME_W, SRC_FRAME_H, 1));
    for (let i = 0; i < FLAP_N; i++)
      cropAll = unionBox(cropAll, computeFrameBBox(flapImg, i, SRC_FRAME_W, SRC_FRAME_H, 1));

    cropAll = expandBox(cropAll, PAD, SRC_FRAME_W, SRC_FRAME_H);

    const idle = bakeStripFramesAutoCrop({
      img: idleImg,
      frameCount: IDLE_N,
      srcFrameW: SRC_FRAME_W,
      srcFrameH: SRC_FRAME_H,
      crop: cropAll,
      outW,
      outH,
      bwThreshold: 128,
    });

    const walk = bakeStripFramesAutoCrop({
      img: walkImg,
      frameCount: WALK_N,
      srcFrameW: SRC_FRAME_W,
      srcFrameH: SRC_FRAME_H,
      crop: cropAll,
      outW,
      outH,
      bwThreshold: 128,
    });

    const flap = bakeStripFramesAutoCrop({
      img: flapImg,
      frameCount: FLAP_N,
      srcFrameW: SRC_FRAME_W,
      srcFrameH: SRC_FRAME_H,
      crop: cropAll,
      outW,
      outH,
      bwThreshold: 128,
    });

    return { idle, walk, flap, w: outW, h: outH };
  })();

  bakedBySize.set(key, prom);
  return prom;
}
