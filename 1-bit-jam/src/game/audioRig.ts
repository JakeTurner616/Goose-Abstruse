// src/game/audioRig.ts
import type { SoundSystem } from "../sound";
import { createSoundSystem } from "../sound";
import { loadSoundBank, type SoundBank } from "../soundBank";
import { assetUrl } from "../assetUrl";

export type PlayOpts = { volume?: number; detune?: number; minGapMs?: number };

// Only these two are external jsfxr JSON assets.
// Everything else uses built-in presets.
const SFX_PATHS: Record<string, string> = {
  jump: assetUrl("Sounds/jump.json"),
  death: assetUrl("Sounds/laserShoot.json"),
};

export function createAudioRig(injected?: SoundSystem) {
  const sfx: SoundSystem = injected ?? createSoundSystem({ volume: 0.15 });
  let bank: SoundBank | null = null;

  // Load only jump + death from the bank. If this fails (missing files), we still work via presets.
  loadSoundBank(sfx, SFX_PATHS)
    .then((b) => (bank = b))
    .catch(() => (bank = null));

  function playDeath(opts2?: PlayOpts) {
    // Hard guarantee: always make a sound on death even if bank is missing / malformed.
    sfx.playPreset("laserShoot", {
      ...(opts2 || {}),
      volume: opts2?.volume ?? 0.75,
      detune: opts2?.detune ?? -80,
      minGapMs: opts2?.minGapMs ?? 140,
    });
  }

  function presetFallback(name: string, opts2?: PlayOpts) {
    if (name === "jump") sfx.playPreset("jump", opts2);
    else if (name === "keyPickup") sfx.playPreset("pickupCoin", opts2);
    else if (name === "doorOpen") sfx.playPreset("powerUp", opts2);
    else if (name === "bump") sfx.playPreset("hitHurt", opts2);
    else if (name === "invert") sfx.playPreset("blipSelect", opts2);
    else if (name === "uiConfirm") sfx.playPreset("powerUp", opts2);
    else if (name === "uiClick") sfx.playPreset("click", opts2);
    else sfx.playPreset("click", opts2);
  }

  function tryBankPlay(name: string, opts2?: PlayOpts): boolean {
    if (!bank) return false;

    // Only ever attempt bank playback for the two external clips.
    if (name !== "jump" && name !== "death") return false;

    try {
      // Some bank implementations store definitions under defs; if missing, don't call play().
      if ((bank as any).defs && !(bank as any).defs[name]) return false;
      bank.play(name, opts2);
      return true;
    } catch {
      return false;
    }
  }

  function play(name: string, opts2?: PlayOpts) {
    // Special-case death so it can never silently fail.
    if (name === "death") {
      // If bank has it, it may play; but we STILL guarantee a sound.
      if (!tryBankPlay("death", opts2)) playDeath(opts2);
      else playDeath(opts2); // guarantee (keeps your original behavior)
      return;
    }

    // Jump: prefer bank if available; otherwise preset.
    if (name === "jump") {
      if (!tryBankPlay("jump", opts2)) presetFallback("jump", opts2);
      return;
    }

    // Everything else is presets only.
    presetFallback(name, opts2);
  }

  return { sfx, play };
}
