// src/playerPhysics.ts
export type SolidTileQuery = (tx: number, ty: number) => boolean;

export type AABB = { x: number; y: number; w: number; h: number; vx: number; vy: number };

export type PhysicsTuning = {
  grav: number;
  fallMax: number;
  stepUp: number;
  snapDown: number;
  maxSubSteps: number;
};

export type PhysicsState = { grounded: boolean; hitCeil: boolean; hitLeft: boolean; hitRight: boolean };

export type WorldInfo = { w: number; h: number; tw: number; th: number; tilesW: number; tilesH: number };

export function defaultPhysicsTuning(): PhysicsTuning {
  return { grav: 780, fallMax: 220, stepUp: 3, snapDown: 4, maxSubSteps: 4 };
}

const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);
const resetState = (st: PhysicsState) => {
  st.grounded = st.hitCeil = st.hitLeft = st.hitRight = false;
};

function hits(x: number, y: number, w: number, h: number, solid: SolidTileQuery, world: WorldInfo) {
  const tw = world.tw | 0, th = world.th | 0;
  const x0 = (x / tw) | 0, y0 = (y / th) | 0;
  const x1 = ((x + w - 1) / tw) | 0, y1 = ((y + h - 1) / th) | 0;
  for (let ty = y0; ty <= y1; ty++) for (let tx = x0; tx <= x1; tx++) if (solid(tx, ty)) return true;
  return false;
}

function colSolid(tx: number, y: number, h: number, solid: SolidTileQuery, world: WorldInfo) {
  const th = world.th | 0;
  const y0 = (y / th) | 0, y1 = ((y + h - 1) / th) | 0;
  for (let ty = y0; ty <= y1; ty++) if (solid(tx, ty)) return true;
  return false;
}

function rowSolid(ty: number, x: number, w: number, solid: SolidTileQuery, world: WorldInfo) {
  const tw = world.tw | 0;
  const x0 = (x / tw) | 0, x1 = ((x + w - 1) / tw) | 0;
  for (let tx = x0; tx <= x1; tx++) if (solid(tx, ty)) return true;
  return false;
}

function tryStepUp(a: AABB, nx: number, solid: SolidTileQuery, world: WorldInfo, tuning: PhysicsTuning) {
  const maxUp = tuning.stepUp | 0;
  if (maxUp <= 0) return false;
  for (let up = 1; up <= maxUp; up++) {
    const ny = a.y - up;
    if (ny < 0) break;
    if (!hits(nx, ny, a.w, a.h, solid, world)) {
      a.x = nx;
      a.y = ny;
      return true;
    }
  }
  return false;
}

/** Kinematic move (no gravity): attempt to apply (dx,dy) with the same AABB-vs-tiles rules. */
export function moveTileAabbKinematic(
  a: AABB,
  st: PhysicsState,
  dx: number,
  dy: number,
  solid: SolidTileQuery,
  world: WorldInfo,
  tuning: PhysicsTuning
) {
  resetState(st);

  const steps = clamp(((Math.max(Math.abs(dx), Math.abs(dy)) / 8) | 0) || 1, 1, tuning.maxSubSteps | 0);
  const sdx = dx / steps, sdy = dy / steps;

  for (let i = 0; i < steps; i++) {
    // X
    const nx = a.x + sdx;
    if (!hits(nx, a.y, a.w, a.h, solid, world)) a.x = nx;
    else {
      const dir = sdx > 0 ? 1 : sdx < 0 ? -1 : 0;
      if (!(dir && tryStepUp(a, nx, solid, world, tuning))) {
        const tw = world.tw | 0;
        const px = a.x;

        if (sdx > 0) {
          const tx = (((nx + a.w - 1) / tw) | 0);
          if (colSolid(tx, a.y, a.h, solid, world)) {
            a.x = tx * tw - a.w;
            st.hitRight = true;
          }
        } else if (sdx < 0) {
          const tx = ((nx / tw) | 0);
          if (colSolid(tx, a.y, a.h, solid, world)) {
            a.x = (tx + 1) * tw;
            st.hitLeft = true;
          }
        }

        if (hits(a.x, a.y, a.w, a.h, solid, world)) a.x = px;
      }
    }

    // Y
    const ny = a.y + sdy;
    if (!hits(a.x, ny, a.w, a.h, solid, world)) a.y = ny;
    else {
      const th = world.th | 0;
      const py = a.y;

      if (sdy > 0) {
        const ty = (((ny + a.h - 1) / th) | 0);
        if (rowSolid(ty, a.x, a.w, solid, world)) {
          a.y = ty * th - a.h;
          st.grounded = true;
        }
      } else if (sdy < 0) {
        const ty = ((ny / th) | 0);
        if (rowSolid(ty, a.x, a.w, solid, world)) {
          a.y = (ty + 1) * th;
          st.hitCeil = true;
        }
      }

      if (hits(a.x, a.y, a.w, a.h, solid, world)) a.y = py;
    }

    // snap-down glue
    if (!st.grounded && sdy >= 0 && (tuning.snapDown | 0) > 0) {
      const maxDown = tuning.snapDown | 0;
      for (let d = 1; d <= maxDown; d++) {
        if (hits(a.x, a.y + d, a.w, a.h, solid, world)) {
          a.y = a.y + d - 1;
          st.grounded = true;
          break;
        }
      }
    }

    a.x = clamp(a.x, 0, world.w - a.w);
    a.y = clamp(a.y, 0, world.h - a.h);
  }

  if (!st.grounded) st.grounded = hits(a.x, a.y + 1, a.w, a.h, solid, world);
}

