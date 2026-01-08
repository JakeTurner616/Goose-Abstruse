// src/tiled.ts
export type TiledMap = {
  w: number; h: number;
  tw: number; th: number;

  // Named layers (CSV gids, includes flags)
  layers: Record<string, Uint32Array>;

  // Convenience handles
  tile: Uint32Array;
  collide: Uint32Array;
};

export type TileMask = {
  // one u32 per row; bit x set => solid pixel
  // NOTE: only supports tiles up to 32px wide
  rows: Uint32Array;
  w: number;
  h: number;
};

export type TileSet = {
  firstgid: number;
  img: HTMLImageElement;
  columns: number;
  tilecount: number;
  tw: number; th: number;

  // Pixel masks for each local tile id (0..tilecount-1)
  masks: TileMask[];
};

export type TiledWorld = { map: TiledMap; ts: TileSet };

const FLIP_H = 0x80000000 >>> 0;
const FLIP_V = 0x40000000 >>> 0;
const FLIP_D = 0x20000000 >>> 0;
export const GID_MASK = 0x1fffffff >>> 0;

// -----------------------------------------------------------------------------
// Masking knobs
// -----------------------------------------------------------------------------
// We auto-decide “solid = dark” vs “solid = light” per tile.
// These thresholds define how extreme the pixel must be to count as solid.
const SOLID_LIGHT_LUMA = 190;        // pixels >= this are “solid” if tile is light-ink style
const SOLID_DARK_LUMA = 70;          // pixels <= this are “solid” if tile is dark-ink style
const TILE_ALPHA_CUTOFF = 8;         // ignore near-transparent pixels

const joinUrl = (b: string, r: string) => new URL(r, new URL(b, location.href)).toString();

function parseXml(txt: string): Document {
  const doc = new DOMParser().parseFromString(txt, "application/xml");
  if (doc.getElementsByTagName("parsererror")[0]) throw new Error("XML parse error");
  return doc;
}

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((res, rej) => {
    const img = new Image();
    img.decoding = "async";
    img.onload = () => res(img);
    img.onerror = () => rej(new Error("Failed to load image: " + url));
    img.src = url;
  });
}

function parseCsvToU32(csv: string, expected: number): Uint32Array {
  const out = new Uint32Array(expected);
  let n = 0, v = 0, inNum = false;

  for (let i = 0; i < csv.length; i++) {
    const c = csv.charCodeAt(i);
    if (c >= 48 && c <= 57) {
      v = v * 10 + (c - 48);
      inNum = true;
    } else if (inNum) {
      out[n++] = v >>> 0;
      if (n === expected) return out;
      v = 0; inNum = false;
    }
  }

  if (inNum && n < expected) out[n++] = v >>> 0;
  return out;
}

function getLayerData(layerEl: Element, w: number, h: number): Uint32Array {
  const dataEl = layerEl.getElementsByTagName("data")[0];
  if (!dataEl) throw new Error("TMX: <layer> missing <data>");
  if (dataEl.getAttribute("encoding") !== "csv") throw new Error("TMX: expected CSV encoding");
  const csv = (dataEl.textContent || "").trim();
  return parseCsvToU32(csv, w * h);
}

// -----------------------------------------------------------------------------
// Pixel masks (tileset) — AUTO polarity per tile
// -----------------------------------------------------------------------------
function luma(r: number, g: number, b: number) {
  return (77 * r + 150 * g + 29 * b) >> 8;
}

