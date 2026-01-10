// src/uiMessage.ts
export type UiMessageSystem = {
  set(text: string): void;
  clear(): void;
  update(dt: number): void; // kept for API stability (no-op)
  draw(ctx: CanvasRenderingContext2D, vw: number, vh: number, invert: boolean): void;
};

type State = {
  text: string;
  visible: boolean;
};

const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);

// 3x5 glyphs, MSB->left pixel, 5 rows.
const FONT3X5: Record<string, Uint8Array> = {
  // digits
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

  // punctuation used by your messages
  " ": new Uint8Array([0b000, 0b000, 0b000, 0b000, 0b000]),
  "!": new Uint8Array([0b010, 0b010, 0b010, 0b000, 0b010]),
  ".": new Uint8Array([0b000, 0b000, 0b000, 0b000, 0b010]),
  "-": new Uint8Array([0b000, 0b000, 0b111, 0b000, 0b000]),
  "/": new Uint8Array([0b001, 0b001, 0b010, 0b100, 0b100]),
  "<": new Uint8Array([0b001, 0b010, 0b100, 0b010, 0b001]),
  ">": new Uint8Array([0b100, 0b010, 0b001, 0b010, 0b100]),

  // basic uppercase letters (3x5 compromises but readable)
  "A": new Uint8Array([0b010, 0b101, 0b111, 0b101, 0b101]),
  "B": new Uint8Array([0b110, 0b101, 0b110, 0b101, 0b110]),
  "C": new Uint8Array([0b011, 0b100, 0b100, 0b100, 0b011]),
  "D": new Uint8Array([0b110, 0b101, 0b101, 0b101, 0b110]),
  "E": new Uint8Array([0b111, 0b100, 0b110, 0b100, 0b111]),
  "F": new Uint8Array([0b111, 0b100, 0b110, 0b100, 0b100]),
  "G": new Uint8Array([0b011, 0b100, 0b101, 0b101, 0b011]),
  "H": new Uint8Array([0b101, 0b101, 0b111, 0b101, 0b101]),
  "I": new Uint8Array([0b111, 0b010, 0b010, 0b010, 0b111]),
  "J": new Uint8Array([0b001, 0b001, 0b001, 0b101, 0b010]),
  "K": new Uint8Array([0b101, 0b101, 0b110, 0b101, 0b101]),
  "L": new Uint8Array([0b100, 0b100, 0b100, 0b100, 0b111]),
  "M": new Uint8Array([0b101, 0b111, 0b111, 0b101, 0b101]),
  "N": new Uint8Array([0b101, 0b111, 0b111, 0b111, 0b101]),
  "O": new Uint8Array([0b010, 0b101, 0b101, 0b101, 0b010]),
  "P": new Uint8Array([0b110, 0b101, 0b110, 0b100, 0b100]),
  "Q": new Uint8Array([0b010, 0b101, 0b101, 0b111, 0b011]),
  "R": new Uint8Array([0b110, 0b101, 0b110, 0b101, 0b101]),
  "S": new Uint8Array([0b011, 0b100, 0b010, 0b001, 0b110]),
  "T": new Uint8Array([0b111, 0b010, 0b010, 0b010, 0b010]),
  "U": new Uint8Array([0b101, 0b101, 0b101, 0b101, 0b111]),
  "V": new Uint8Array([0b101, 0b101, 0b101, 0b101, 0b010]),
  "W": new Uint8Array([0b101, 0b101, 0b111, 0b111, 0b101]),
  "X": new Uint8Array([0b101, 0b101, 0b010, 0b101, 0b101]),
  "Y": new Uint8Array([0b101, 0b101, 0b010, 0b010, 0b010]),
  "Z": new Uint8Array([0b111, 0b001, 0b010, 0b100, 0b111]),
};

function normalizeChar(ch: string) {
  if (ch >= "a" && ch <= "z") return ch.toUpperCase();
  return ch;
}

function glyphFor(ch: string) {
  return FONT3X5[normalizeChar(ch)] ?? FONT3X5[" "];
}

