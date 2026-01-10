// src/uiHud.ts
// Tiny retro HUD: gosling thumbnail + count, key thumbnail + count.
// Pure 1-bit drawing (no asset dependencies). Drop-in module.

export type UiHudCounts = {
  goslings: number; // total / remaining / whatever you want to show
  keys: number;
};

export type UiHudSystem = {
  setCounts(next: Partial<UiHudCounts>): void;
  update(dt: number): void;
  draw(ctx: CanvasRenderingContext2D, vw: number, vh: number, invert: boolean): void;
};

type State = UiHudCounts & { t: number };

type Opts = {
  x?: number;
  y?: number;
  // overall scale for the icon pixels (keep at 1 for crisp)
  px?: number;
};

const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);

function roundRectPath(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  const rr = Math.max(0, Math.min(r, (w / 2) | 0, (h / 2) | 0));
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

// 8x8 icon bitmasks (bit7 is leftmost pixel)
const ICON_GOSLING_8: Uint8Array = new Uint8Array([
  0b00111100,
  0b01111110,
  0b11111111,
  0b11101111, // cheek highlight-ish
  0b11111111,
  0b01111110,
  0b00111100,
  0b00011000, // tiny body nub
]);

const ICON_KEY_8: Uint8Array = new Uint8Array([
  0b00011000,
  0b00111100,
  0b01100110,
  0b01100110,
  0b00111100, // bow
  0b00011000, // shaft
  0b00011010, // tooth
  0b00011100, // tooth
]);

function drawIcon8(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  maskRows: Uint8Array,
  px: number
) {
  for (let ry = 0; ry < 8; ry++) {
    const row = maskRows[ry] | 0;
    for (let rx = 0; rx < 8; rx++) {
      if (row & (0x80 >> rx)) {
        ctx.fillRect(x + rx * px, y + ry * px, px, px);
      }
    }
  }
}

function formatCount(n: number) {
  n = n | 0;
  if (n < 0) n = 0;
  if (n > 999) return "999+";
  return String(n);
}

export function createUiHudSystem(opts: Opts = {}): UiHudSystem {
  const s: State = { goslings: 0, keys: 0, t: 0 };

  const baseX = (opts.x ?? 4) | 0;
  const baseY = (opts.y ?? 4) | 0;
  const px = clamp((opts.px ?? 1) | 0, 1, 3);

  function setCounts(next: Partial<UiHudCounts>) {
    if (next.goslings != null) s.goslings = next.goslings | 0;
    if (next.keys != null) s.keys = next.keys | 0;
  }

  function update(dt: number) {
    s.t += dt;
  }

  function draw(ctx: CanvasRenderingContext2D, vw: number, _vh: number, invert: boolean) {
    // palette
    const fg = invert ? "#000" : "#fff";
    const bg = invert ? "#fff" : "#000";

    ctx.save();

    // layout constants (tuned for 160px wide)
    ctx.font = "10px monospace";
    ctx.textBaseline = "middle";

    const pad = 4;
    const gap = 6;
    const iconBox = 10; // outer icon box size
    const iconInset = 1; // inside icon box
    const iconDraw = 8 * px; // icon pixels
    const iconXOff = ((iconBox - iconDraw) * 0.5 + 0.5) | 0;

    const labelG = formatCount(s.goslings);
    const labelK = formatCount(s.keys);

    const wG = (ctx.measureText(labelG).width + 0.5) | 0;
    const wK = (ctx.measureText(labelK).width + 0.5) | 0;

    // cell widths: [iconBox + 3 + text]
    const cellG = (iconBox + 3 + wG) | 0;
    const cellK = (iconBox + 3 + wK) | 0;

    // total panel width, clamp so it never spills
    let panelW = (pad + cellG + gap + cellK + pad) | 0;
    panelW = Math.min(panelW, vw - 2);

    const panelH = 16;
    const x = clamp(baseX, 1, Math.max(1, vw - panelW - 1));
    const y = baseY;

    // subtle shimmer/bob (1px max, very gentle)
    const bob = ((Math.sin(s.t * 1.6) * 0.45) + 0.5) | 0;

    // panel background
    ctx.fillStyle = bg;
    roundRectPath(ctx, x, y + bob, panelW, panelH, 3);
    ctx.fill();

    // borders
    ctx.strokeStyle = fg;
    ctx.lineWidth = 1;
    roundRectPath(ctx, x + 0.5, y + bob + 0.5, panelW - 1, panelH - 1, 3);
    ctx.stroke();
    roundRectPath(ctx, x + 2.5, y + bob + 2.5, panelW - 5, panelH - 5, 2);
    ctx.stroke();

    // content
    ctx.fillStyle = fg;

    let cx = x + pad;
    const cy = (y + bob + (panelH >> 1)) | 0;

    // --- Gosling cell
    // icon box
    ctx.strokeRect(cx + 0.5, (y + bob + ((panelH - iconBox) >> 1)) + 0.5, iconBox - 1, iconBox - 1);

    const iconY = (y + bob + ((panelH - iconBox) >> 1) + iconInset) | 0;
    const iconX = (cx + iconXOff) | 0;

    drawIcon8(ctx, iconX, iconY, ICON_GOSLING_8, px);

    // count
    ctx.fillText(labelG, (cx + iconBox + 3) | 0, cy);

    // --- Key cell
    cx += cellG + gap;

    ctx.strokeRect(cx + 0.5, (y + bob + ((panelH - iconBox) >> 1)) + 0.5, iconBox - 1, iconBox - 1);

    drawIcon8(ctx, (cx + iconXOff) | 0, iconY, ICON_KEY_8, px);

    ctx.fillText(labelK, (cx + iconBox + 3) | 0, cy);

    ctx.restore();
  }

  return { setCounts, update, draw };
}
