// src/sound.ts
// jsfxr-based sound system with caching and volume/mute control.
// Works with presets, JSON defs (from sfxr.me "Serialize"), and base58 strings.
//
// Vite runs deps in strict-mode ESM wrappers. Some jsfxr/riffwave bundles do
// assignments like `sfxr = ...` / `RIFFWAVE = ...` without declaring them,
// which throws "assignment to undeclared variable ...".
// Fix: create real global `var sfxr; var RIFFWAVE;` bindings BEFORE importing jsfxr.

export type JsfxrPreset =
  | "pickupCoin"
  | "laserShoot"
  | "explosion"
  | "powerUp"
  | "hitHurt"
  | "jump"
  | "blipSelect"
  | "synth"
  | "tone"
  | "click"
  | "random";

export type SoundSystem = {
  userGesture(): void;

  playPreset(name: JsfxrPreset, opts?: { volume?: number; detune?: number; minGapMs?: number }): void;
  playJson(tag: string, soundJson: any, opts?: { volume?: number; detune?: number; minGapMs?: number }): void;
  playB58(tag: string, b58: string, opts?: { volume?: number; detune?: number; minGapMs?: number }): void;

  setVolume(v: number): void;
  getVolume(): number;

  setMuted(m: boolean): void;
  isMuted(): boolean;
};

type JsfxrSoundObj = {
  oldParams?: boolean;

  wave_type?: number;

  p_env_attack?: number;
  p_env_sustain?: number;
  p_env_punch?: number;
  p_env_decay?: number;

  p_base_freq?: number;
  p_freq_limit?: number;
  p_freq_ramp?: number;
  p_freq_dramp?: number;

  p_vib_strength?: number;
  p_vib_speed?: number;

  p_arp_mod?: number;
  p_arp_speed?: number;

  p_duty?: number;
  p_duty_ramp?: number;

  p_repeat_speed?: number;

  p_pha_offset?: number;
  p_pha_ramp?: number;

  p_lpf_freq?: number;
  p_lpf_ramp?: number;
  p_lpf_resonance?: number;

  p_hpf_freq?: number;
  p_hpf_ramp?: number;

  sound_vol?: number;
  sample_rate?: number;
  sample_size?: number;
};

type JsfxrNS = {
  generate: (preset: string) => any;
  toBuffer: (sound: any) => any;
  b58decode: (s: string) => any;
};

function clamp(v: number, lo: number, hi: number) {
  return v < lo ? lo : v > hi ? hi : v;
}

/**
 * Creates classic-script global `var` bindings for legacy libs that assign to
 * undeclared globals (breaks under strict-mode module wrappers).
 */
function ensureLegacyGlobalVarBindings() {
  const g = globalThis as any;
  if (g.__jsfxrLegacyVarBindingsDone) return;

  if (typeof document === "undefined") {
    g.__jsfxrLegacyVarBindingsDone = true;
    return;
  }

  const s = document.createElement("script");
  s.text = "var sfxr; var RIFFWAVE;";
  document.head.appendChild(s);

  g.__jsfxrLegacyVarBindingsDone = true;
}

async function loadJsfxr(): Promise<JsfxrNS> {
  ensureLegacyGlobalVarBindings();

  const mod: any = await import("jsfxr");
  const ns: any = mod?.sfxr ?? mod?.default?.sfxr ?? mod?.default ?? mod;

  if (!ns?.toBuffer || !ns?.generate) {
    throw new Error("jsfxr: could not resolve sfxr namespace (missing toBuffer/generate)");
  }
  return ns as JsfxrNS;
}

function num(v: any, fallback = 0): number {
  const n = typeof v === "number" ? v : typeof v === "string" ? +v : NaN;
  return Number.isFinite(n) ? n : fallback;
}

/**
 * jsfxr accepts the classic “serialize” object (snake_case keys),
 * but exporters sometimes wrap it or store it as an array.
 */
