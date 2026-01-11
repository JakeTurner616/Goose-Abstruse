// src/game/sequences.ts
import { snapToPixel } from "./pixel";
import type { Player } from "../player";

export type SequenceMode = "normal" | "dead" | "win";

export type SequenceController = {
  resetAll(): void;

  beginWin(): void;
  beginDeath(): void;

  get mode(): SequenceMode;
  get winT(): number;

  /**
   * Advances timers and triggers callbacks when the hold completes.
   * Returns current mode after ticking.
   */
  update(dt: number): SequenceMode;
};

export type CreateSequenceControllerOpts = {
  winHoldSec: number;
  deathHoldSec: number;

  getAllEntities(): Player[];

  // UI hooks
  setUiMessage(msg: string): void;
  clearUi(): void;

  // SFX hooks (called once per sequence)
  playWinSfx(): void;
  playDeathSfx(): void;

  // Actions when timers finish
  onWinDone(): void;
  onDeathDone(): void;
};

export function createSequenceController(opts: CreateSequenceControllerOpts): SequenceController {
  const {
    winHoldSec,
    deathHoldSec,
    getAllEntities,
    setUiMessage,
    clearUi,
    playWinSfx,
    playDeathSfx,
    onWinDone,
    onDeathDone,
  } = opts;

  let mode: SequenceMode = "normal";

  let winT = 0;
  let winPlayed = false;

  let deadT = 0;
  let deadPlayed = false;

  function freezeAll() {
    const all = getAllEntities();
    for (const e of all) {
      e.vx = 0;
      e.vy = 0;
      snapToPixel(e);
    }
  }

  function resetAll() {
    mode = "normal";
    winT = 0;
    winPlayed = false;
    deadT = 0;
    deadPlayed = false;
  }

  function beginWin() {
    if (mode === "win") return;
    mode = "win";
    winT = 0;
    winPlayed = false;
    freezeAll();
    setUiMessage("LEVEL COMPLETE!");
  }

  function beginDeath() {
    if (mode === "dead") return;
    mode = "dead";
    deadT = 0;
    deadPlayed = false;
    freezeAll();
    setUiMessage("OUCH!");
  }

  function update(dt: number): SequenceMode {
    if (mode === "dead") {
      deadT += dt;

      if (!deadPlayed) {
        deadPlayed = true;
        playDeathSfx();
      }

      if (deadT >= deathHoldSec) {
        clearUi();
        onDeathDone();
      }

      return mode;
    }

    if (mode === "win") {
      winT += dt;

      if (!winPlayed) {
        winPlayed = true;
        playWinSfx();
      }

      if (winT >= winHoldSec) {
        clearUi();
        onWinDone();
      }

      return mode;
    }

    return mode;
  }

  return {
    resetAll,
    beginWin,
    beginDeath,
    get mode() {
      return mode;
    },
    get winT() {
      return winT;
    },
    update,
  };
}