/** Platformer physics step. */
export function stepTileAabbPhysics(
  a: AABB,
  st: PhysicsState,
  dt: number,
  solid: SolidTileQuery,
  world: WorldInfo,
  tuning: PhysicsTuning
) {
  resetState(st);

  a.vy = Math.min(tuning.fallMax, a.vy + tuning.grav * dt);

  const steps = clamp((((Math.max(Math.abs(a.vx), Math.abs(a.vy)) * dt) / 8) | 0) || 1, 1, tuning.maxSubSteps | 0);
  const sdt = dt / steps;

  for (let i = 0; i < steps; i++) {
    // X
    const nx = a.x + a.vx * sdt;
    if (!hits(nx, a.y, a.w, a.h, solid, world)) a.x = nx;
    else {
      const dir = a.vx > 0 ? 1 : a.vx < 0 ? -1 : 0;
      if (!(dir && tryStepUp(a, nx, solid, world, tuning))) {
        const tw = world.tw | 0;
        const left = a.x;
        const nextL = nx;
        const nextR = nx + a.w - 1;

        if (a.vx > 0) {
          const tx = (nextR / tw) | 0;
          if (colSolid(tx, a.y, a.h, solid, world)) {
            a.x = tx * tw - a.w;
            a.vx = 0;
            st.hitRight = true;
          }
        } else if (a.vx < 0) {
          const tx = (nextL / tw) | 0;
          if (colSolid(tx, a.y, a.h, solid, world)) {
            a.x = (tx + 1) * tw;
            a.vx = 0;
            st.hitLeft = true;
          }
        } else {
          a.vx = 0;
        }

        if (hits(a.x, a.y, a.w, a.h, solid, world)) a.x = left;
      }
    }

    // Y
    const ny = a.y + a.vy * sdt;
    if (!hits(a.x, ny, a.w, a.h, solid, world)) a.y = ny;
    else {
      const th = world.th | 0;
      const nextTop = ny;
      const nextBot = ny + a.h - 1;

      if (a.vy > 0) {
        const ty = (nextBot / th) | 0;
        if (rowSolid(ty, a.x, a.w, solid, world)) {
          a.y = ty * th - a.h;
          a.vy = 0;
          st.grounded = true;
        }
      } else if (a.vy < 0) {
        const ty = (nextTop / th) | 0;
        if (rowSolid(ty, a.x, a.w, solid, world)) {
          a.y = (ty + 1) * th;
          a.vy = 0;
          st.hitCeil = true;
        }
      } else {
        a.vy = 0;
      }
    }

    // snap-down glue (keep the “kill vy” fix)
    if (!st.grounded && a.vy >= 0 && (tuning.snapDown | 0) > 0) {
      const maxDown = tuning.snapDown | 0;
      for (let d = 1; d <= maxDown; d++) {
        if (hits(a.x, a.y + d, a.w, a.h, solid, world)) {
          a.y = a.y + d - 1;
          a.vy = 0;
          st.grounded = true;
          break;
        }
      }
    }

    a.x = clamp(a.x, 0, world.w - a.w);
    a.y = clamp(a.y, 0, world.h - a.h);
  }

  if (!st.grounded) st.grounded = hits(a.x, a.y + 1, a.w, a.h, solid, world);
}
