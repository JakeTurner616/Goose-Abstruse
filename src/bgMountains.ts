// src/bgMountains.ts
// Background mountain generator (world-locked, 1-bit-friendly)
// Exposes:
//   - render(camX, camY): updates internal buffer
//   - sampleScreen(x, y): returns 0|255 for the current screen pixel (x,y)

export type MountainBG = {
  render: (camX: number, camY: number) => void;
  sampleScreen: (x: number, y: number) => 0 | 255;
};

export function createMountainBG(screenW: number, screenH: number): MountainBG {
  // ----------------------------------------------------------------------------
  // Background buffer (padded so sky always fills)
  // ----------------------------------------------------------------------------
  const BG_PAD = 40;
  const BG_W = screenW + BG_PAD * 2;
  const BG_H = screenH + BG_PAD * 2;

  const bgCanvas = document.createElement("canvas");
  bgCanvas.width = BG_W;
  bgCanvas.height = BG_H;
  const bgCtx = bgCanvas.getContext("2d", { alpha: false })!;
  bgCtx.imageSmoothingEnabled = false;

  const bgImg = bgCtx.createImageData(BG_W, BG_H);
  const bgData = bgImg.data;

  // tiny deterministic hash -> 0..255
  function h8(x: number, y: number, s: number) {
    let n = (x * 374761393 + y * 668265263 + s * 1442695041) | 0;
    n ^= n >>> 13;
    n = (n * 1274126177) | 0;
    return (n >>> 24) & 255;
  }
  const iabs = (n: number) => (n < 0 ? -n : n);

  const parX = (camX: number, sx: number, div: number) =>
    ((sx - BG_PAD) + ((camX / div) | 0)) | 0;

  // ----------------------------------------------------------------------------
  // 3-pattern palette
  //   0 SOLID  : white
  //   1 STIPPLE: chunky dots (mid tone)
  //   2 HATCH  : diagonal hatch (mid/dark tone)
  // ----------------------------------------------------------------------------
  type PatternMode = 0 | 1 | 2;

  function cutForPattern(x: number, y: number, mode: PatternMode) {
    if (mode === 0) return false;

    if (mode === 1) {
      const a = (((x >> 1) ^ (y >> 1)) & 1) === 1;
      const b = (((x + y) & 7) === 0);
      return a && !b;
    }

    const d = (x + y) & 7;
    const br = ((x - y) & 15) === 0;
    return d === 0 || d === 1 || br;
  }

  // ----------------------------------------------------------------------------
  // Ridge helpers
  // ----------------------------------------------------------------------------
  function ridgeSoftMax(wx: number, seed: number, horizon: number, spacingPow2: number) {
    const cell = 1 << spacingPow2;
    const baseCell = (wx >> spacingPow2) | 0;

    let best = -1e9;
    let second = -1e9;

    for (let k = -2; k <= 2; k++) {
      const c = baseCell + k;

      const jitter = (h8(c, 0, seed) & (cell - 1)) | 0;
      const cx = (c * cell + jitter) | 0;

      const ph = 14 + ((h8(c, 1, seed) * 34) >> 8); // 14..47
      const slope = 1 + ((h8(c, 2, seed) * 6) >> 8); // 1..7

      const d = wx - cx;

      const tri = ph - (iabs(d) * slope);

      const toothH = (h8(c, 3, seed) * 10) >> 8; // 0..9
      const toothS = 2 + ((h8(c, 4, seed) * 4) >> 8); // 2..5
      const toothX = ((h8(c, 5, seed) & 31) - 16) | 0;
      const teeth = toothH - (iabs(d + toothX) * toothS);

      const val = tri + (teeth >> 1);

      if (val > best) {
        second = best;
        best = val;
      } else if (val > second) {
        second = val;
      }
    }

    const blended = ((best * 3 + second) >> 2);
    const j = ((h8(wx >> 2, 7, seed) & 3) - 1) | 0;

    return (horizon - blended + j) | 0;
  }

  function blur1D(r: Int16Array, passes: number) {
    const n = r.length;
    const tmp = new Int16Array(n);

    for (let p = 0; p < passes; p++) {
      tmp[0] = r[0];
      tmp[n - 1] = r[n - 1];
      for (let i = 1; i < n - 1; i++) {
        tmp[i] = ((r[i - 1] + (r[i] << 1) + r[i + 1]) >> 2) as any;
      }
      r.set(tmp);
    }
  }

  function plot(x: number, y: number, v: 0 | 255) {
    if ((x | y) < 0 || x >= BG_W || y >= BG_H) return;
    const i = ((y * BG_W + x) << 2);
    bgData[i] = v;
    bgData[i + 1] = v;
    bgData[i + 2] = v;
    bgData[i + 3] = 255;
  }

  function drawRidgeLines(seed: number, camX: number, camY: number, opts: {
    parDiv: number;
    horizon: number;
    spacingPow2: number;
    blurPasses: number;
    bands: number;
    bandStep: number;
    lineMode: PatternMode;
  }) {
    const { parDiv, horizon, spacingPow2, blurPasses, bands, bandStep, lineMode } = opts;

    const wyOff = (((camY / (parDiv + 3)) | 0) >> 1) | 0;
    const ridge = new Int16Array(BG_W);

    for (let sx = 0; sx < BG_W; sx++) {
      const wx = parX(camX, sx, parDiv);
      let ry = ridgeSoftMax(wx, seed, horizon + BG_PAD + wyOff, spacingPow2);
      if (ry < 0) ry = 0;
      if (ry >= BG_H) ry = BG_H - 1;
      ridge[sx] = ry;
    }

    blur1D(ridge, blurPasses);

    for (let b = 0; b < bands; b++) {
      const offY = b * bandStep;
      for (let sx = 0; sx < BG_W; sx++) {
        const y = ridge[sx] + offY;
        if (y >= BG_H) continue;

        const hole = cutForPattern(sx, y, lineMode);
        if (!hole) {
          plot(sx, y, 255);
          if ((b & 1) === 0) plot(sx, y + 1, 255);
        }
      }
    }
  }

  function drawMountainsFill(seed: number, camX: number, camY: number, opts: {
    parDiv: number;
    horizon: number;
    spacingPow2: number;
    blurPasses: number;
    bright: PatternMode;
    mid: PatternMode;
    deep: PatternMode;
    crestBand: number;
    midBand: number;
    minY?: number;
  }) {
    const {
      parDiv,
      horizon,
      spacingPow2,
      blurPasses,
      bright,
      mid,
      deep,
      crestBand,
      midBand,
      minY,
    } = opts;

    const wyOff = (((camY / (parDiv + 2)) | 0) >> 1) | 0;

    const ridge = new Int16Array(BG_W);
    const sub = new Int16Array(BG_W);

    for (let sx = 0; sx < BG_W; sx++) {
      const wx = parX(camX, sx, parDiv);

      let ry = ridgeSoftMax(wx, seed, horizon + BG_PAD + wyOff, spacingPow2);
      if (ry < 0) ry = 0;
      if (ry >= BG_H) ry = BG_H - 1;
      if (minY !== undefined && ry < minY) ry = minY;

      const wob = ((h8(wx >> 3, 19, seed) & 7) - 3) | 0;
      let sy = (ry + 16 + wob + ((h8(wx >> 4, 29, seed) & 7) | 0)) | 0;

      if (sy < 0) sy = 0;
      if (sy >= BG_H) sy = BG_H - 1;
      if (minY !== undefined && sy < minY + 10) sy = minY + 10;

      ridge[sx] = ry;
      sub[sx] = sy;
    }

    blur1D(ridge, blurPasses);
    blur1D(sub, Math.max(1, blurPasses - 1));

    for (let sx = 0; sx < BG_W; sx++) {
      const ry = ridge[sx];
      const sy = sub[sx];

      const rL = sx > 0 ? ridge[sx - 1] : ry;
      const rR = sx + 1 < BG_W ? ridge[sx + 1] : ry;
      const slope = rR - rL;

      const flip = slope > 0;

      for (let y = ry; y < BG_H; y++) {
        let mode: PatternMode;

        if (y < ry + crestBand) {
          mode = bright;
        } else if (y < ry + midBand) {
          mode = flip ? deep : mid;
        } else if (y < sy) {
          mode = flip ? mid : deep;
        } else {
          mode = deep;
        }

        if (!cutForPattern(sx, y, mode)) plot(sx, y, 255);
      }
    }
  }

  function render(camX: number, camY: number) {
    // clear to black
    for (let i = 0; i < bgData.length; i += 4) {
      bgData[i] = 0;
      bgData[i + 1] = 0;
      bgData[i + 2] = 0;
      bgData[i + 3] = 255;
    }

    // Keep your exact current configuration
    drawRidgeLines(11, camX, camY, {
      parDiv: 9,
      horizon: 54,
      spacingPow2: 4,
      blurPasses: 2,
      bands: 3,
      bandStep: 6,
      lineMode: 2,
    });

    drawMountainsFill(23, camX, camY, {
      parDiv: 7,
      horizon: 70,
      spacingPow2: 5,
      blurPasses: 4,
      bright: 0,
      mid: 2,
      deep: 1,
      crestBand: 10,
      midBand: 22,
    });

    drawMountainsFill(53, camX, camY, {
      parDiv: 3,
      horizon: 104,
      spacingPow2: 4,
      blurPasses: 8,
      bright: 0,
      mid: 1,
      deep: 1,
      crestBand: 14,
      midBand: 30,
    });

    bgCtx.putImageData(bgImg, 0, 0);
  }

  function sampleScreen(x: number, y: number): 0 | 255 {
    // screen pixel -> bg pixel (we always render with pad centered on screen)
    const bi = (((y + BG_PAD) * BG_W + (x + BG_PAD)) << 2);
    return (bgData[bi] ? 255 : 0) as 0 | 255;
  }

  return { render, sampleScreen };
}
