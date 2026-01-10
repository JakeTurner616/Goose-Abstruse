// src/uiHud.ts
// Pixel-perfect 1-bit HUD: gosling icon + count, key icon + count.
// FIX: numbers were flickering because canvas text is antialiased/hinted -> unstable after 1-bit quantize.
// Solution: draw counts with a tiny 1-bit bitmap font (fillRect only). No measureText, no fillText.

export type UiHudCounts = { goslings: number; keys: number };

export type UiHudSystem = {
  setCounts(next: Partial<UiHudCounts>): void;
  update(dt: number): void;
  draw(ctx: CanvasRenderingContext2D, vw: number, vh: number, invert: boolean): void;
};

type State = UiHudCounts & { t: number };

type Opts = {
  x?: number;
  y?: number;
  px?: number; // icon pixel scale (1 is best for 1-bit)
  textPx?: number; // bitmap-font scale
};

const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);


const ICON_GOSLING_8: Uint8Array = new Uint8Array([
  0b01100000,
  0b11100011,
  0b00111111,
  0b00111111,
  0b00111110,
  0b00001000,
  0b00001000,
  0b00011000,
]);

const ICON_KEY_8: Uint8Array = new Uint8Array([
  0b00011000,
  0b00111100,
  0b01100110,
  0b01100110,
  0b00111100,
  0b00011000,
  0b00011010,
  0b00011100,
]);

function drawIcon8(ctx: CanvasRenderingContext2D, x: number, y: number, rows: Uint8Array, px: number) {
  for (let ry = 0; ry < 8; ry++) {
    const row = rows[ry] | 0;
    for (let rx = 0; rx < 8; rx++) {
      if (row & (0x80 >> rx)) ctx.fillRect(x + rx * px, y + ry * px, px, px);
    }
  }
}

function formatCount(n: number) {
  n = n | 0;
  if (n < 0) n = 0;
  if (n > 999) return "999+";
  return String(n);
}

/**
 * Tiny 1-bit font: 3x5 digits + '+'
 * Each glyph is 5 rows, 3 bits wide, MSB -> left pixel.
 * (Example row: 0b101 means pixel on, off, on)
 */
const FONT3X5: Record<string, Uint8Array> = {
  "0": new Uint8Array([0b111, 0b101, 0b101, 0b101, 0b111]),
  "1": new Uint8Array([0b010, 0b110, 0b010, 0b010, 0b111]),
  "2": new Uint8Array([0b111, 0b001, 0b111, 0b100, 0b111]),
  "3": new Uint8Array([0b111, 0b001, 0b111, 0b001, 0b111]),
  "4": new Uint8Array([0b101, 0b101, 0b111, 0b001, 0b001]),
  "5": new Uint8Array([0b111, 0b100, 0b111, 0b001, 0b111]),
  "6": new Uint8Array([0b111, 0b100, 0b111, 0b101, 0b111]),
  "7": new Uint8Array([0b111, 0b001, 0b001, 0b001, 0b001]),
  "8": new Uint8Array([0b111, 0b101, 0b111, 0b101, 0b111]),
  "9": new Uint8Array([0b111, 0b101, 0b111, 0b001, 0b111]),
  "+": new Uint8Array([0b000, 0b010, 0b111, 0b010, 0b000]),
};

function drawText3x5(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  text: string,
  px: number,
  gap: number
) {
  // All integer math to keep 1-bit stable
  x |= 0;
  y |= 0;
  px |= 0;
  gap |= 0;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    const g = FONT3X5[ch];
    if (g) {
      for (let ry = 0; ry < 5; ry++) {
        const row = g[ry] | 0;
        // bits: 0b100 0b010 0b001
        if (row & 0b100) ctx.fillRect(x + 0 * px, y + ry * px, px, px);
        if (row & 0b010) ctx.fillRect(x + 1 * px, y + ry * px, px, px);
        if (row & 0b001) ctx.fillRect(x + 2 * px, y + ry * px, px, px);
      }
    }
    x += (3 * px + gap) | 0;
  }
}

function text3x5Width(text: string, px: number, gap: number) {
  const n = text.length | 0;
  if (!n) return 0;
  return (n * (3 * px) + (n - 1) * gap) | 0;
}

