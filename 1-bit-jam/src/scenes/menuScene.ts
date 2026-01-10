// src/scenes/menuScene.ts
import type { Keys } from "../input";
import type { Scene } from "../scene";
import { getBakedForSize } from "../spriteBake";

const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

function anyKeyDown(keys: Record<string, boolean>) {
  for (const k in keys) if (keys[k]) return true;
  return false;
}

type Baked = Awaited<ReturnType<typeof getBakedForSize>>;

type SpriteRig = {
  baked: Baked;
  anim: "idle" | "walk" | "flap";
  frame: number;
  at: number;
  rate: number;
};

function tickRig(r: SpriteRig, dt: number) {
  const frames = r.anim === "walk" ? r.baked.walk : r.anim === "flap" ? r.baked.flap : r.baked.idle;

  r.at += dt * r.rate;
  const adv = r.at | 0;
  if (!adv) return;
  r.at -= adv;
  r.frame = (r.frame + adv) % frames.length;
}

function drawRig(ctx: CanvasRenderingContext2D, r: SpriteRig, x: number, y: number, facing: 1 | -1) {
  const frames = r.anim === "walk" ? r.baked.walk : r.anim === "flap" ? r.baked.flap : r.baked.idle;

  const img = frames[r.frame % frames.length];
  const dx = (x + 0.5) | 0;
  const dy = (y + 0.5) | 0;

  if (facing === 1) {
    ctx.drawImage(img, dx, dy);
  } else {
    ctx.save();
    ctx.translate(dx + img.width, dy);
    ctx.scale(-1, 1);
    ctx.drawImage(img, 0, 0);
    ctx.restore();
  }
}

// -----------------------------------------------------------------------------
// Pixel-scaled tiny text (subtitle/prompt) — fillRect only (no canvas font shimmer)
// -----------------------------------------------------------------------------
type PixText = {
  draw(ctx: CanvasRenderingContext2D, text: string, cx: number, cy: number, scale: number): void;
};

function createPixText(): PixText {
  // 3x5 caps-ish glyphs
  // Expanded set to cover: ROUND UP THE GOSLINGS / TAP CLICK TO BEGIN / LOADING
  const G: Record<string, number[]> = {
    " ": [0, 0, 0, 0, 0],
    "!": [0b010, 0b010, 0b010, 0b000, 0b010],
    "/": [0b001, 0b001, 0b010, 0b100, 0b100],
    ".": [0b000, 0b000, 0b000, 0b000, 0b010],

    A: [0b010, 0b101, 0b111, 0b101, 0b101],
    B: [0b110, 0b101, 0b110, 0b101, 0b110],
    C: [0b011, 0b100, 0b100, 0b100, 0b011],
    D: [0b110, 0b101, 0b101, 0b101, 0b110],
    E: [0b111, 0b100, 0b110, 0b100, 0b111],
    G: [0b011, 0b100, 0b101, 0b101, 0b011],
    H: [0b101, 0b101, 0b111, 0b101, 0b101],
    I: [0b111, 0b010, 0b010, 0b010, 0b111],
    J: [0b111, 0b001, 0b001, 0b101, 0b010],
    K: [0b101, 0b110, 0b100, 0b110, 0b101],
    L: [0b100, 0b100, 0b100, 0b100, 0b111],
    N: [0b101, 0b111, 0b111, 0b111, 0b101],
    O: [0b010, 0b101, 0b101, 0b101, 0b010],
    P: [0b110, 0b101, 0b110, 0b100, 0b100],
    R: [0b110, 0b101, 0b110, 0b101, 0b101],
    S: [0b011, 0b100, 0b010, 0b001, 0b110],
    T: [0b111, 0b010, 0b010, 0b010, 0b010],
    U: [0b101, 0b101, 0b101, 0b101, 0b111],
    W: [0b101, 0b101, 0b111, 0b111, 0b101],
    Y: [0b101, 0b101, 0b010, 0b010, 0b010],
  };

  const CHAR_W = 3;
  const CHAR_H = 5;
  const GAP_X = 1;

  function measure(text: string) {
    const n = text.length;
    const w = n ? n * CHAR_W + (n - 1) * GAP_X : 0;
    return { w, h: CHAR_H };
  }

  function draw(ctx: CanvasRenderingContext2D, text: string, cx: number, cy: number, scale: number) {
    // allow fractional scales by snapping to half-step: 1, 1.5, 2, ...
    // but still render on integer pixels by rounding each rect origin
    scale = Math.max(1, Math.round(scale * 2) / 2);

    const m = measure(text);
    const w = m.w * scale;
    const h = m.h * scale;

    const x0f = cx - w * 0.5;
    const y0f = cy - h * 0.5;

    for (let i = 0; i < text.length; i++) {
      const ch = (text[i] || " ").toUpperCase();
      const rows = G[ch] || G[" "];

      const baseXf = x0f + i * (CHAR_W + GAP_X) * scale;

      for (let ry = 0; ry < CHAR_H; ry++) {
        const bits = rows[ry] | 0;
        if (!bits) continue;

        const yf = y0f + ry * scale;
        const y = (yf + 0.5) | 0;

        for (let rx = 0; rx < CHAR_W; rx++) {
          if ((bits & (1 << (CHAR_W - 1 - rx))) === 0) continue;

          const xf = baseXf + rx * scale;
          const x = (xf + 0.5) | 0;

          // width/height need to stay integer to avoid browser AA
          const s = (scale + 0.5) | 0;
          ctx.fillRect(x, y, s, s);
        }
      }
    }
  }

  return { draw };
}

