// src/scenes/creditsScene.ts
import type { Keys } from "../input";
import type { Scene } from "../scene";

const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);

function anyKeyDown(keys: Record<string, boolean>) {
  for (const k in keys) if ((keys as any)[k]) return true;
  return false;
}

// -----------------------------------------------------------------------------
// Tiny 3x5 pixel text (fillRect only) + prerendered slides for performance
// -----------------------------------------------------------------------------
type PixText = {
  measure(text: string, scale: number): { w: number; h: number };
  drawLeftRaw(ctx: CanvasRenderingContext2D, text: string, x: number, y: number, scale: number): void;
};

function createPixText(): PixText {
  const G: Record<string, number[]> = {
    " ": [0, 0, 0, 0, 0],

    "0": [0b111, 0b101, 0b101, 0b101, 0b111],
    "1": [0b010, 0b110, 0b010, 0b010, 0b111],
    "2": [0b111, 0b001, 0b111, 0b100, 0b111],
    "3": [0b111, 0b001, 0b111, 0b001, 0b111],
    "4": [0b101, 0b101, 0b111, 0b001, 0b001],
    "5": [0b111, 0b100, 0b111, 0b001, 0b111],
    "6": [0b111, 0b100, 0b111, 0b101, 0b111],
    "7": [0b111, 0b001, 0b001, 0b001, 0b001],
    "8": [0b111, 0b101, 0b111, 0b101, 0b111],
    "9": [0b111, 0b101, 0b111, 0b001, 0b111],

    "!": [0b010, 0b010, 0b010, 0b000, 0b010],
    ".": [0b000, 0b000, 0b000, 0b000, 0b010],
    ",": [0b000, 0b000, 0b000, 0b010, 0b100],
    ":": [0b000, 0b010, 0b000, 0b010, 0b000],
    "-": [0b000, 0b000, 0b111, 0b000, 0b000],
    "/": [0b001, 0b001, 0b010, 0b100, 0b100],
    "'": [0b010, 0b010, 0b000, 0b000, 0b000],
    "(": [0b001, 0b010, 0b010, 0b010, 0b001],
    ")": [0b100, 0b010, 0b010, 0b010, 0b100],
    "_": [0b000, 0b000, 0b000, 0b000, 0b111],

    A: [0b010, 0b101, 0b111, 0b101, 0b101],
    B: [0b110, 0b101, 0b110, 0b101, 0b110],
    C: [0b011, 0b100, 0b100, 0b100, 0b011],
    D: [0b110, 0b101, 0b101, 0b101, 0b110],
    E: [0b111, 0b100, 0b110, 0b100, 0b111],
    F: [0b111, 0b100, 0b110, 0b100, 0b100],
    G: [0b011, 0b100, 0b101, 0b101, 0b011],
    H: [0b101, 0b101, 0b111, 0b101, 0b101],
    I: [0b111, 0b010, 0b010, 0b010, 0b111],
    J: [0b111, 0b001, 0b001, 0b101, 0b010],
    K: [0b101, 0b110, 0b100, 0b110, 0b101],
    L: [0b100, 0b100, 0b100, 0b100, 0b111],
    M: [0b101, 0b111, 0b111, 0b101, 0b101],
    N: [0b101, 0b111, 0b111, 0b111, 0b101],
    O: [0b010, 0b101, 0b101, 0b101, 0b010],
    P: [0b110, 0b101, 0b110, 0b100, 0b100],
    Q: [0b010, 0b101, 0b101, 0b111, 0b011],
    R: [0b110, 0b101, 0b110, 0b101, 0b101],
    S: [0b011, 0b100, 0b010, 0b001, 0b110],
    T: [0b111, 0b010, 0b010, 0b010, 0b010],
    U: [0b101, 0b101, 0b101, 0b101, 0b111],
    V: [0b101, 0b101, 0b101, 0b101, 0b010],
    W: [0b101, 0b101, 0b111, 0b111, 0b101],
    X: [0b101, 0b101, 0b010, 0b101, 0b101],
    Y: [0b101, 0b101, 0b010, 0b010, 0b010],
    Z: [0b111, 0b001, 0b010, 0b100, 0b111],
  };

  const CHAR_W = 3;
  const CHAR_H = 5;
  const GAP_X = 1;

  const snapScale = (s: number) => Math.max(1, Math.round(s * 2) / 2);
  const cell = (s: number) => ((snapScale(s) + 0.5) | 0);

  function norm(ch: string) {
    if (ch >= "a" && ch <= "z") return ch.toUpperCase();
    return ch;
  }
  function glyph(ch: string) {
    return G[norm(ch)] ?? G[" "];
  }

  function measure(text: string, scale: number) {
    const s = cell(scale);
    const n = text.length | 0;
    const w = n ? n * (CHAR_W * s) + (n - 1) * (GAP_X * s) : 0;
    const h = CHAR_H * s;
    return { w, h };
  }

  function drawLeftRaw(ctx: CanvasRenderingContext2D, text: string, x: number, y: number, scale: number) {
    text = text.toUpperCase();
    const s = cell(scale);
    x = (x + 0.5) | 0;
    y = (y + 0.5) | 0;

    for (let i = 0; i < text.length; i++) {
      const rows = glyph(text[i] || " ");
      const bx = x + i * ((CHAR_W + GAP_X) * s);

      for (let ry = 0; ry < CHAR_H; ry++) {
        const bits = rows[ry] | 0;
        if (!bits) continue;

        const py = y + ry * s;
        if (bits & 0b100) ctx.fillRect(bx + 0 * s, py, s, s);
        if (bits & 0b010) ctx.fillRect(bx + 1 * s, py, s, s);
        if (bits & 0b001) ctx.fillRect(bx + 2 * s, py, s, s);
      }
    }
  }

  return { measure, drawLeftRaw };
}

