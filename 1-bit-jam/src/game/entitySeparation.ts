// src/game/entitySeparation.ts
import type { Player } from "../player";
import { clamp } from "./math";
import { entityCollider } from "./colliders";

function pairHash(i: number, j: number) {
  const a = i < j ? i : j;
  const b = i < j ? j : i;
  let h = (a * 73856093) ^ (b * 19349663);
  h = (h ^ (h >>> 16)) >>> 0;
  return h;
}

function isControllable(p: Player): boolean {
  return !!(p as any)?._dbg?.controllable;
}

/**
 * Collision policy:
 * - babies collide with babies (prevents stacking)
 * - player does NOT collide with babies (player passes through / never gets shoved)
 */
function shouldSeparate(a: Player, b: Player): boolean {
  const ca = isControllable(a);
  const cb = isControllable(b);

  // skip controllable <-> non-controllable pairs
  if (ca !== cb) return false;

  // allow baby<->baby and (if it ever exists) player<->player
  return true;
}

function separationWeights(a: Player, b: Player) {
  const ca = isControllable(a);
  const cb = isControllable(b);

  if (ca === cb) return { wa: 0.5, wb: 0.5 };
  if (ca && !cb) return { wa: 0.15, wb: 0.85 };
  return { wa: 0.85, wb: 0.15 };
}

function separatePair(
  a: Player,
  b: Player,
  i: number,
  j: number,
  worldW: number,
  worldH: number,
  isSolid: (tx: number, ty: number) => boolean,
  tw: number,
  th: number
) {
  if (!shouldSeparate(a, b)) return false;

  const A = entityCollider(a);
  const B = entityCollider(b);

  const ax2 = A.x + A.w;
  const ay2 = A.y + A.h;
  const bx2 = B.x + B.w;
  const by2 = B.y + B.h;

  if (ax2 <= B.x || bx2 <= A.x || ay2 <= B.y || by2 <= A.y) return false;

  const ox = Math.min(ax2, bx2) - Math.max(A.x, B.x);
  const oy = Math.min(ay2, by2) - Math.max(A.y, B.y);
  if (ox <= 0 || oy <= 0) return false;

  const RESPONSE_STRENGTH = 0.2;
  const SLOP = 0.05;
  const push = Math.max(0, ox - SLOP) * RESPONSE_STRENGTH;

  const acx = A.x + A.w * 0.5;
  const bcx = B.x + B.w * 0.5;
  let dx = acx - bcx;

  if (Math.abs(dx) < 1e-6) dx = pairHash(i, j) & 1 ? 1 : -1;

  const { wa, wb } = separationWeights(a, b);
  const dir = dx < 0 ? -1 : 1;

  if (wa > 0) {
    const nextX = a.x + dir * push * wa;
    const testX = dir > 0 ? nextX + a.w : nextX;
    if (
      !isSolid((testX / tw) | 0, (a.y / th) | 0) &&
      !isSolid((testX / tw) | 0, ((a.y + a.h - 1) / th) | 0)
    ) {
      a.x = clamp(nextX, 0, worldW - a.w);
      if ((dir > 0 && a.vx < 0) || (dir < 0 && a.vx > 0)) a.vx *= 0.2;
    } else {
      a.vx = 0;
    }
  }

  if (wb > 0) {
    const nextX = b.x - dir * push * wb;
    const testX = dir < 0 ? nextX + b.w : nextX;
    if (
      !isSolid((testX / tw) | 0, (b.y / th) | 0) &&
      !isSolid((testX / tw) | 0, ((b.y + b.h - 1) / th) | 0)
    ) {
      b.x = clamp(nextX, 0, worldW - b.w);
      if ((dir < 0 && b.vx < 0) || (dir > 0 && b.vx > 0)) b.vx *= 0.2;
    } else {
      b.vx = 0;
    }
  }

  // keep entities in world bounds
  a.x = clamp(a.x, 0, worldW - a.w);
  a.y = clamp(a.y, 0, worldH - a.h);
  b.x = clamp(b.x, 0, worldW - b.w);
  b.y = clamp(b.y, 0, worldH - b.h);

  return true;
}

export function resolveEntityCollisions(
  entities: Player[],
  worldW: number,
  worldH: number,
  isSolid: (tx: number, ty: number) => boolean,
  tw: number,
  th: number
) {
  const ITERS = 1;
  let anyEver = false;

  for (let it = 0; it < ITERS; it++) {
    let any = false;
    for (let i = 0; i < entities.length; i++) {
      for (let j = i + 1; j < entities.length; j++) {
        if (separatePair(entities[i], entities[j], i, j, worldW, worldH, isSolid, tw, th)) any = true;
      }
    }
    if (!any) break;
    anyEver = true;
  }

  return anyEver;
}
