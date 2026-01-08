// src/playerPhysics.ts
export type SolidTileQuery = (tx: number, ty: number) => boolean;

export type AABB = {
  x: number;
  y: number;
  w: number;
  h: number;
  vx: number;
  vy: number;
};

export type PhysicsTuning = {
  grav: number;
  fallMax: number;

  // Mario-ish micro step-up when moving sideways into a 1-3px curb
  stepUp: number;

  // Snap down to keep glued to ground when moving over small height changes
  snapDown: number;

  // Safety cap (prevents “teleporting” through walls at insane speeds)
  maxSubSteps: number;
};

export type PhysicsState = {
  grounded: boolean;
  hitCeil: boolean;
  hitLeft: boolean;
  hitRight: boolean;
};

export type WorldInfo = {
  w: number; h: number;       // world size in pixels
  tw: number; th: number;     // tile size in pixels
  tilesW: number; tilesH: number;
};

export function defaultPhysicsTuning(): PhysicsTuning {
  return {
    grav: 780,
    fallMax: 220,
    stepUp: 3,
    snapDown: 4,
    maxSubSteps: 4,
  };
}

function clamp(v: number, lo: number, hi: number) {
  return v < lo ? lo : v > hi ? hi : v;
}

function aabbHitsSolidTiles(
  x: number,
  y: number,
  w: number,
  h: number,
  isSolid: SolidTileQuery,
  world: WorldInfo
) {
  const tw = world.tw | 0;
  const th = world.th | 0;

  const x0 = (x / tw) | 0;
  const y0 = (y / th) | 0;
  const x1 = ((x + w - 1) / tw) | 0;
  const y1 = ((y + h - 1) / th) | 0;

  for (let ty = y0; ty <= y1; ty++) {
    for (let tx = x0; tx <= x1; tx++) {
      if (isSolid(tx, ty)) return true;
    }
  }
  return false;
}

function columnSolid(
  tx: number,
  y: number,
  h: number,
  isSolid: SolidTileQuery,
  world: WorldInfo
) {
  const th = world.th | 0;
  const y0 = (y / th) | 0;
  const y1 = ((y + h - 1) / th) | 0;
  for (let ty = y0; ty <= y1; ty++) {
    if (isSolid(tx, ty)) return true;
  }
  return false;
}

function rowSolid(
  ty: number,
  x: number,
  w: number,
  isSolid: SolidTileQuery,
  world: WorldInfo
) {
  const tw = world.tw | 0;
  const x0 = (x / tw) | 0;
  const x1 = ((x + w - 1) / tw) | 0;
  for (let tx = x0; tx <= x1; tx++) {
    if (isSolid(tx, ty)) return true;
  }
  return false;
}

/**
 * Kinematic move (no gravity): attempt to apply (dx,dy) with the same AABB-vs-tiles rules.
 * This is the “puppet” mover for gooselings.
 *
 * IMPORTANT:
 * - We DO NOT pixel-snap inside physics. That changes speed/feel.
 * - We only snap at render-time (drawImage at integer coords).
 */
export function moveTileAabbKinematic(
  a: AABB,
  st: PhysicsState,
  dx: number,
  dy: number,
  isSolid: SolidTileQuery,
  world: WorldInfo,
  tuning: PhysicsTuning
) {
  st.grounded = false;
  st.hitCeil = false;
  st.hitLeft = false;
  st.hitRight = false;

  // sub-step large deltas so we don’t tunnel
  const steps = clamp((Math.max(Math.abs(dx), Math.abs(dy)) / 8) | 0, 1, tuning.maxSubSteps | 0);
  const sdx = dx / steps;
  const sdy = dy / steps;

  for (let i = 0; i < steps; i++) {
    // --- X axis (with tiny stepUp)
    const nx = a.x + sdx;
    if (!aabbHitsSolidTiles(nx, a.y, a.w, a.h, isSolid, world)) {
      a.x = nx;
    } else {
      const dir = sdx > 0 ? 1 : sdx < 0 ? -1 : 0;
      let stepped = false;

      if (dir && (tuning.stepUp | 0) > 0) {
        const maxUp = tuning.stepUp | 0;
        for (let up = 1; up <= maxUp; up++) {
          const ny = a.y - up;
          if (ny < 0) break;
          if (!aabbHitsSolidTiles(nx, ny, a.w, a.h, isSolid, world)) {
            a.x = nx;
            a.y = ny;
            stepped = true;
            break;
          }
        }
      }

      if (!stepped) {
        const tw = world.tw | 0;
        const prevX = a.x;

        if (sdx > 0) {
          const tx = (((nx + a.w - 1) / tw) | 0);
          if (columnSolid(tx, a.y, a.h, isSolid, world)) {
            a.x = tx * tw - a.w;
            st.hitRight = true;
          }
        } else if (sdx < 0) {
          const tx = ((nx / tw) | 0);
          if (columnSolid(tx, a.y, a.h, isSolid, world)) {
            a.x = (tx + 1) * tw;
            st.hitLeft = true;
          }
        }

        if (aabbHitsSolidTiles(a.x, a.y, a.w, a.h, isSolid, world)) {
          a.x = prevX;
        }
      }
    }

    // --- Y axis
    const ny = a.y + sdy;
    if (!aabbHitsSolidTiles(a.x, ny, a.w, a.h, isSolid, world)) {
      a.y = ny;
    } else {
      const th = world.th | 0;
      const prevY = a.y;

      if (sdy > 0) {
        const ty = (((ny + a.h - 1) / th) | 0);
        if (rowSolid(ty, a.x, a.w, isSolid, world)) {
          a.y = ty * th - a.h;
          st.grounded = true;
        }
      } else if (sdy < 0) {
        const ty = ((ny / th) | 0);
        if (rowSolid(ty, a.x, a.w, isSolid, world)) {
          a.y = (ty + 1) * th;
          st.hitCeil = true;
        }
      }

      if (aabbHitsSolidTiles(a.x, a.y, a.w, a.h, isSolid, world)) {
        a.y = prevY;
      }
    }

    // --- snap-down glue (helps them “stick” to their follow path)
    if (!st.grounded && sdy >= 0 && (tuning.snapDown | 0) > 0) {
      const maxDown = tuning.snapDown | 0;
      for (let d = 1; d <= maxDown; d++) {
        if (aabbHitsSolidTiles(a.x, a.y + d, a.w, a.h, isSolid, world)) {
          a.y = (a.y + d - 1);
          st.grounded = true;
          break;
        }
      }
    }

    // World clamp (pixel bounds)
    a.x = clamp(a.x, 0, world.w - a.w);
    a.y = clamp(a.y, 0, world.h - a.h);
  }

  // Final grounded check (1px below)
  if (!st.grounded) {
    st.grounded = aabbHitsSolidTiles(a.x, a.y + 1, a.w, a.h, isSolid, world);
  }
}

