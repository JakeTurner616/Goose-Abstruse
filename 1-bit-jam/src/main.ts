// src/main.ts
import { createGame } from "./game";
import { createKeys, bindKeyboard } from "./input";
import { createOneBitBlitter } from "./onebit";

const VIRTUAL_W = 160;
const VIRTUAL_H = 144;

const canvas = document.getElementById("game") as HTMLCanvasElement;
const ctx = canvas.getContext("2d", { alpha: false })!;
ctx.imageSmoothingEnabled = false;
canvas.width = VIRTUAL_W;
canvas.height = VIRTUAL_H;

const off = document.createElement("canvas");
off.width = VIRTUAL_W;
off.height = VIRTUAL_H;
const offCtx = off.getContext("2d", { alpha: false })!;
offCtx.imageSmoothingEnabled = false;

function resize() {
  const maxW = innerWidth - 28;
  const maxH = innerHeight - 28;
  const s = Math.max(1, Math.floor(Math.min(maxW / VIRTUAL_W, maxH / VIRTUAL_H)));
  canvas.style.width = `${VIRTUAL_W * s}px`;
  canvas.style.height = `${VIRTUAL_H * s}px`;
}
addEventListener("resize", resize);
resize();

const keys = createKeys();

(async () => {
  const game = await createGame(VIRTUAL_W, VIRTUAL_H);

  bindKeyboard(keys, () => game.toggleInvert());

  const blit1bit = createOneBitBlitter({
    w: VIRTUAL_W,
    h: VIRTUAL_H,
    ctx,
    offCtx,
    mountainBG: {
      ...game.mountainBG,
      sampleScreen: (x: number, y: number) => !!game.mountainBG.sampleScreen(x, y),
    },
    getCam: () => game.cam,
    getInvert: () => game.invert,
  });

  let last = performance.now();
  function frame(now: number) {
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;

    game.update(dt, keys);

    // bg depends on camera
    game.mountainBG.render(game.cam.x | 0, game.cam.y | 0);

    game.draw(offCtx, VIRTUAL_W, VIRTUAL_H);
    blit1bit();

    requestAnimationFrame(frame);
  }

  requestAnimationFrame(frame);
})().catch(console.error);
