// src/soundBank.ts
import type { SoundSystem } from "./sound";

export type SoundDef = any;

export type SoundBank = {
  defs: Record<string, SoundDef>;
  play(name: string, opts?: { volume?: number; detune?: number; minGapMs?: number }): void;
};

async function fetchJson(url: string) {
  const r = await fetch(url, { cache: "force-cache" });
  if (!r.ok) throw new Error(`Failed to load ${url} (${r.status})`);
  return r.json();
}

/**
 * Load a set of SFX json files from /public.
 * Example usage:
 *   const bank = await loadSoundBank(sfx, {
 *     jump: "/Sfx/jump.json",
 *     keyPickup: "/Sfx/keyPickup.json",
 *   });
 */
export async function loadSoundBank(
  sfx: SoundSystem,
  paths: Record<string, string>
): Promise<SoundBank> {
  const entries = await Promise.all(
    Object.entries(paths).map(async ([name, url]) => [name, await fetchJson(url)] as const)
  );

  const defs: Record<string, SoundDef> = Object.fromEntries(entries);

  return {
    defs,
    play(name, opts) {
      const def = defs[name];
      if (!def) return;
      sfx.playJson(name, def, opts);
    },
  };
}
