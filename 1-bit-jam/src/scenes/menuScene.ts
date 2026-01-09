// src/scenes/menuScene.ts
import type { Keys } from "../input";
import type { Scene } from "../scene";

function anyKeyDown(keys: Record<string, boolean>) {
  for (const k in keys) if (keys[k]) return true;
  return false;
}

export function createMenuScene(opts: {
  keys: Keys;
  /** one-frame pointer/tap trigger (cleared by main after update) */
  getTap: () => boolean;
  /** should we allow starting yet? (e.g. game loaded) */
  canStart: () => boolean;
  /** called when menu decides to start */
  start: () => void;
}): Scene {
  let t = 0;

  return {
    update(dt: number) {
      t += dt;

      const pressed = opts.getTap() || anyKeyDown(opts.keys as any);
      if (!pressed) return;

      if (opts.canStart()) opts.start();
      // if not ready, ignore presses (menu will show LOADING)
    },

    draw(offCtx: CanvasRenderingContext2D, vw: number, vh: number) {
      // simple black background (1-bit pass happens later)
      offCtx.fillStyle = "#000";
      offCtx.fillRect(0, 0, vw, vh);

      // title
      offCtx.fillStyle = "#fff";
      offCtx.textAlign = "center";
      offCtx.textBaseline = "middle";

      offCtx.font = "bold 16px monospace";
      offCtx.fillText("GOOSE JAM", (vw * 0.5) | 0, (vh * 0.35) | 0);

      offCtx.font = "10px monospace";
      offCtx.fillText("a tiny 1-bit adventure", (vw * 0.5) | 0, (vh * 0.47) | 0);

      // prompt
      const ready = opts.canStart();
      const blink = ((t * 2) | 0) & 1; // ~2hz
      const msg = ready ? "PRESS ANY KEY / TAP" : "LOADING...";

      if (ready || blink) {
        offCtx.fillText(msg, (vw * 0.5) | 0, (vh * 0.70) | 0);
      }

      offCtx.textAlign = "start";
      offCtx.textBaseline = "alphabetic";
    },
  };
}
