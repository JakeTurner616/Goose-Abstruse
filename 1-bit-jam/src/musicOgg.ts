// src/musicOgg.ts
export type OggMusic = {
  userGesture(): void;

  load(url: string): Promise<void>;
  play(opts?: { loop?: boolean; restart?: boolean }): void;
  stop(opts?: { fadeSec?: number }): void;

  setVolume(v: number): void; // 0..1
  setMuted(m: boolean): void;

  isLoaded(): boolean;
  isPlaying(): boolean;
};

type CreateOggMusicOpts = {
  volume?: number; // 0..1
  muted?: boolean;
  // If you already have an AudioContext you want to share, pass it here.
  // Otherwise we create our own.
  ctx?: AudioContext;
};

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);

export function createOggMusic(opts: CreateOggMusicOpts = {}): OggMusic {
  const ctx =
    opts.ctx ??
    new (window.AudioContext || (window as any).webkitAudioContext)({
      latencyHint: "interactive",
    });

  const master = ctx.createGain();
  master.gain.value = clamp01(opts.volume ?? 1);
  master.connect(ctx.destination);

  let muted = !!opts.muted;
  let vol = clamp01(opts.volume ?? 1);
  let buf: AudioBuffer | null = null;

  let src: AudioBufferSourceNode | null = null;
  let playing = false;

  // Small fade node (so stop can be click-free even on short loops)
  const musicGain = ctx.createGain();
  musicGain.gain.value = muted ? 0 : vol;
  musicGain.connect(master);

  function applyGainNow() {
    musicGain.gain.setValueAtTime(muted ? 0 : vol, ctx.currentTime);
  }

  function killSource() {
    if (!src) return;
    try {
      src.onended = null;
      src.stop();
    } catch {}
    try {
      src.disconnect();
    } catch {}
    src = null;
    playing = false;
  }

  async function load(url: string) {
    // Decode once; OGG decode must happen in AudioContext.
    const res = await fetch(url);
    if (!res.ok) throw new Error(`music load failed (${res.status}) for ${url}`);
    const ab = await res.arrayBuffer();

    // decodeAudioData has both promise + callback variants depending on browser
    buf = await new Promise<AudioBuffer>((resolve, reject) => {
      const p = (ctx as any).decodeAudioData(ab, resolve, reject);
      if (p && typeof p.then === "function") p.then(resolve, reject);
    });
  }

  function play(opts2?: { loop?: boolean; restart?: boolean }) {
    if (!buf) return;

    // Some browsers require ctx.resume() after a user gesture.
    // We try; if it fails, no big deal.
    if (ctx.state !== "running") {
      void ctx.resume().catch(() => {});
    }

    const loop = opts2?.loop ?? true;
    const restart = opts2?.restart ?? true;

    if (playing) {
      if (!restart) return;
      killSource();
    }

    const s = ctx.createBufferSource();
    s.buffer = buf;
    s.loop = loop;
    s.connect(musicGain);
    s.onended = () => {
      // If it ended naturally (non-loop), reflect state.
      if (src === s) {
        src = null;
        playing = false;
      }
    };

    src = s;
    playing = true;
    applyGainNow();

    try {
      s.start();
    } catch {
      // If start fails (rare), mark not playing
      src = null;
      playing = false;
    }
  }

  function stop(opts2?: { fadeSec?: number }) {
    if (!src) return;

    const fadeSec = Math.max(0, opts2?.fadeSec ?? 0);
    if (fadeSec <= 0) {
      killSource();
      return;
    }

    const t0 = ctx.currentTime;
    const t1 = t0 + fadeSec;

    // Fade out and then stop
    musicGain.gain.cancelScheduledValues(t0);
    musicGain.gain.setValueAtTime(musicGain.gain.value, t0);
    musicGain.gain.linearRampToValueAtTime(0, t1);

    const s = src;
    // Schedule stop slightly after fade completes
    try {
      s.stop(t1 + 0.01);
    } catch {
      killSource();
    }
  }

  function setVolume(v: number) {
    vol = clamp01(v);
    applyGainNow();
  }

  function setMuted(m: boolean) {
    muted = !!m;
    applyGainNow();
  }

  function userGesture() {
    if (ctx.state !== "running") {
      void ctx.resume().catch(() => {});
    }
  }

  return {
    userGesture,
    load,
    play,
    stop,
    setVolume,
    setMuted,
    isLoaded: () => !!buf,
    isPlaying: () => playing,
  };
}