function text3x5Width(text: string, px: number, gap: number) {
  const n = text.length | 0;
  if (!n) return 0;
  return (n * (3 * px) + (n - 1) * gap) | 0;
}

function drawText3x5(ctx: CanvasRenderingContext2D, x: number, y: number, text: string, px: number, gap: number) {
  x |= 0;
  y |= 0;

  for (let i = 0; i < text.length; i++) {
    const g = glyphFor(text[i]);
    for (let ry = 0; ry < 5; ry++) {
      const row = g[ry] | 0;
      if (row & 0b100) ctx.fillRect(x + 0 * px, y + ry * px, px, px);
      if (row & 0b010) ctx.fillRect(x + 1 * px, y + ry * px, px, px);
      if (row & 0b001) ctx.fillRect(x + 2 * px, y + ry * px, px, px);
    }
    x += (3 * px + gap) | 0;
  }
}

function wrapText3x5(text: string, maxWidthPx: number, px: number, gap: number): string[] {
  // word wrap based on bitmap width, not measureText
  const words = text.split(" ");
  const lines: string[] = [];
  let line = "";

  for (const w of words) {
    const test = line ? line + " " + w : w;
    if (text3x5Width(test, px, gap) <= maxWidthPx) {
      line = test;
    } else {
      if (line) lines.push(line);
      line = w;
    }
  }
  if (line) lines.push(line);
  return lines;
}

function drawChamferBorder(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, fg: string, bg: string) {
  ctx.fillStyle = fg;
  ctx.fillRect(x, y, w, 1);
  ctx.fillRect(x, y + h - 1, w, 1);
  ctx.fillRect(x, y, 1, h);
  ctx.fillRect(x + w - 1, y, 1, h);

  ctx.fillStyle = bg;
  ctx.fillRect(x, y, 1, 1);
  ctx.fillRect(x + w - 1, y, 1, 1);
  ctx.fillRect(x, y + h - 1, 1, 1);
  ctx.fillRect(x + w - 1, y + h - 1, 1, 1);
}

export function createUiMessageSystem(): UiMessageSystem {
  const s: State = { text: "", visible: false };

  function set(text: string) {
    s.text = text;
    s.visible = true;
  }

  function clear() {
    s.visible = false;
  }

  function update(_dt: number) {
    // intentionally empty: no shimmer, no timers
  }

  function draw(ctx: CanvasRenderingContext2D, vw: number, _vh: number, invert: boolean) {
    if (!s.visible || !s.text) return;

    const fg = invert ? "#000" : "#fff";
    const bg = invert ? "#fff" : "#000";

    ctx.save();
    ctx.imageSmoothingEnabled = false;

    // Match HUD vibe
    const textPx = 1;          // keep 1 for crisp 1-bit
    const gap = 1 * textPx;    // inter-glyph gap
    const padX = 6;
    const padY = 5;

    const lineH = (5 * textPx + 5) | 0; // 5px glyph + spacing
    const maxTextWidth = (vw - padX * 2 - 8) | 0;

    const lines = wrapText3x5(s.text, maxTextWidth, textPx, gap);

    let maxLineW = 0;
    for (const l of lines) maxLineW = Math.max(maxLineW, text3x5Width(l, textPx, gap));

    const bw = (maxLineW + padX * 2) | 0;
    const bh = (lines.length * lineH + padY * 2) | 0;

    const x = clamp(((vw - bw) >> 1) | 0, 1, Math.max(1, vw - bw - 1));
    const y = 24;

    // Panel
    ctx.fillStyle = bg;
    ctx.fillRect(x, y, bw, bh);

    drawChamferBorder(ctx, x, y, bw, bh, fg, bg);
    if (bw > 6 && bh > 6) drawChamferBorder(ctx, x + 2, y + 2, bw - 4, bh - 4, fg, bg);

    // Text
    ctx.fillStyle = fg;
    for (let i = 0; i < lines.length; i++) {
      const tx = (x + padX) | 0;
      const ty = (y + padY + i * lineH) | 0;
      drawText3x5(ctx, tx, ty, lines[i], textPx, gap);
    }

    ctx.restore();
  }

  return { set, clear, update, draw };
}