// -----------------------------------------------------------------------------
// Cute parade: leader + babies that "bunch" in roughly the same Y lane
// -----------------------------------------------------------------------------
type Parade = {
  ready: boolean;
  update(dt: number): void;
  draw(ctx: CanvasRenderingContext2D, vw: number, vh: number): void;
};

function createParade(): Parade {
  let ready = false;

  let big: SpriteRig | null = null;
  let baby: SpriteRig | null = null;

  let dir: 1 | -1 = 1;
  let speed = 22;
  let leaderX = -40;

  let laneY = 0;

  const babies: { x: number; y: number; phase: number; bias: number }[] = [];
  let babyCount = 4;

  const MARGIN = 28;
  const SPACING = 9;
  const FOLLOW_T = 22;
  const MAX_STEP_X = 7;
  const Y_FOLLOW_T = 28;
  const MAX_STEP_Y = 2;

  const LEADER_BOB = 1;
  const LEADER_BOB_RATE = 3.2;

  const BABY_BOB = 1;
  const BABY_BOB_RATE = 4.1;

  let didReset = false;
  let t = 0;

  const initPromise = (async () => {
    const [bigBaked, babyBaked] = await Promise.all([getBakedForSize(24, 24), getBakedForSize(16, 16)]);
    big = { baked: bigBaked, anim: "walk", frame: 0, at: 0, rate: 10.0 };
    baby = { baked: babyBaked, anim: "walk", frame: 0, at: 0, rate: 11.5 };
    ready = true;
  })();

  void initPromise;

  function reset(vw: number, vh: number) {
    dir = Math.random() < 0.8 ? 1 : -1;
    speed = 18 + Math.random() * 16;
    babyCount = 3 + ((Math.random() * 4) | 0);

    const lane = 0.60 + Math.random() * 0.18;
    laneY = ((vh * lane) | 0) - 10;

    leaderX = dir === 1 ? -MARGIN : vw + MARGIN;

    babies.length = 0;
    for (let i = 0; i < babyCount; i++) {
      const phase = Math.random() * Math.PI * 2;
      const bias = (Math.random() * 2 - 1) * 1;
      babies.push({
        x: leaderX - dir * (i + 1) * (SPACING + 2),
        y: laneY + 6 + bias,
        phase,
        bias,
      });
    }
  }

  function update(dt: number) {
    dt = clamp(dt, 0, 1 / 30);
    t += dt;

    if (!didReset) return;
    if (!ready || !big || !baby) return;

    leaderX += dir * speed * dt;

    let prevX = leaderX;
    for (let i = 0; i < babies.length; i++) {
      const b = babies[i];

      const tx = prevX - dir * SPACING;
      const kx = 1 - Math.exp(-FOLLOW_T * dt);
      const nx = lerp(b.x, tx, kx);

      let dx = nx - b.x;
      dx = clamp(dx, -MAX_STEP_X, MAX_STEP_X);
      b.x += dx;

      const bob = (Math.sin(t * BABY_BOB_RATE + b.phase) * BABY_BOB) | 0;
      const ty = laneY + 6 + b.bias + bob;

      const ky = 1 - Math.exp(-Y_FOLLOW_T * dt);
      const ny = lerp(b.y, ty, ky);

      let dy = ny - b.y;
      dy = clamp(dy, -MAX_STEP_Y, MAX_STEP_Y);
      b.y += dy;

      prevX = b.x;
    }

    tickRig(big, dt);
    tickRig(baby, dt);

    const outRight = dir === 1 && leaderX > 160 + MARGIN;
    const outLeft = dir === -1 && leaderX < -MARGIN - 24;
    if (outRight || outLeft) didReset = false;
  }

  function draw(ctx: CanvasRenderingContext2D, vw: number, vh: number) {
    if (!didReset) {
      reset(vw, vh);
      didReset = true;
    }
    if (!ready || !big || !baby) return;

    ctx.imageSmoothingEnabled = false;

    const facing = dir;

    for (let i = babies.length - 1; i >= 0; i--) {
      const b = babies[i];
      drawRig(ctx, baby, b.x | 0, b.y | 0, facing);
    }

    const leaderY = laneY + ((Math.sin(t * LEADER_BOB_RATE) * LEADER_BOB) | 0);
    drawRig(ctx, big, leaderX | 0, leaderY | 0, facing);
  }

  return { get ready() { return ready; }, update, draw };
}

