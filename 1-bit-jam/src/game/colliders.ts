// src/game/colliders.ts
import type { Player } from "../player";
import type { KeyEntity } from "../key";

const COLLIDER_FRAC = 16 / 64;
const COLLIDER_MIN = 4;

// For hazards (spikes), use a "feet box" so contact at the ground actually registers.
const HAZARD_W_FRAC = 0.55;
const HAZARD_H_FRAC = 0.28;
const HAZARD_MIN = 4;

export type CAABB = { x: number; y: number; w: number; h: number };

export function entityCollider(p: Player): CAABB {
  const cw = Math.max(COLLIDER_MIN, (p.w * COLLIDER_FRAC + 0.5) | 0);
  const ch = Math.max(COLLIDER_MIN, (p.h * COLLIDER_FRAC + 0.5) | 0);
  const cx = p.x + (p.w - cw) * 0.5;
  const cy = p.y + (p.h - ch) * 0.5;
  return { x: cx, y: cy, w: cw, h: ch };
}

// Bottom-aligned collider used for spike/hazard checks.
export function hazardCollider(p: Player): CAABB {
  const cw = Math.max(HAZARD_MIN, (p.w * HAZARD_W_FRAC + 0.5) | 0);
  const ch = Math.max(HAZARD_MIN, (p.h * HAZARD_H_FRAC + 0.5) | 0);

  const cx = p.x + (p.w - cw) * 0.5;
  const cy = p.y + p.h - ch; // feet

  return { x: cx, y: cy, w: cw, h: ch };
}

export function aabbOverlaps(a: CAABB, b: CAABB) {
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
}

// KeyEntity is anchored at bottom-center; its nominal untrimmed (w,h) come from atlas sourceSize.
export function keyCollider(k: KeyEntity): CAABB {
  const s = k.scale || 1;
  const w = k.w * s;
  const h = k.h * s;
  return { x: k.x - w * 0.5, y: k.y - h, w, h };
}