function buildTileMasks(
  img: HTMLImageElement,
  tw: number,
  th: number,
  columns: number,
  tilecount: number
): TileMask[] {
  if (tw > 32) throw new Error(`Tile pixel masks require tilewidth <= 32 (got ${tw})`);

  const c = document.createElement("canvas");
  c.width = img.width;
  c.height = img.height;

  const ctx = c.getContext("2d", { alpha: true })!;
  ctx.imageSmoothingEnabled = false;
  ctx.clearRect(0, 0, c.width, c.height);
  ctx.drawImage(img, 0, 0);

  const id = ctx.getImageData(0, 0, c.width, c.height);
  const d = id.data;

  const masks: TileMask[] = new Array(tilecount);

  for (let t = 0; t < tilecount; t++) {
    const sx = (t % columns) * tw;
    const sy = ((t / columns) | 0) * th;

    // First pass: compute avg luma of non-transparent pixels for this tile
    let sum = 0;
    let cnt = 0;

    for (let y = 0; y < th; y++) {
      const py = sy + y;
      for (let x = 0; x < tw; x++) {
        const px = sx + x;
        const i = ((py * c.width + px) << 2);
        const a = d[i + 3] | 0;
        if (a < TILE_ALPHA_CUTOFF) continue;
        sum += luma(d[i] | 0, d[i + 1] | 0, d[i + 2] | 0);
        cnt++;
      }
    }

    // Decide polarity:
    // - If the tile’s visible pixels are mostly dark, ground is likely the dark ink => solid = dark.
    // - If mostly light, ground is likely the light fill => solid = light.
    const avg = cnt ? (sum / cnt) : 0;
    const solidIsDark = avg < 128;

    const rows = new Uint32Array(th);
    let anyBits = false;

    for (let y = 0; y < th; y++) {
      let bits = 0 >>> 0;
      const py = sy + y;

      for (let x = 0; x < tw; x++) {
        const px = sx + x;
        const i = ((py * c.width + px) << 2);

        const a = d[i + 3] | 0;
        if (a < TILE_ALPHA_CUTOFF) continue;

        const L = luma(d[i] | 0, d[i + 1] | 0, d[i + 2] | 0);

        const solid = solidIsDark ? (L <= SOLID_DARK_LUMA) : (L >= SOLID_LIGHT_LUMA);
        if (solid) bits |= (1 << x) >>> 0;
      }

      rows[y] = bits >>> 0;
      if (bits) anyBits = true;
    }

    // Fallback: if thresholding produced nothing but the tile has opaque pixels,
    // treat opaque as solid (better to collide than to ghost through the map).
    if (!anyBits && cnt) {
      for (let y = 0; y < th; y++) {
        let bits = 0 >>> 0;
        const py = sy + y;

        for (let x = 0; x < tw; x++) {
          const px = sx + x;
          const i = ((py * c.width + px) << 2);
          const a = d[i + 3] | 0;
          if (a >= TILE_ALPHA_CUTOFF) bits |= (1 << x) >>> 0;
        }

        rows[y] = bits >>> 0;
      }
    }

    masks[t] = { rows, w: tw, h: th };
  }

  return masks;
}

// -----------------------------------------------------------------------------
// Tiled flip flags → map (u,v) in world-tile space to (uu,vv) in source-tile space.
// -----------------------------------------------------------------------------
function mapFlippedUV(u: number, v: number, w: number, h: number, flags: number) {
  const fh = (flags & FLIP_H) !== 0;
  const fv = (flags & FLIP_V) !== 0;
  const fd = (flags & FLIP_D) !== 0;

  let uu = u | 0;
  let vv = v | 0;

  if (fd) {
    const t = uu; uu = vv; vv = t;
  }
  if (fh) uu = (w - 1 - uu) | 0;
  if (fv) vv = (h - 1 - vv) | 0;

  return { uu, vv };
}

export function tileSolidPixel(ts: TileSet, gidRaw: number, u: number, v: number): boolean {
  const gid = (gidRaw & GID_MASK) >>> 0;
  if (gid === 0) return false;

  const local = (gid - ts.firstgid) | 0;
  if (local < 0 || local >= ts.tilecount) return false;

  if (u < 0 || v < 0 || u >= ts.tw || v >= ts.th) return false;

  const flags = gidRaw & (FLIP_H | FLIP_V | FLIP_D);
  const { uu, vv } = mapFlippedUV(u, v, ts.tw, ts.th, flags);

  if (uu < 0 || vv < 0 || uu >= ts.tw || vv >= ts.th) return false;

  const m = ts.masks[local];
  return ((m.rows[vv] >>> uu) & 1) !== 0;
}

