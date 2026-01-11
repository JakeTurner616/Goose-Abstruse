// src/game/cameraFocus.ts
import type { Keys } from "../input";
import type { Player } from "../player";
import type { TiledWorld } from "../tiled";
import { clamp } from "./math";
import type { Cam } from "./types";

export type CameraFocusController = {
  /** Call whenever player/gooselings arrays are replaced (e.g. after load). */
  setTargets(player: Player, gooselings: Player[]): void;

  /** Call whenever the world changes (or becomes null). */
  setWorld(world: TiledWorld | null): void;

  /** Reset focus to player + cancel any in-flight pan. */
  reset(): void;

  /** Handle "next focus" input (keys.b / X). */
  handleInput(keys: Keys): void;

  /** Tick camera position. */
  update(dt: number): void;

  /** Current focus: 0=player, 1..N=gooselings */
  get focus(): number;
};

export type CreateCameraFocusOpts = {
  vw: number;
  vh: number;
  panSec: number;

  // Plays tiny feedback when button is pressed but there are no babies.
  playUiClick(): void;
};

const smoothstep01 = (u: number) => u * u * (3 - 2 * u);

export function createCameraFocusController(
  cam: Cam,
  opts: CreateCameraFocusOpts
): CameraFocusController {
  const { vw, vh, panSec, playUiClick } = opts;

  let world: TiledWorld | null = null;
  let player!: Player;
  let gooselings: Player[] = [];

  let focus = 0; // 0=player, 1..N=gooselings
  let latch = false;

  const pan = {
    active: false,
    t: 0,
    dur: panSec,
    sx: 0,
    sy: 0,
    tx: 0,
    ty: 0,
    nextFocus: 0,
  };

  function focusCount() {
    return 1 + gooselings.length;
  }

  function clampCamToWorld(x: number, y: number) {
    const ww = world ? world.map.w * world.map.tw : vw;
    const wh = world ? world.map.h * world.map.th : vh;
    return {
      x: clamp(x, 0, Math.max(0, ww - vw)),
      y: clamp(y, 0, Math.max(0, wh - vh)),
    };
  }

  function focusEntity(idx: number): Player {
    if (idx <= 0) return player;
    const n = Math.max(1, gooselings.length);
    return gooselings[(idx - 1) % n];
  }

  function camTargetFor(p: Player) {
    const targetX = p.x + (p.w >> 1) - (vw >> 1);
    const targetY = p.y + (p.h >> 1) - (vh >> 1);
    return clampCamToWorld(targetX, targetY);
  }

  function beginPanTo(nextFocus: number) {
    pan.active = true;
    pan.t = 0;
    pan.dur = panSec;
    pan.sx = cam.x;
    pan.sy = cam.y;

    const e = focusEntity(nextFocus);
    const tgt = camTargetFor(e);
    pan.tx = tgt.x;
    pan.ty = tgt.y;
    pan.nextFocus = nextFocus;
  }

  function setTargets(nextPlayer: Player, nextGooselings: Player[]) {
    player = nextPlayer;
    gooselings = nextGooselings;

    // keep focus valid when babies count changes
    const n = focusCount();
    focus = clamp(focus, 0, Math.max(0, n - 1)) | 0;
  }

  function setWorld(nextWorld: TiledWorld | null) {
    world = nextWorld;
  }

  function reset() {
    focus = 0;
    pan.active = false;
    latch = false;
  }

  function handleInput(keys: Keys) {
    // X is bound to keys.b in input.ts
    if (keys.b && !latch) {
      latch = true;

      const n = focusCount();
      if (n > 1) {
        const next = ((focus + 1) % n) | 0;
        beginPanTo(next);
      } else {
        playUiClick();
      }
    }
    if (!keys.b) latch = false;
  }

  function update(dt: number) {
    if (!player) return;

    if (pan.active) {
      pan.t += dt;
      const u = pan.dur > 0 ? Math.min(1, pan.t / pan.dur) : 1;
      const s = smoothstep01(u);

      cam.x = pan.sx + (pan.tx - pan.sx) * s;
      cam.y = pan.sy + (pan.ty - pan.sy) * s;

      if (u >= 1) {
        pan.active = false;
        focus = pan.nextFocus | 0;

        // snap final cam to integer pixel for 1-bit stability
        cam.x = Math.floor(cam.x);
        cam.y = Math.floor(cam.y);
      }
      return;
    }

    const e = focusEntity(focus);
    const tgt = camTargetFor(e);

    // default camera remains pixel-snapped (no blur), only pan is smooth
    cam.x = Math.floor(tgt.x);
    cam.y = Math.floor(tgt.y);
  }

  return {
    setTargets,
    setWorld,
    reset,
    handleInput,
    update,
    get focus() {
      return focus | 0;
    },
  };
}
