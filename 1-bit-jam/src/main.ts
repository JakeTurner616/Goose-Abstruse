// src/main.ts
import { createGame, type Game } from "./game";
import { createKeys, bindKeyboard } from "./input";
import { createOneBitBlitter } from "./onebit";

import { createSceneManager } from "./scene";
import { createMenuScene } from "./scenes/menuScene";
import { createGameScene } from "./scenes/gameScene";

import { createSoundSystem } from "./sound";
import { createOggMusic } from "./musicOgg";

const VIRTUAL_W = 160;
const VIRTUAL_H = 144;

// Global master volume
const MASTER_VOLUME = 0.05;

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

const sound = createSoundSystem({
  volume: MASTER_VOLUME,
  muted: false,
});

const music = createOggMusic({
  volume: Math.min(1, MASTER_VOLUME * 12),
  muted: false,
});

let audioUnlocked = false;
let wantMusic = false;
let musicReady = false;

function unlockAudioOnce() {
  if (audioUnlocked) return;
  audioUnlocked = true;
  sound.userGesture();
  music.userGesture();
  tryStartMusic();
}

function tryStartMusic() {
  if (!wantMusic) return;
  if (!audioUnlocked) return;
  if (!musicReady) return;
  if (music.isPlaying()) return;
  music.play({ loop: true, restart: true });
}

music
  .load("/Music/tix0.ogg")
  .then(() => {
    musicReady = true;
    tryStartMusic();
  })
  .catch(console.error);

let tapPressed = false;
canvas.addEventListener(
  "pointerdown",
  (e) => {
    e.preventDefault();
    tapPressed = true;
    unlockAudioOnce();
  },
  { passive: false }
);

addEventListener(
  "keydown",
  () => {
    unlockAudioOnce();
  },
  { passive: true }
);

(async () => {
  let game: Game | null = null;
  let gameReady = false;

  bindKeyboard(keys, () => game?.toggleInvert());

  createGame(VIRTUAL_W, VIRTUAL_H, { sound })
    .then((g) => {
      game = g;
      gameReady = true;
    })
    .catch(console.error);

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

  const mgr = createSceneManager(
    createMenuScene({
      keys,
      getTap: () => tapPressed,
      canStart: () => gameReady,
      start: () => {
        if (!game) return;

        wantMusic = true;
        tryStartMusic();

        mgr.set(createGameScene(game, keys));

        const liveBlit = createOneBitBlitter({
          w: VIRTUAL_W,
          h: VIRTUAL_H,
          ctx,
          offCtx,
          mountainBG: {
            ...game.mountainBG,
            sampleScreen: (x: number, y: number) => !!game!.mountainBG.sampleScreen(x, y),
          },
          getCam: () => game!.cam,
          getInvert: () => game!.invert,
        });

        (blit1bit as any).__impl = liveBlit;
      },
    })
  );

  const blit = () => {
    const impl = (blit1bit as any).__impl as undefined | (() => void);
    (impl ?? blit1bit)();
  };

  // --- Framerate Gating Logic ---
  let last = performance.now();
  const FPS = 60;
  const FRAME_MIN_TIME = 1000 / FPS; 

  function frame(now: number) {
    const elapsed = now - last;

    // Only update and draw if enough time has passed for a 30fps frame
    if (elapsed >= FRAME_MIN_TIME) {
      // Calculate delta time in seconds, clamped to avoid physics glitches
      const dt = Math.min(0.1, elapsed / 1000);
      
      // Steady timing adjustment
      last = now - (elapsed % FRAME_MIN_TIME);

      mgr.update(dt);

      // Reset one-frame input state
      tapPressed = false;

      mgr.draw(offCtx, VIRTUAL_W, VIRTUAL_H);
      blit();
    }

    requestAnimationFrame(frame);
  }

  requestAnimationFrame(frame);
})().catch(console.error);