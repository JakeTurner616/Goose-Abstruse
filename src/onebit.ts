// src/onebit.ts
type Cam = { x: number; y: number };
type MountainBG = { sampleScreen(x: number, y: number): boolean };

const BAYER_4x4 = new Uint8Array([
  0, 8, 2, 10,
  12, 4, 14, 6,
  3, 11, 1, 9,
  15, 7, 13, 5,
]);

export function createOneBitBlitter(opts: {
  w: number;
  h: number;
  ctx: CanvasRenderingContext2D;     // final onscreen
  offCtx: CanvasRenderingContext2D;  // source buffer
  mountainBG: MountainBG;
  getCam: () => Cam;
  getInvert: () => boolean;
  bwThreshold?: number;
  bwDither?: number;

  // SKY KEY
  skyR?: number;
  skyG?: number;
  skyB?: number;
  skyTol?: number;
}) {
  const W = opts.w | 0;
  const H = opts.h | 0;

  const BW_THRESHOLD = opts.bwThreshold ?? 140;
  const BW_DITHER = opts.bwDither ?? 24;

  const SKY_R = opts.skyR ?? 255;
  const SKY_G = opts.skyG ?? 204;
  const SKY_B = opts.skyB ?? 170;
  const SKY_TOL = opts.skyTol ?? 2;

  function isSkyKey(r: number, g: number, b: number) {
    return (
      (r - SKY_R <= SKY_TOL && SKY_R - r <= SKY_TOL) &&
      (g - SKY_G <= SKY_TOL && SKY_G - g <= SKY_TOL) &&
      (b - SKY_B <= SKY_TOL && SKY_B - b <= SKY_TOL)
    );
  }

  return function blit1bit() {
    const img = opts.offCtx.getImageData(0, 0, W, H);
    const d = img.data;

    const cam = opts.getCam();
    const cx = cam.x | 0;
    const cy = cam.y | 0;

    const invert = !!opts.getInvert();
    const BLACK = invert ? 255 : 0;
    const WHITE = invert ? 0 : 255;

    for (let y = 0; y < H; y++) {
      const wy = (y + cy) & 3;

      for (let x = 0; x < W; x++) {
        const i = ((y * W + x) << 2);
        const r = d[i], g = d[i + 1], b = d[i + 2];

        if (isSkyKey(r, g, b)) {
          const vbg = opts.mountainBG.sampleScreen(x, y) ? WHITE : BLACK;
          d[i] = vbg; d[i + 1] = vbg; d[i + 2] = vbg; d[i + 3] = 255;
          continue;
        }

        const l = (77 * r + 150 * g + 29 * b) >> 8;
        const wx4 = (x + cx) & 3;
        const m = BAYER_4x4[wx4 | (wy << 2)];
        const t = BW_THRESHOLD + ((m - 7.5) * (BW_DITHER / 8));

        const v = l >= t ? WHITE : BLACK;
        d[i] = v; d[i + 1] = v; d[i + 2] = v; d[i + 3] = 255;
      }
    }

    opts.ctx.putImageData(img, 0, 0);
  };
}