function wrapByPixelWidth(pix: PixText, text: string, maxW: number, scale: number): string[] {
  const words = text.trim().split(/\s+/g);
  const out: string[] = [];
  let line = "";

  for (const w of words) {
    const test = line ? line + " " + w : w;
    if (pix.measure(test.toUpperCase(), scale).w <= maxW) line = test;
    else {
      if (line) out.push(line);
      line = w;
    }
  }
  if (line) out.push(line);
  return out;
}

// -----------------------------------------------------------------------------
// Dither fade (ordered Bayer 4x4) — stable, cheap, 1-bit friendly
// -----------------------------------------------------------------------------
const BAYER_4X4 = new Uint8Array([
  0, 8, 2, 10,
  12, 4, 14, 6,
  3, 11, 1, 9,
  15, 7, 13, 5,
]);

function ditherMaskBlack(ctx: CanvasRenderingContext2D, vw: number, vh: number, amount01: number) {
  const a = clamp(amount01, 0, 1);
  if (a <= 0) return;

  const t = (a * 16 + 0.00001) | 0;
  if (t >= 16) {
    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, vw, vh);
    return;
  }

  ctx.fillStyle = "#000";
  for (let y = 0; y < vh; y++) {
    const ry = (y & 3) << 2;
    for (let x = 0; x < vw; x++) {
      const v = BAYER_4X4[ry | (x & 3)] | 0;
      if (v < t) ctx.fillRect(x, y, 1, 1);
    }
  }
}

// -----------------------------------------------------------------------------
// Slides (minimal content only, with final "THANKS FOR PLAYING!" held forever)
// -----------------------------------------------------------------------------
type Slide = {
  title?: string;
  lines: string[];
};

function creditsSlides(): Slide[] {
  return [
    {
      title: "CREDITS",
      lines: ["MADE FOR", "1 BIT JAM"],
    },
    {
      title: "SPECIAL THANKS",
      lines: ["DEDICATED TO", "WILIS000"],
    },
    {
      title: "MUSIC",
      lines: ["TIX0 - NEPTUNIUM237", "2_TRASH_2_TRACK - NEPTUNIUM237", "KC-SYNTHLESS2014EDIT - Katie Cadet"],
    },
    {
      title: "ART",
      lines: ["KENNEY 8X8 TILES", "GOOSE BY DUCKHIVE"],
    },
    {
      title: "SFX",
      lines: ["JSFXR"],
    },
    {
      title: "THANKS",
      lines: ["THANKS FOR PLAYING!"],
    },
  ];
}

type RenderedSlide = {
  img: HTMLCanvasElement;
};

