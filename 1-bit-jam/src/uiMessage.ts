// src/uiMessage.ts
export type UiMessageSystem = {
  set(text: string): void;
  clear(): void;
  update(dt: number): void;
  draw(ctx: CanvasRenderingContext2D, vw: number, vh: number, invert: boolean): void;
};

type State = {
  text: string;
  visible: boolean;
  bobT: number;
};

export function createUiMessageSystem(): UiMessageSystem {
  const s: State = { text: "", visible: false, bobT: 0 };

  function set(text: string) {
    s.text = text;
    s.visible = true;
  }

  function clear() {
    s.visible = false;
  }

  function update(dt: number) {
    if (!s.visible) return;
    s.bobT += dt;
  }

  function roundRectPath(
    ctx: CanvasRenderingContext2D,
    x: number,
    y: number,
    w: number,
    h: number,
    r: number
  ) {
    const rr = Math.max(0, Math.min(r, (w / 2) | 0, (h / 2) | 0));
    ctx.beginPath();
    ctx.moveTo(x + rr, y);
    ctx.arcTo(x + w, y, x + w, y + h, rr);
    ctx.arcTo(x + w, y + h, x, y + h, rr);
    ctx.arcTo(x, y + h, x, y, rr);
    ctx.arcTo(x, y, x + w, y, rr);
    ctx.closePath();
  }

  function wrapText(
    ctx: CanvasRenderingContext2D,
    text: string,
    maxWidth: number
  ): string[] {
    const words = text.split(" ");
    const lines: string[] = [];
    let line = "";

    for (const w of words) {
      const test = line ? line + " " + w : w;
      if (ctx.measureText(test).width <= maxWidth) {
        line = test;
      } else {
        if (line) lines.push(line);
        line = w;
      }
    }

    if (line) lines.push(line);
    return lines;
  }

  function draw(ctx: CanvasRenderingContext2D, vw: number, vh: number, invert: boolean) {
    if (!s.visible || !s.text) return;

    const fg = invert ? "#000" : "#fff";
    const bg = invert ? "#fff" : "#000";

    ctx.save();
    ctx.font = "10px monospace";
    ctx.textBaseline = "middle";

    const padX = 6;
    const padY = 5;
    const lineH = 10;

    // Hard clamp so UI NEVER exceeds canvas
    const maxTextWidth = vw - padX * 2 - 8;

    const lines = wrapText(ctx, s.text, maxTextWidth);

    let maxLineW = 0;
    for (const l of lines) {
      maxLineW = Math.max(maxLineW, ctx.measureText(l).width);
    }

    const bw = ((maxLineW + padX * 2 + 0.5) | 0);
    const bh = ((lines.length * lineH + padY * 2) | 0);

    const baseX = ((vw - bw) * 0.5 + 0.5) | 0;
    const baseY = 24;

    const bob = 0;
    const x = baseX;
    const y = (baseY + bob) | 0;

    // Background
    ctx.fillStyle = bg;
    roundRectPath(ctx, x, y, bw, bh, 3);
    ctx.fill();

    // Outer border
    ctx.strokeStyle = fg;
    ctx.lineWidth = 1;
    roundRectPath(ctx, x + 0.5, y + 0.5, bw - 1, bh - 1, 3);
    ctx.stroke();

    // Inner border
    roundRectPath(ctx, x + 2.5, y + 2.5, bw - 5, bh - 5, 2);
    ctx.stroke();

    // Text
    ctx.fillStyle = fg;
    for (let i = 0; i < lines.length; i++) {
      ctx.fillText(
        lines[i],
        (x + padX) | 0,
        (y + padY + lineH * i + (lineH >> 1)) | 0
      );
    }

    ctx.restore();
  }

  return { set, clear, update, draw };
}