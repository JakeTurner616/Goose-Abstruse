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

// Global master volume (this now DEFINITELY affects in-game SFX)
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

// Single shared sound system for the whole app (menu + game)
const sound = createSoundSystem({
  volume: MASTER_VOLUME,
  muted: false,
});

// Simple OGG music system (separate from SFX; tiny + reliable)
const music = createOggMusic({
  volume: Math.min(1, MASTER_VOLUME * 12), // music usually wants more than SFX
  muted: false,
});

// ---- Audio gating: must be triggered from a real user input event
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

// Fire-and-forget: begin loading early (doesn't autoplay)
music
  .load("/Music/tix0.ogg")
  .then(() => {
    musicReady = true;
    tryStartMusic(); // in case we already unlocked + want music
  })
  .catch(console.error);

// one-frame tap/click latch (menu uses it)
let tapPressed = false;
canvas.addEventListener(
  "pointerdown",
  (e) => {
    e.preventDefault();
    tapPressed = true;
    unlockAudioOnce(); // <-- critical: event-based unlock
  },
  { passive: false }
);

// Keyboard-based unlock (covers "press any key" starts)
addEventListener(
  "keydown",
  () => {
    unlockAudioOnce(); // <-- critical: event-based unlock
  },
  { passive: true }
);

(async () => {
  // Start loading immediately, but show menu first.
  let game: Game | null = null;
  let gameReady = false;

  // bind keyboard immediately so menu can use keys too.
  // invert toggle becomes live once the game exists.
  bindKeyboard(keys, () => game?.toggleInvert());

  createGame(VIRTUAL_W, VIRTUAL_H, { sound })
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

        // We only request music here; actual playback waits for unlock+ready.
        wantMusic = true;
        tryStartMusic();

        mgr.set(createGameScene(game, keys));

        // patch blitter to read from the live game
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
