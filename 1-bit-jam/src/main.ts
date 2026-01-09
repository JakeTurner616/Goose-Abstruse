// src/main.ts
import { createGame, type Game } from "./game";
import { createKeys, bindKeyboard } from "./input";
import { createOneBitBlitter } from "./onebit";

import { createSceneManager } from "./scene";
import { createMenuScene } from "./scenes/menuScene";
import { createGameScene } from "./scenes/gameScene";

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

// one-frame tap/click latch (menu uses it)
let tapPressed = false;
canvas.addEventListener(
  "pointerdown",
  (e) => {
    e.preventDefault();
    tapPressed = true;
  },
  { passive: false }
);

(async () => {
  // Start loading immediately, but show menu first.
  let game: Game | null = null;
  let gameReady = false;

  createGame(VIRTUAL_W, VIRTUAL_H)
    .then((g) => {
      game = g;
      gameReady = true;
    })
    .catch(console.error);

  // Minimal “safe” placeholders for blitter until game arrives
  const dummyCam = { x: 0, y: 0 };
  const dummyBG = { sampleScreen: (_x: number, _y: number) => false };

  const blit1bit = createOneBitBlitter({
    w: VIRTUAL_W,
    h: VIRTUAL_H,
    ctx,
    offCtx,
    mountainBG: dummyBG,
    getCam: () => dummyCam,
    getInvert: () => false,
  });

  // Scene manager: start at menu, transition to game when ready + input
  const mgr = createSceneManager(
    createMenuScene({
      keys,
      getTap: () => tapPressed,
      canStart: () => gameReady,
      start: () => {
        if (!game) return;
        mgr.set(createGameScene(game, keys));

        // now that game exists, wire keyboard invert + real blitter hooks
        bindKeyboard(keys, () => game!.toggleInvert());

        // patch blitter to read from the live game (cheap trick: replace closures by re-creating blitter)
        const liveBlit = createOneBitBlitter({
          w: VIRTUAL_W,
          h: VIRTUAL_H,
          ctx,
          offCtx,
          mountainBG: {
            ...game!.mountainBG,
            sampleScreen: (x: number, y: number) => !!game!.mountainBG.sampleScreen(x, y),
          },
          getCam: () => game!.cam,
          getInvert: () => game!.invert,
        });

        // swap function reference
        (blit1bit as any).__impl = liveBlit;
      },
    })
  );

  // Wrap blit so we can hot-swap after game loads without re-threading the loop
  const blit = () => {
    const impl = (blit1bit as any).__impl as undefined | (() => void);
    (impl ?? blit1bit)();
  };

  let last = performance.now();
  function frame(now: number) {
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;

    mgr.update(dt);

    // clear one-frame tap
    tapPressed = false;

    mgr.draw(offCtx, VIRTUAL_W, VIRTUAL_H);
    blit();

    requestAnimationFrame(frame);
  }

  requestAnimationFrame(frame);
})().catch(console.error);