function normalizeSoundJson(input: any): JsfxrSoundObj {
  let s: any = input;

  if (s && typeof s === "object") {
    if (s.sound && typeof s.sound === "object") s = s.sound;
    else if (s.params && typeof s.params === "object") s = s.params;
    else if (s.data && typeof s.data === "object") s = s.data;
  }

  if (Array.isArray(s)) {
    const a = s;
    const obj: JsfxrSoundObj = {
      oldParams: true,
      wave_type: (num(a[0]) | 0),

      p_env_attack: num(a[1]),
      p_env_sustain: num(a[2]),
      p_env_punch: num(a[3]),
      p_env_decay: num(a[4]),

      p_base_freq: num(a[5]),
      p_freq_limit: num(a[6]),
      p_freq_ramp: num(a[7]),
      p_freq_dramp: num(a[8]),

      p_vib_strength: num(a[9]),
      p_vib_speed: num(a[10]),

      p_arp_mod: num(a[11]),
      p_arp_speed: num(a[12]),

      p_duty: num(a[13]),
      p_duty_ramp: num(a[14]),

      p_repeat_speed: num(a[15]),

      p_pha_offset: num(a[16]),
      p_pha_ramp: num(a[17]),

      p_lpf_freq: num(a[18], 1),
      p_lpf_ramp: num(a[19]),
      p_lpf_resonance: num(a[20]),

      p_hpf_freq: num(a[21]),
      p_hpf_ramp: num(a[22]),

      sound_vol: num(a[23], 0.5),
      sample_rate: (num(a[24], 44100) | 0) || 44100,
      sample_size: (num(a[25], 8) | 0) || 8,
    };
    return obj;
  }

  const o: any = (s && typeof s === "object") ? s : {};

  return {
    oldParams: !!(o.oldParams ?? true),
    wave_type: (num(o.wave_type, 0) | 0),

    p_env_attack: num(o.p_env_attack),
    p_env_sustain: num(o.p_env_sustain),
    p_env_punch: num(o.p_env_punch),
    p_env_decay: num(o.p_env_decay),

    p_base_freq: num(o.p_base_freq),
    p_freq_limit: num(o.p_freq_limit),
    p_freq_ramp: num(o.p_freq_ramp),
    p_freq_dramp: num(o.p_freq_dramp),

    p_vib_strength: num(o.p_vib_strength),
    p_vib_speed: num(o.p_vib_speed),

    p_arp_mod: num(o.p_arp_mod),
    p_arp_speed: num(o.p_arp_speed),

    p_duty: num(o.p_duty),
    p_duty_ramp: num(o.p_duty_ramp),

    p_repeat_speed: num(o.p_repeat_speed),

    p_pha_offset: num(o.p_pha_offset),
    p_pha_ramp: num(o.p_pha_ramp),

    p_lpf_freq: num(o.p_lpf_freq, 1),
    p_lpf_ramp: num(o.p_lpf_ramp),
    p_lpf_resonance: num(o.p_lpf_resonance),

    p_hpf_freq: num(o.p_hpf_freq),
    p_hpf_ramp: num(o.p_hpf_ramp),

    sound_vol: num(o.sound_vol, 0.5),
    sample_rate: (num(o.sample_rate, 44100) | 0) || 44100,
    sample_size: (num(o.sample_size, 8) | 0) || 8,
  };
}

/**
 * jsfxr output is often integer PCM:
 * - Uint8Array: 0..255 (8-bit unsigned)
 * - Int16Array: -32768..32767 (16-bit signed)
 * - plain JS arrays of ints
 * WebAudio wants Float32 samples in [-1..+1].
 */
function normalizeSamples(buf: any): Float32Array {
  // common wrapper shapes
  if (buf && typeof buf === "object") {
    if (buf.samples) buf = buf.samples;
    else if (Array.isArray(buf.buffer)) buf = buf.buffer;
    else if (buf.buffer && (buf.buffer instanceof ArrayBuffer)) {
      // typed array already, handled below
    }
  }

  // already float samples
  if (buf instanceof Float32Array) return buf;

  // Int16 PCM
  if (buf instanceof Int16Array) {
    const out = new Float32Array(buf.length);
    for (let i = 0; i < buf.length; i++) out[i] = buf[i] / 32768;
    return out;
  }

  // Uint8 PCM (8-bit unsigned)
  if (buf instanceof Uint8Array) {
    const out = new Float32Array(buf.length);
    for (let i = 0; i < buf.length; i++) out[i] = (buf[i] - 128) / 128;
    return out;
  }

  // generic array-like
  const n = buf?.length | 0;
  if (n <= 0) return new Float32Array(0);

  // First pass: copy numbers + find max magnitude
  const tmp = new Float32Array(n);
  let maxAbs = 0;
  let minV = Infinity;
  let maxV = -Infinity;

  for (let i = 0; i < n; i++) {
    const v = +buf[i] || 0;
    tmp[i] = v;
    const av = v < 0 ? -v : v;
    if (av > maxAbs) maxAbs = av;
    if (v < minV) minV = v;
    if (v > maxV) maxV = v;
  }

  // Heuristic scaling:
  // - if values look like 0..255 => treat as unsigned 8-bit
  // - else if they look like int16 => scale by 32768
  // - else if already small => pass through
  if (minV >= 0 && maxV <= 255 && maxAbs > 1.5) {
    for (let i = 0; i < n; i++) tmp[i] = (tmp[i] - 128) / 128;
    return tmp;
  }

  if (maxAbs > 2048) {
    for (let i = 0; i < n; i++) tmp[i] = tmp[i] / 32768;
    return tmp;
  }

  if (maxAbs > 1.5) {
    // last-resort: normalize by observed peak
    const inv = maxAbs ? 1 / maxAbs : 1;
    for (let i = 0; i < n; i++) tmp[i] = tmp[i] * inv;
    return tmp;
  }

  return tmp;
}