function drawChamferBorder(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, fg: string, bg: string) {
  // Outer border via filled rings (no stroke).
  ctx.fillStyle = fg;
  ctx.fillRect(x, y, w, 1);
  ctx.fillRect(x, y + h - 1, w, 1);
  ctx.fillRect(x, y, 1, h);
  ctx.fillRect(x + w - 1, y, 1, h);

  // Chamfer corners (make them “bg”)
  ctx.fillStyle = bg;
  ctx.fillRect(x, y, 1, 1);
  ctx.fillRect(x + w - 1, y, 1, 1);
  ctx.fillRect(x, y + h - 1, 1, 1);
  ctx.fillRect(x + w - 1, y + h - 1, 1, 1);
}

export function createUiHudSystem(opts: Opts = {}): UiHudSystem {
  const s: State = { goslings: 0, keys: 0, t: 0 };

  const baseX = (opts.x ?? 4) | 0;
  const baseY = (opts.y ?? 4) | 0;
  const px = clamp((opts.px ?? 1) | 0, 1, 3);
  const textPx = clamp((opts.textPx ?? 1) | 0, 1, 3);

  function setCounts(next: Partial<UiHudCounts>) {
    if (next.goslings != null) s.goslings = next.goslings | 0;
    if (next.keys != null) s.keys = next.keys | 0;
  }

  function update(dt: number) {
    s.t += dt;
  }

  function draw(ctx: CanvasRenderingContext2D, vw: number, _vh: number, invert: boolean) {
    const fg = invert ? "#000" : "#fff";
    const bg = invert ? "#fff" : "#000";

    ctx.save();

    // Layout
    const padX = 4;
    const gap = 6;

    const iconBox = 10; // square box for icon
    const iconInset = 1;
    const iconDraw = 8 * px;
    const iconXOff = ((iconBox - iconDraw) >> 1) | 0;

    const labelG = formatCount(s.goslings);
    const labelK = formatCount(s.keys);

    // bitmap font metrics
    const glyphGap = 1 * textPx; // small spacing between digits
    const textW_G = text3x5Width(labelG, textPx, glyphGap);
    const textW_K = text3x5Width(labelK, textPx, glyphGap);
    const textH = (5 * textPx) | 0;

    const cellG = (iconBox + 3 + textW_G) | 0;
    const cellK = (iconBox + 3 + textW_K) | 0;

    let panelW = (padX + cellG + gap + cellK + padX) | 0;
    panelW = Math.min(panelW, (vw - 2) | 0);

    const panelH = 16;
    const x = clamp(baseX, 1, Math.max(1, vw - panelW - 1));
    const y = baseY | 0;

    // Panel fill (solid)
    ctx.fillStyle = bg;
    ctx.fillRect(x, y, panelW, panelH);

    // Borders
    drawChamferBorder(ctx, x, y, panelW, panelH, fg, bg);
    drawChamferBorder(ctx, x + 2, y + 2, panelW - 4, panelH - 4, fg, bg);

    // Contents
    const cy = (y + (panelH >> 1)) | 0;
    const boxY = (y + ((panelH - iconBox) >> 1)) | 0;
    const iconY = (boxY + iconInset) | 0;

    // Align bitmap text vertically centered (integer)
    const textY = (cy - (textH >> 1)) | 0;

    let cx = (x + padX) | 0;

    // Gosling icon box
    ctx.fillStyle = fg;
    ctx.fillRect(cx, boxY, iconBox, 1);
    ctx.fillRect(cx, boxY + iconBox - 1, iconBox, 1);
    ctx.fillRect(cx, boxY, 1, iconBox);
    ctx.fillRect(cx + iconBox - 1, boxY, 1, iconBox);

    drawIcon8(ctx, (cx + iconXOff) | 0, iconY, ICON_GOSLING_8, px);

    // Gosling number (bitmap)
    drawText3x5(ctx, (cx + iconBox + 3) | 0, textY, labelG, textPx, glyphGap);

    cx = (cx + cellG + gap) | 0;

    // Key icon box
    ctx.fillStyle = fg;
    ctx.fillRect(cx, boxY, iconBox, 1);
    ctx.fillRect(cx, boxY + iconBox - 1, iconBox, 1);
    ctx.fillRect(cx, boxY, 1, iconBox);
    ctx.fillRect(cx + iconBox - 1, boxY, 1, iconBox);

    drawIcon8(ctx, (cx + iconXOff) | 0, iconY, ICON_KEY_8, px);

    // Key number (bitmap)
    drawText3x5(ctx, (cx + iconBox + 3) | 0, textY, labelK, textPx, glyphGap);

    ctx.restore();
  }

  return { setCounts, update, draw };
}