// -----------------------------------------------------------------------------
// Menu Scene
// -----------------------------------------------------------------------------
export function createMenuScene(opts: {
  keys: Keys;
  getTap: () => boolean;
  canStart: () => boolean;
  start: () => void;
}): Scene {
  let t = 0;
  const parade = createParade();
  const pixText = createPixText();

  return {
    update(dt: number) {
      t += dt;
      parade.update(dt);

      const pressed = opts.getTap() || anyKeyDown(opts.keys as any);
      if (!pressed) return;

      if (opts.canStart()) opts.start();
    },

    draw(offCtx: CanvasRenderingContext2D, vw: number, vh: number) {
      offCtx.fillStyle = "#000";
      offCtx.fillRect(0, 0, vw, vh);

      // parade behind title
      parade.draw(offCtx, vw, vh);

      offCtx.imageSmoothingEnabled = false;
      offCtx.textAlign = "center";
      offCtx.textBaseline = "middle";

      const cx = (vw * 0.5) | 0;

      // ---------------------------------------------------------------------
      // TITLE: stepped bob + 1px shadow (pixel-snapped)
      // ---------------------------------------------------------------------
      const titleY = (vh * 0.30) | 0;
      const step = ((t * 8) | 0) & 3;
      const bobY = step === 1 ? 1 : step === 3 ? -1 : 0;

      const beat = 2.6;
      const f = ((t % beat) * 60) | 0;
      const punchX = f === 0 || f === 1 ? 1 : 0;

      const size = 16;
      offCtx.font = `bold ${size}px monospace`;

      offCtx.fillStyle = "#000";
      offCtx.fillText("GOOSE JAM", (cx + 1 + punchX) | 0, (titleY + 1 + bobY) | 0);

      offCtx.fillStyle = "#fff";
      offCtx.fillText("GOOSE JAM", (cx + punchX) | 0, (titleY + bobY) | 0);

      // ---------------------------------------------------------------------
      // SUBTITLE: pixel-text (crisp, no blur)
      // ---------------------------------------------------------------------
      const sub = "ROUND UP THE GOSLINGS";
      const subY = (vh * 0.40) | 0;
      const subStep = (((t * 6) | 0) & 7) === 2 ? 1 : 0;

      const subScale = 0.7; // crisp + small (3x5 font)
      offCtx.fillStyle = "#000";
      pixText.draw(offCtx, sub, cx + 1, subY + 1 + subStep, subScale);

      offCtx.fillStyle = "#fff";
      pixText.draw(offCtx, sub, cx, subY + subStep, subScale);

      // ---------------------------------------------------------------------
      // PROMPT: pixel-text only (matches subtitle), and copy is TAP/CLICK
      // ---------------------------------------------------------------------
      const ready = opts.canStart();
      const blink = ((t * 2) | 0) & 1;

      if (ready || blink) {
        const prompt = ready ? "TAP / CLICK TO BEGIN" : "LOADING...";
        const py = (vh * 0.72) | 0;

        const pStep = (((t * 6) | 0) & 7) === 3 ? 1 : 0;

        // keep prompt a bit smaller than subtitle
        const pScale = 0.7;

        offCtx.fillStyle = "#000";
        pixText.draw(offCtx, prompt, cx + 1, py + 1 + pStep, pScale);

        offCtx.fillStyle = "#fff";
        pixText.draw(offCtx, prompt, cx, py + pStep, pScale);
      }

      offCtx.textAlign = "start";
      offCtx.textBaseline = "alphabetic";
    },
  };
}
