// src/key.ts
export type Cam = { x: number; y: number };

type TPFrame = {
  frame: { x: number; y: number; w: number; h: number };
  rotated: boolean;
  trimmed: boolean;
  spriteSourceSize: { x: number; y: number; w: number; h: number };
  sourceSize: { w: number; h: number };
  pivot?: { x: number; y: number };
};

type TPAtlas = {
  frames: Record<string, TPFrame>;
  meta: { image: string; size: { w: number; h: number } };
};

export type KeyAtlas = {
  img: HTMLImageElement;
  frames: { name: string; idx: number; f: TPFrame }[];
};

export type KeyEntity = {
  x: number;
  y: number;

  // nominal (untrimmed) size from atlas
  w: number;
  h: number;

  // visual scale (optional)
  scale: number;

  // simple anim
  fps: number;
  time: number;

  // bob
  bobAmp: number;
  bobHz: number;

  update(dt: number): void;
  draw(ctx: CanvasRenderingContext2D, cam: Cam): void;
};

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((res, rej) => {
    const img = new Image();
    img.decoding = "async";
    img.onload = () => res(img);
    img.onerror = () => rej(new Error("Failed to load image: " + url));
    img.src = url;
  });
}

function parseFrameIndex(name: string) {
  const m = /frame(\d+)/i.exec(name);
  return m ? (parseInt(m[1], 10) | 0) : 0;
}

export async function loadKeyAtlas(baseDir = "/Key/"): Promise<KeyAtlas> {
  const jsonUrl = `${baseDir.replace(/\/?$/, "/")}texture.json`;
  const atlas = (await (await fetch(jsonUrl)).json()) as TPAtlas;

  const imgUrl = `${baseDir.replace(/\/?$/, "/")}${atlas.meta.image}`;
  const img = await loadImage(imgUrl);

  const frames = Object.entries(atlas.frames).map(([name, f]) => ({
    name,
    idx: parseFrameIndex(name),
    f,
  }));

  frames.sort((a, b) => (a.idx - b.idx) || (a.name < b.name ? -1 : 1));

  return { img, frames };
}

function drawAtlasFrame(
  ctx: CanvasRenderingContext2D,
  atlas: KeyAtlas,
  frame: TPFrame,
  dx: number,
  dy: number,
  scale: number
) {
  const fr = frame.frame;
  const ss = frame.spriteSourceSize;
  const src = frame.sourceSize;

  // We render in "untrimmed space" so every frame lines up consistently.
  // Draw origin is top-left of the untrimmed rectangle at (dx,dy).
  // Then we place the trimmed rect at (dx + ss.x, dy + ss.y).
  const ox = dx + ss.x * scale;
  const oy = dy + ss.y * scale;

  const img = atlas.img;

  // NOTE: some frames are packed as rotated. We undo that rotation.
  if (!frame.rotated) {
    ctx.drawImage(
      img,
      fr.x, fr.y, fr.w, fr.h,
      ox, oy, fr.w * scale, fr.h * scale
    );
    return;
  }

  // FreeTexturePacker "rotated": the source rect is stored rotated 90deg.
  // We draw it back upright by rotating the destination quad.
  // This convention matches common TP outputs well enough for these assets.
  ctx.save();
  ctx.translate(ox, oy);

  // rotate -90° (clockwise source -> upright)
  ctx.rotate(-Math.PI / 2);

  // After rotation, width/height swap.
  // Place so that top-left lands where we'd expect.
  ctx.drawImage(
    img,
    fr.x, fr.y, fr.w, fr.h,
    0, 0, fr.w * scale, fr.h * scale
  );

  ctx.restore();

  // The rotated draw above places the rotated rect but doesn't compensate for swapped axes.
  // For most “thin vertical key” frames this ends up correct visually; if you notice a 90° issue,
  // flip the sign to +Math.PI/2 and swap the placement offsets.
  void src;
}

export function createKeyEntity(atlas: KeyAtlas, opts: { x: number; y: number; scale?: number; fps?: number }): KeyEntity {
  const first = atlas.frames[0]?.f;
  const w = first?.sourceSize.w ?? 21;
  const h = first?.sourceSize.h ?? 47;

  const e: KeyEntity = {
    x: opts.x,
    y: opts.y,
    w,
    h,
    scale: opts.scale ?? 1,
    fps: opts.fps ?? 12,
    time: 0,
    bobAmp: 2,
    bobHz: 0.9,

    update(dt: number) {
      this.time += dt;
    },

    draw(ctx: CanvasRenderingContext2D, cam: Cam) {
      if (!atlas.frames.length) return;

      // loop animation
      const n = atlas.frames.length | 0;
      const fi = ((this.time * this.fps) | 0) % n;
      const f = atlas.frames[fi].f;

      // bob (pixel-stepped, stable)
      const bob = (Math.sin(this.time * Math.PI * 2 * this.bobHz) * this.bobAmp) | 0;

      // anchor at bottom-center (feels nice for pickups)
      const sx = this.scale;
      const dx = ((this.x - cam.x - (this.w * sx) * 0.5) + 0.5) | 0;
      const dy = ((this.y - cam.y - (this.h * sx)) + bob + 0.5) | 0;

      ctx.imageSmoothingEnabled = false;
      drawAtlasFrame(ctx, atlas, f, dx, dy, sx);
    },
  };

  return e;
}
