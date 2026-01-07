// src/tiled.ts
export type TiledMap = {
  w: number; h: number;
  tw: number; th: number;
  layer: Uint32Array; // raw gids, includes flags
};

export type TileSet = {
  firstgid: number;
  img: HTMLImageElement;
  columns: number;
  tilecount: number;
  tw: number; th: number;
};

export type TiledWorld = { map: TiledMap; ts: TileSet };

const FLIP_H = 0x80000000 >>> 0;
const FLIP_V = 0x40000000 >>> 0;
const FLIP_D = 0x20000000 >>> 0;
const GID_MASK = 0x1fffffff >>> 0;

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

  const layerEl = tmx.getElementsByTagName("layer")[0];
  if (!layerEl) throw new Error("TMX: missing <layer>");

  const dataEl = layerEl.getElementsByTagName("data")[0];
  if (!dataEl) throw new Error("TMX: missing <data>");
  if (dataEl.getAttribute("encoding") !== "csv") throw new Error("TMX: expected CSV encoding");

  const csv = (dataEl.textContent || "").trim();
  const layer = parseCsvToU32(csv, w * h);

  return {
    map: { w, h, tw, th, layer },
    ts: { firstgid, img, columns, tilecount, tw: tsTw, th: tsTh },
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

  // Small but “good enough” flip support
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