export function createSoundSystem(opts?: { volume?: number; muted?: boolean }): SoundSystem {
  let volume = clamp(opts?.volume ?? 0.35, 0, 1);
  let muted = !!opts?.muted;

  let ctx: AudioContext | null = null;
  let master: GainNode | null = null;

  let jsfxr: JsfxrNS | null = null;
  let jsfxrPromise: Promise<JsfxrNS> | null = null;

  const cache = new Map<string, AudioBuffer>();
  const lastPlayMs = new Map<string, number>();

  function ensureCtx() {
    if (ctx) return;
    const AC = (window.AudioContext || (window as any).webkitAudioContext) as typeof AudioContext;
    ctx = new AC();
    master = ctx.createGain();
    master.gain.value = muted ? 0 : volume;
    master.connect(ctx.destination);
  }

  function ensureJsfxr() {
    if (jsfxr) return Promise.resolve(jsfxr);
    if (!jsfxrPromise) jsfxrPromise = loadJsfxr().then((ns) => (jsfxr = ns));
    return jsfxrPromise;
  }

  function resume() {
    ensureCtx();
    if (ctx && ctx.state !== "running") void ctx.resume().catch(() => {});
  }

  function setMasterGain() {
    if (!master) return;
    master.gain.value = muted ? 0 : volume;
  }

  function canPlay(tag: string, minGapMs: number) {
    const now = performance.now();
    const last = lastPlayMs.get(tag) ?? -1e9;
    if (now - last < minGapMs) return false;
    lastPlayMs.set(tag, now);
    return true;
  }

  function makeAudioBuffer(samples: Float32Array, sampleRate: number) {
    ensureCtx();
    if (!ctx) throw new Error("AudioContext not available");
    const ab = ctx.createBuffer(1, samples.length, sampleRate);
    ab.getChannelData(0).set(samples);
    return ab;
  }

  function playBuffer(ab: AudioBuffer, opts2?: { volume?: number; detune?: number }) {
    if (!ctx || !master || muted) return;

    const src = ctx.createBufferSource();
    src.buffer = ab;
    if (opts2?.detune) src.detune.value = opts2.detune;

    // opts2.volume is a multiplier on top of:
    // - soundJson.sound_vol (baked into the buffer by jsfxr)
    // - master volume
    if (opts2?.volume != null && opts2.volume !== 1) {
      const g = ctx.createGain();
      g.gain.value = clamp(opts2.volume, 0, 2);
      src.connect(g);
      g.connect(master);
    } else {
      src.connect(master);
    }

    src.start();
  }

  async function decodeSoundObjToBuffer(cacheKey: string, soundObj: any): Promise<AudioBuffer> {
    const cached = cache.get(cacheKey);
    if (cached) return cached;

    const ns = await ensureJsfxr();
    const normalized = normalizeSoundJson(soundObj);

    const raw = ns.toBuffer(normalized);
    const samples = normalizeSamples(raw);
    const sr = (normalized.sample_rate | 0) || 44100;

    const ab = makeAudioBuffer(samples, sr);
    cache.set(cacheKey, ab);
    return ab;
  }

  return {
    userGesture() {
      resume();
    },

    playPreset(name, opts2) {
      const minGapMs = opts2?.minGapMs ?? 35;
      const tag = `preset:${name}`;
      if (!canPlay(tag, minGapMs)) return;

      resume();
      void ensureJsfxr().then(async (ns) => {
        const soundObj = ns.generate(name);
        const ab = await decodeSoundObjToBuffer(tag, soundObj);
        resume();
        playBuffer(ab, opts2);
      });
    },

    playJson(tag, soundJson, opts2) {
      const minGapMs = opts2?.minGapMs ?? 35;
      const t = `json:${tag}`;
      if (!canPlay(t, minGapMs)) return;

      resume();
      void decodeSoundObjToBuffer(t, soundJson).then((ab) => {
        resume();
        playBuffer(ab, opts2);
      });
    },

    playB58(tag, b58, opts2) {
      const minGapMs = opts2?.minGapMs ?? 35;
      const t = `b58:${tag}`;
      if (!canPlay(t, minGapMs)) return;

      resume();
      void ensureJsfxr().then(async (ns) => {
        const soundObj = ns.b58decode(b58);
        const ab = await decodeSoundObjToBuffer(t, soundObj);
        resume();
        playBuffer(ab, opts2);
      });
    },

    setVolume(v) {
      volume = clamp(v, 0, 1);
      setMasterGain();
    },

    getVolume() {
      return volume;
    },

    setMuted(m) {
      muted = !!m;
      setMasterGain();
    },

    isMuted() {
      return muted;
    },
  };
}