function prerenderSlides(vw: number, vh: number) {
  const pix = createPixText();
  const slides = creditsSlides();

  const PAD_X = 10;
  const MAX_W = vw - PAD_X * 2;

  const SCALE_TITLE = 1.5;
  const SCALE_LINE = 1.0;

  const out: RenderedSlide[] = [];

  for (const s of slides) {
    const c = document.createElement("canvas");
    c.width = vw | 0;
    c.height = vh | 0;
    const g = c.getContext("2d", { alpha: false })!;
    g.imageSmoothingEnabled = false;

    g.fillStyle = "#000";
    g.fillRect(0, 0, vw, vh);

    const textLines: { text: string; scale: number }[] = [];

    if (s.title) textLines.push({ text: s.title, scale: SCALE_TITLE });

    for (const raw of s.lines) {
      const wrapped = wrapByPixelWidth(pix, raw.toUpperCase(), MAX_W, SCALE_LINE);
      for (const w of wrapped) textLines.push({ text: w, scale: SCALE_LINE });
    }

    // measure block height
    let blockH = 0;
    for (let i = 0; i < textLines.length; i++) {
      const sc = textLines[i].scale;
      const h = (pix.measure("A", sc).h + (i === 0 && sc > 1 ? 7 : 5)) | 0;
      blockH += h;
    }

    const startY = (((vh - blockH) >> 1) - 6) | 0;

    let y = startY;
    for (let i = 0; i < textLines.length; i++) {
      const { text, scale } = textLines[i];
      const m = pix.measure(text, scale);
      const x = ((vw - m.w) >> 1) | 0;

      const linePad = (i === 0 && scale > 1 ? 7 : 5) | 0;

      // shadow
      g.fillStyle = "#000";
      pix.drawLeftRaw(g, text, x + 1, y + 1, scale);

      // main
      g.fillStyle = "#fff";
      pix.drawLeftRaw(g, text, x, y, scale);

      y += (pix.measure("A", scale).h + linePad) | 0;

      // divider under title (with shadow)
      if (i === 0 && scale > 1) {
        const midY = (y - 3) | 0;
        g.fillStyle = "#000";
        g.fillRect(((vw >> 1) - 28 + 1) | 0, (midY + 1) | 0, 56, 1);
        g.fillStyle = "#fff";
        g.fillRect(((vw >> 1) - 28) | 0, midY, 56, 1);
      }
    }

    out.push({ img: c });
  }

  return out;
}

// -----------------------------------------------------------------------------
// Credits Scene (slide show with dither fades; final slide holds forever)
// -----------------------------------------------------------------------------
export function createCreditsScene(opts: {
  keys: Keys;
  getTap: () => boolean;

  // called when credits become active / inactive (used for music)
  onEnter?: () => void;
  onExit?: () => void;

  // optional; if omitted, early slides still advance, final holds forever
  back?: () => void;
}): Scene {
  let rendered: RenderedSlide[] | null = null;

  // Longer duration per slide (requested)
  const HOLD_SEC = 7.25; // time fully visible
  const FADE_SEC = 0.65; // fade in/out (dither)
  const TOTAL_SEC = HOLD_SEC + FADE_SEC * 2;

  let idx = 0;
  let t = 0;

  let prevPressed = false;

  function pressedNow(): boolean {
    return !!opts.getTap() || anyKeyDown(opts.keys as any);
  }

  function ensure(vw: number, vh: number) {
    if (rendered) return;
    rendered = prerenderSlides(vw, vh);
  }

  function isFinal(): boolean {
    if (!rendered || rendered.length === 0) return true;
    return idx >= rendered.length - 1;
  }

  function goNext() {
    if (!rendered || rendered.length === 0) return;

    // Never advance past final; final slide is the terminal state.
    if (idx >= rendered.length - 1) return;

    idx++;
    t = 0;
  }

  return {
    enter() {
      // prevent an already-held key from instantly skipping the first slide
      prevPressed = pressedNow();
      opts.onEnter?.();
    },

    exit() {
      opts.onExit?.();
    },

    update(dt: number) {
      dt = clamp(dt, 0, 1 / 30);

      const now = pressedNow();
      const rising = now && !prevPressed;
      prevPressed = now;

      // No "tap to continue" prompts; but allow skipping earlier slides.
      if (rising && !isFinal()) {
        goNext();
        return;
      }

      // Final slide is the end of the branch: stop advancing forever.
      if (isFinal()) return;

      t += dt;

      if (t >= TOTAL_SEC) {
        goNext();
      }
    },

    draw(offCtx: CanvasRenderingContext2D, vw: number, vh: number) {
      offCtx.imageSmoothingEnabled = false;

      ensure(vw, vh);

      if (!rendered || rendered.length === 0) {
        offCtx.fillStyle = "#000";
        offCtx.fillRect(0, 0, vw, vh);
        return;
      }

      const s = rendered[idx % rendered.length];

      offCtx.drawImage(s.img, 0, 0);

      // Final slide: no fades, no overlays, just hold
      if (isFinal()) return;

      // fade mask amount (mask-to-black)
      const tt = t;
      let mask = 0;

      if (tt < FADE_SEC) {
        mask = 1 - tt / FADE_SEC; // fade-in
      } else if (tt > FADE_SEC + HOLD_SEC) {
        const u = (tt - (FADE_SEC + HOLD_SEC)) / FADE_SEC; // fade-out
        mask = clamp(u, 0, 1);
      } else {
        mask = 0;
      }

      if (mask > 0) ditherMaskBlack(offCtx, vw, vh, mask);
    },
  };
}
