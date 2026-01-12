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

// share one AudioContext between both music players (so the gesture unlock applies to both)
const musicCtx =
  new (window.AudioContext || (window as any).webkitAudioContext)({
    latencyHint: "interactive",
  }) as AudioContext;

const music = createOggMusic({
  volume: Math.min(1, MASTER_VOLUME * 12),
  muted: false,
  ctx: musicCtx,
});

const winMusic = createOggMusic({
  // louder than normal music
  volume: Math.min(1, MASTER_VOLUME * 36),
  muted: false,
  ctx: musicCtx,
});

let audioUnlocked = false;
let wantMusic = false;

let musicReady = false;
let winReady = false;

function unlockAudioOnce() {
  if (audioUnlocked) return;
  audioUnlocked = true;
  sound.userGesture();
  music.userGesture();
  winMusic.userGesture();
  tryStartMusic();
}

function tryStartMusic() {
  if (!wantMusic) return;
  if (!audioUnlocked) return;
  if (!musicReady) return;
  if (music.isPlaying()) return;
  music.play({ loop: true, restart: true });
}

function playWinTrack() {
  if (!audioUnlocked) return;
  if (!winReady) return;

  music.stop({ fadeSec: 0.06 });
  winMusic.play({ loop: false, restart: true });
}
function restoreNormalTrack() {
  winMusic.stop({ fadeSec: 0.02 });
  tryStartMusic();
}

music
  .load("/Music/tix0.ogg")
  .then(() => {
    musicReady = true;
    tryStartMusic();
  })
  .catch(console.error);

winMusic
  .load("/Music/level-win.ogg")
  .then(() => {
    winReady = true;
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

// -----------------------------------------------------------------------------
// Debug console API (rapid prototyping)
// -----------------------------------------------------------------------------
declare global {
  interface Window {
    dbg?: {
      game: () => Game | null;

      // level controls
      info: () => { index: number; count: number };
      level: (i: number) => void;
      next: () => void;
      prev: () => void;
      reload: () => void;

      // optional convenience
      invert: () => void;
      music: (on: boolean) => void;
    };
  }
}

(async () => {
  let game: Game | null = null;
  let gameReady = false;

  bindKeyboard(keys, () => game?.toggleInvert());

  createGame(VIRTUAL_W, VIRTUAL_H, {
    sound,
    onWinMusicBegin: playWinTrack,
    onWinMusicEnd: restoreNormalTrack,
  })
    .then((g) => {
      game = g;
      gameReady = true;

      // expose debug API once game exists
      window.dbg = {
        game: () => game,

        info: () => ({
          index: game ? game.getLevelIndex() : -1,
          count: game ? game.getLevelCount() : 0,
        }),

        level: (i: number) => {
          if (!game) return;
          // ensure we are in-game (not stuck in menu) by requesting start music + scene switch if needed
          // (safe even if already in-game)
          wantMusic = true;
          tryStartMusic();
          game.loadLevel(i | 0);
          console.log("[dbg] loadLevel ->", game.getLevelIndex(), "/", game.getLevelCount());
        },

        next: () => {
          if (!game) return;
          wantMusic = true;
          tryStartMusic();
          game.nextLevel();
          console.log("[dbg] nextLevel ->", game.getLevelIndex(), "/", game.getLevelCount());
        },

        prev: () => {
          if (!game) return;
          wantMusic = true;
          tryStartMusic();
          const idx = game.getLevelIndex() | 0;
          const cnt = Math.max(1, game.getLevelCount() | 0);
          game.loadLevel(((idx - 1 + cnt) % cnt) | 0);
          console.log("[dbg] prevLevel ->", game.getLevelIndex(), "/", game.getLevelCount());
        },

        reload: () => {
          if (!game) return;
          wantMusic = true;
          tryStartMusic();
          game.loadLevel(game.getLevelIndex());
          console.log("[dbg] reload ->", game.getLevelIndex(), "/", game.getLevelCount());
        },

        invert: () => {
          if (!game) return;
          game.toggleInvert();
        },

        music: (on: boolean) => {
          wantMusic = !!on;
          if (!wantMusic) {
            music.stop({ fadeSec: 0.04 });
            winMusic.stop({ fadeSec: 0.04 });
          } else {
            tryStartMusic();
          }
          console.log("[dbg] music:", wantMusic ? "on" : "off");
        },
      };

      console.log(
        "[dbg] ready: try dbg.info(), dbg.next(), dbg.prev(), dbg.level(n), dbg.reload()"
      );
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

    if (elapsed >= FRAME_MIN_TIME) {
      const dt = Math.min(0.1, elapsed / 1000);
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
