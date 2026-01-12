// src/tiled.ts
export type UiTrigger = {
  msg: string;
  // polygon points in world pixels (absolute)
  pts: { x: number; y: number }[];
  // quick reject in world pixels
  aabb: { x: number; y: number; w: number; h: number };
};

export type TiledMap = {
  w: number;
  h: number;
  tw: number;
  th: number;

  // Named layers (CSV gids, includes flags)
  layers: Record<string, Uint32Array>;

  // Convenience handles
  tile: Uint32Array;
  collide: Uint32Array;
  spawns: Uint32Array;

  // NEW: ui polygon triggers
  ui: UiTrigger[];
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
  tw: number;
  th: number;

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
const SOLID_LIGHT_LUMA = 190;
const SOLID_DARK_LUMA = 70;
const TILE_ALPHA_CUTOFF = 8;

const joinUrl = (b: string, r: string) => new URL(r, new URL(b, location.href)).toString();

function parseXml(txt: string): Document {
  const doc = new DOMParser().parseFromString(txt, "application/xml");
  if (doc.getElementsByTagName("parsererror")[0]) throw new Error("XML parse error");
  return doc;
}
function attrInt(el: Element, name: string, def = 0): number {
  const s = el.getAttribute(name);
  const n = s ? parseInt(s, 10) : def;
  return (n | 0) || def;
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
  let n = 0,
    v = 0,
    inNum = false;

  for (let i = 0; i < csv.length; i++) {
    const c = csv.charCodeAt(i);
    if (c >= 48 && c <= 57) {
      v = v * 10 + (c - 48);
      inNum = true;
    } else if (inNum) {
      out[n++] = v >>> 0;
      if (n === expected) return out;
      v = 0;
      inNum = false;
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
// Object layer parsing (ui polygons)
// -----------------------------------------------------------------------------
function readProperties(el: Element): Record<string, string> {
  const out: Record<string, string> = {};
  const propsEl = el.getElementsByTagName("properties")[0];
  if (!propsEl) return out;

  const props = Array.from(propsEl.getElementsByTagName("property"));
  for (const p of props) {
    const name = (p.getAttribute("name") || "").trim();
    if (!name) continue;
    const value = p.getAttribute("value");
    if (value != null) out[name] = value;
    else out[name] = (p.textContent || "").trim();
  }
  return out;
}

function parsePoints(pointsStr: string): { x: number; y: number }[] {
  // "x,y x,y ..."
  const pts: { x: number; y: number }[] = [];
  const parts = pointsStr.trim().split(/\s+/g);
  for (const part of parts) {
    const [xs, ys] = part.split(",");
    const x = Number(xs);
    const y = Number(ys);
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    pts.push({ x, y });
  }
  return pts;
}

function aabbFromPts(pts: { x: number; y: number }[]) {
  let minX = Infinity,
    minY = Infinity,
    maxX = -Infinity,
    maxY = -Infinity;
  for (const p of pts) {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }
  if (!Number.isFinite(minX)) return { x: 0, y: 0, w: 0, h: 0 };
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

function parseUiObjectLayer(tmx: Document): UiTrigger[] {
  const out: UiTrigger[] = [];

  const groups = Array.from(tmx.getElementsByTagName("objectgroup"));
  for (const g of groups) {
    const name = (g.getAttribute("name") || "").trim();
    if (name !== "ui") continue;

    const objects = Array.from(g.getElementsByTagName("object"));
    for (const obj of objects) {
      const props = readProperties(obj);
      const msg = (props["msg"] || "").trim();
      if (!msg) continue;

      const ox = Number(obj.getAttribute("x") || "0");
      const oy = Number(obj.getAttribute("y") || "0");
      if (!Number.isFinite(ox) || !Number.isFinite(oy)) continue;

      const polyEl = obj.getElementsByTagName("polygon")[0];
      if (!polyEl) continue;

      const pointsStr = polyEl.getAttribute("points") || "";
      const rel = parsePoints(pointsStr);
      if (rel.length < 3) continue;

      const abs = rel.map((p) => ({ x: ox + p.x, y: oy + p.y }));
      const aabb = aabbFromPts(abs);

      out.push({ msg, pts: abs, aabb });
    }
  }

  return out;
}

// -----------------------------------------------------------------------------
// Pixel masks (tileset) — AUTO polarity per tile
// -----------------------------------------------------------------------------
function luma(r: number, g: number, b: number) {
  return (77 * r + 150 * g + 29 * b) >> 8;
}

function buildTileMasks(img: HTMLImageElement, tw: number, th: number, columns: number, tilecount: number): TileMask[] {
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

    const avg = cnt ? sum / cnt : 0;
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
        const solid = solidIsDark ? L <= SOLID_DARK_LUMA : L >= SOLID_LIGHT_LUMA;
        if (solid) bits |= (1 << x) >>> 0;
      }

      rows[y] = bits >>> 0;
      if (bits) anyBits = true;
    }

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
    const t = uu;
    uu = vv;
    vv = t;
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

const w = attrInt(mapEl, "width");
const h = attrInt(mapEl, "height");
const tw = attrInt(mapEl, "tilewidth");
const th = attrInt(mapEl, "tileheight");

  const tilesetEl = tmx.getElementsByTagName("tileset")[0];
  if (!tilesetEl) throw new Error("TMX: missing <tileset>");

  const firstgid = attrInt(tilesetEl, "firstgid");
  const tsxRel = tilesetEl.getAttribute("source");
  if (!tsxRel) throw new Error("TMX: tileset source missing");

  const tsxUrl = joinUrl(tmxUrl, tsxRel);
  const tsxText = await (await fetch(tsxUrl)).text();
  const tsx = parseXml(tsxText);

  const tsxRoot = tsx.getElementsByTagName("tileset")[0];
  if (!tsxRoot) throw new Error("TSX: missing <tileset>");

const tsTw = attrInt(tsxRoot, "tilewidth");
const tsTh = attrInt(tsxRoot, "tileheight");
const columns = attrInt(tsxRoot, "columns");
const tilecount = attrInt(tsxRoot, "tilecount");

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
  const spawns = layers["spawns"] ?? new Uint32Array(w * h);

  // --- NEW: UI triggers from object layer
  const ui = parseUiObjectLayer(tmx);

  return {
    map: { w, h, tw, th, layers, tile, collide, spawns, ui },
    ts: { firstgid, img, columns, tilecount, tw: tsTw, th: tsTh, masks },
  };
}

export function drawTile(ctx: CanvasRenderingContext2D, ts: TileSet, gidRaw: number, dx: number, dy: number) {
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