/**
 * Simple GB/NES-style:
 * - axis-separated AABB vs solid tile boxes
 * - tiny step-up for curbs (Mario)
 * - snap-down glue
 *
 * IMPORTANT:
 * - simulation stays subpixel (float)
 * - render snaps to integer (drawImage at integer coords)
 */
export function stepTileAabbPhysics(
  a: AABB,
  st: PhysicsState,
  dt: number,
  isSolid: SolidTileQuery,
  world: WorldInfo,
  tuning: PhysicsTuning
) {
  st.grounded = false;
  st.hitCeil = false;
  st.hitLeft = false;
  st.hitRight = false;

  // Gravity + terminal
  a.vy = Math.min(tuning.fallMax, a.vy + tuning.grav * dt);

  // Basic sub-stepping to reduce tunneling
  const steps = clamp((Math.max(Math.abs(a.vx), Math.abs(a.vy)) * dt / 8) | 0, 1, tuning.maxSubSteps | 0);
  const sdt = dt / steps;

  for (let i = 0; i < steps; i++) {
    // --- X axis
    let nx = a.x + a.vx * sdt;
    if (!aabbHitsSolidTiles(nx, a.y, a.w, a.h, isSolid, world)) {
      a.x = nx;
    } else {
      // Step-up attempt (only if moving sideways)
      const dir = a.vx > 0 ? 1 : a.vx < 0 ? -1 : 0;
      let stepped = false;

      if (dir && (tuning.stepUp | 0) > 0) {
        const maxUp = tuning.stepUp | 0;
        for (let up = 1; up <= maxUp; up++) {
          const ny = a.y - up;
          if (ny < 0) break;
          if (!aabbHitsSolidTiles(nx, ny, a.w, a.h, isSolid, world)) {
            a.x = nx;
            a.y = ny;
            stepped = true;
            break;
          }
        }
      }

      if (!stepped) {
        // Clamp flush against the blocking tile column
        const tw = world.tw | 0;
        const left = a.x;
        const nextLeft = nx;
        const nextRight = nx + a.w - 1;

        if (a.vx > 0) {
          const tx = (nextRight / tw) | 0;
          if (columnSolid(tx, a.y, a.h, isSolid, world)) {
            a.x = tx * tw - a.w;
            a.vx = 0;
            st.hitRight = true;
          }
        } else if (a.vx < 0) {
          const tx = (nextLeft / tw) | 0;
          if (columnSolid(tx, a.y, a.h, isSolid, world)) {
            a.x = (tx + 1) * tw;
            a.vx = 0;
            st.hitLeft = true;
          }
        } else {
          a.vx = 0;
        }

        if (aabbHitsSolidTiles(a.x, a.y, a.w, a.h, isSolid, world)) {
          a.x = left;
        }
      }
    }

    // --- Y axis
    let ny = a.y + a.vy * sdt;
    if (!aabbHitsSolidTiles(a.x, ny, a.w, a.h, isSolid, world)) {
      a.y = ny;
    } else {
      const th = world.th | 0;
      const nextTop = ny;
      const nextBot = ny + a.h - 1;

      if (a.vy > 0) {
        const ty = (nextBot / th) | 0;
        if (rowSolid(ty, a.x, a.w, isSolid, world)) {
          a.y = ty * th - a.h;
          a.vy = 0;
          st.grounded = true;
        }
      } else if (a.vy < 0) {
        const ty = (nextTop / th) | 0;
        if (rowSolid(ty, a.x, a.w, isSolid, world)) {
          a.y = (ty + 1) * th;
          a.vy = 0;
          st.hitCeil = true;
        }
      } else {
        a.vy = 0;
      }
    }

    // --- snap-down glue (only if not moving upward)
    if (!st.grounded && a.vy >= 0 && (tuning.snapDown | 0) > 0) {
      const maxDown = tuning.snapDown | 0;
      for (let d = 1; d <= maxDown; d++) {
        if (aabbHitsSolidTiles(a.x, a.y + d, a.w, a.h, isSolid, world)) {
          a.y = (a.y + d - 1);
          st.grounded = true;
          break;
        }
      }
    }

    // World clamp (pixel bounds)
    a.x = clamp(a.x, 0, world.w - a.w);
    a.y = clamp(a.y, 0, world.h - a.h);
  }

  // Final grounded check (1px below)
  if (!st.grounded) {
    st.grounded = aabbHitsSolidTiles(a.x, a.y + 1, a.w, a.h, isSolid, world);
  }
}
