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
};

export function createAudioRig(injected?: SoundSystem) {
  const sfx: SoundSystem = injected ?? createSoundSystem({ volume: 0.15 });
  let bank: SoundBank | null = null;

  loadSoundBank(sfx, SFX_PATHS)
    .then((b) => (bank = b))
    .catch(() => (bank = null));

  function fallbackPlay(name: string, opts2?: PlayOpts) {
    if (name === "jump") sfx.playPreset("jump", opts2);
    else if (name === "keyPickup") sfx.playPreset("pickupCoin", opts2);
    else if (name === "doorOpen") sfx.playPreset("powerUp", opts2);
    else if (name === "bump") sfx.playPreset("hitHurt", opts2);
    else if (name === "invert") sfx.playPreset("blipSelect", opts2);
    else if (name === "uiConfirm") sfx.playPreset("powerUp", opts2);
    else if (name === "death") sfx.playPreset("hitHurt", { ...(opts2 || {}), detune: -420, volume: 0.6 });
    else sfx.playPreset("click", opts2);
  }

  function play(name: string, opts2?: PlayOpts) {
    if (!bank) return fallbackPlay(name, opts2);
    try {
      bank.play(name, opts2);
    } catch {
      fallbackPlay(name, opts2);
    }
  }

  return { sfx, play };
}
