// src/game/audioRig.ts
import type { SoundSystem } from "../sound";
import { createSoundSystem } from "../sound";
import { loadSoundBank, type SoundBank } from "../soundBank";

export type PlayOpts = { volume?: number; detune?: number; minGapMs?: number };

const SFX_PATHS: Record<string, string> = {
  uiClick: "/Sounds/uiClick.json",
  uiConfirm: "/Sounds/uiConfirm.json",
  invert: "/Sounds/invert.json",
  jump: "/Sounds/jump.json",
  bump: "/Sounds/bump.json",
  keyPickup: "/Sounds/keyPickup.json",
  doorOpen: "/Sounds/doorOpen.json",

  // kept loaded so you can still use it later if you want,
  // but "death" playback below will use the preset to avoid silent failures.
  death: "/Sounds/laserShoot.json",
};

export function createAudioRig(injected?: SoundSystem) {
  const sfx: SoundSystem = injected ?? createSoundSystem({ volume: 0.15 });
  let bank: SoundBank | null = null;

  loadSoundBank(sfx, SFX_PATHS)
    .then((b) => (bank = b))
    .catch(() => (bank = null));

  function playDeath(opts2?: PlayOpts) {
    // Hard guarantee: always make a sound on death.
    // (Avoids SoundBank "missing key => silent return" and any weird JSON shape issues.)
    sfx.playPreset("laserShoot", {
      ...(opts2 || {}),
      volume: opts2?.volume ?? 0.75,
      detune: opts2?.detune ?? -80,
      minGapMs: opts2?.minGapMs ?? 140,
    });
  }

  function fallbackPlay(name: string, opts2?: PlayOpts) {
    if (name === "jump") sfx.playPreset("jump", opts2);
    else if (name === "keyPickup") sfx.playPreset("pickupCoin", opts2);
    else if (name === "doorOpen") sfx.playPreset("powerUp", opts2);
    else if (name === "bump") sfx.playPreset("hitHurt", opts2);
    else if (name === "invert") sfx.playPreset("blipSelect", opts2);
    else if (name === "uiConfirm") sfx.playPreset("powerUp", opts2);
    else if (name === "death") playDeath(opts2);
    else sfx.playPreset("click", opts2);
  }

  function play(name: string, opts2?: PlayOpts) {
    // Special-case death so it can never silently fail.
    if (name === "death") {
      playDeath(opts2);
      return;
    }

    if (!bank) {
      fallbackPlay(name, opts2);
      return;
    }

    try {
      // This can still be silent if the key doesn't exist (SoundBank.play returns),
      // so we defensively verify the key exists before calling play().
      if (!bank.defs || !bank.defs[name]) {
        fallbackPlay(name, opts2);
        return;
      }
      bank.play(name, opts2);
    } catch {
      fallbackPlay(name, opts2);
    }
  }

  return { sfx, play };
}
