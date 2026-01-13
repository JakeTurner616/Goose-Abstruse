// src/game/spawn.ts
import { type TiledWorld, GID_MASK } from "../tiled";

export type SpawnKind = "goose" | "gooseling" | "key";
export type SpawnPoint = { kind: SpawnKind; x: number; y: number };

function spawnKindFromGid(gidMasked: number, firstgid: number): SpawnKind | null {
  if (gidMasked === 1) return "goose";
  if (gidMasked === 2) return "gooseling";

  if (gidMasked === (firstgid >>> 0)) return "goose"; // index 1
  if (gidMasked === ((firstgid + 1) >>> 0)) return "gooseling"; // index 2
  if (gidMasked === ((firstgid + 8) >>> 0)) return "key"; // index 9

  return null;
}

export function scanSpawnPoints(w: TiledWorld): SpawnPoint[] {
  const out: SpawnPoint[] = [];
  const { map, ts } = w;
  const L = (map as any).spawns as Uint32Array;

  for (let i = 0; i < L.length; i++) {
    const gidRaw = L[i] >>> 0;
    const gid = (gidRaw & GID_MASK) >>> 0;
    if (!gid) continue;

    const kind = spawnKindFromGid(gid, ts.firstgid >>> 0);
    if (!kind) continue;

    const tx = (i % map.w) | 0;
    const ty = (i / map.w) | 0;

    out.push({
      kind,
      x: tx * map.tw,
      y: ty * map.th,
    });
  }

  return out;
}