export async function loadTiled(tmxUrl: string): Promise<TiledWorld> {
  const tmxText = await (await fetch(tmxUrl)).text();
  const tmx = parseXml(tmxText);

  const mapEl = tmx.getElementsByTagName("map")[0];
  if (!mapEl) throw new Error("TMX: missing <map>");

  const w = (mapEl.getAttribute("width")! | 0);
  const h = (mapEl.getAttribute("height")! | 0);
  const tw = (mapEl.getAttribute("tilewidth")! | 0);
  const th = (mapEl.getAttribute("tileheight")! | 0);

  const tilesetEl = tmx.getElementsByTagName("tileset")[0];
  if (!tilesetEl) throw new Error("TMX: missing <tileset>");

  const firstgid = (tilesetEl.getAttribute("firstgid")! | 0);
  const tsxRel = tilesetEl.getAttribute("source");
  if (!tsxRel) throw new Error("TMX: tileset source missing");

  const tsxUrl = joinUrl(tmxUrl, tsxRel);
  const tsxText = await (await fetch(tsxUrl)).text();
  const tsx = parseXml(tsxText);

  const tsxRoot = tsx.getElementsByTagName("tileset")[0];
  if (!tsxRoot) throw new Error("TSX: missing <tileset>");

  const tsTw = (tsxRoot.getAttribute("tilewidth")! | 0);
  const tsTh = (tsxRoot.getAttribute("tileheight")! | 0);
  const columns = (tsxRoot.getAttribute("columns")! | 0);
  const tilecount = (tsxRoot.getAttribute("tilecount")! | 0);

  const imgEl = tsx.getElementsByTagName("image")[0];
  if (!imgEl) throw new Error("TSX: missing <image>");

  const imgRel = imgEl.getAttribute("source");
  if (!imgRel) throw new Error("TSX: image source missing");

  const imgUrl = joinUrl(tsxUrl, imgRel);
  const img = await loadImage(imgUrl);

  const masks = buildTileMasks(img, tsTw, tsTh, columns, tilecount);

  // --- Layers
  const layers: Record<string, Uint32Array> = {};
  const layerEls = Array.from(tmx.getElementsByTagName("layer"));
  if (!layerEls.length) throw new Error("TMX: missing <layer>");

  let firstLayer: Uint32Array | null = null;

  for (const layerEl of layerEls) {
    const name = (layerEl.getAttribute("name") || "").trim() || `layer${Object.keys(layers).length}`;
    const data = getLayerData(layerEl, w, h);
    layers[name] = data;
    if (!firstLayer) firstLayer = data;
  }

  const tile = layers["tile"] ?? firstLayer!;
  const collide = layers["collide"] ?? new Uint32Array(w * h);

  return {
    map: { w, h, tw, th, layers, tile, collide },
    ts: { firstgid, img, columns, tilecount, tw: tsTw, th: tsTh, masks },
  };
}

export function drawTile(
  ctx: CanvasRenderingContext2D,
  ts: TileSet,
  gidRaw: number,
  dx: number,
  dy: number
) {
  const gid = (gidRaw & GID_MASK) >>> 0;
  if (gid === 0) return;

  const local = (gid - ts.firstgid) | 0;
  if (local < 0 || local >= ts.tilecount) return;

  const sx = ((local % ts.columns) * ts.tw) | 0;
  const sy = (((local / ts.columns) | 0) * ts.th) | 0;

  const flags = gidRaw & (FLIP_H | FLIP_V | FLIP_D);
  if (!flags) {
    ctx.drawImage(ts.img, sx, sy, ts.tw, ts.th, dx, dy, ts.tw, ts.th);
    return;
  }

  const cx = dx + (ts.tw >> 1);
  const cy = dy + (ts.th >> 1);

  ctx.save();
  ctx.translate(cx, cy);

  const fh = (flags & FLIP_H) !== 0;
  const fv = (flags & FLIP_V) !== 0;
  const fd = (flags & FLIP_D) !== 0;

  if (!fd) {
    ctx.scale(fh ? -1 : 1, fv ? -1 : 1);
  } else {
    ctx.rotate(Math.PI / 2);
    ctx.scale(fv ? -1 : 1, fh ? -1 : 1);
  }

  ctx.drawImage(ts.img, sx, sy, ts.tw, ts.th, -(ts.tw >> 1), -(ts.th >> 1), ts.tw, ts.th);
  ctx.restore();
}