// src/scenes/gameScene.ts
import type { Keys } from "../input";
import type { Game } from "../game";
import type { Scene } from "../scene";

type GameSceneOpts = {
  onLevelIndexChanged?: (levelIndex: number) => void;
};

export function createGameScene(game: Game, keys: Keys, opts: GameSceneOpts = {}): Scene {
  // Track level changes during natural gameplay transitions (doors, win flow, etc.)
  let lastLevelIndex = (game as any).getLevelIndex ? (game as any).getLevelIndex() | 0 : -1;

  return {
    update(dt: number) {
      game.update(dt, keys);

      // If the game advanced to a new level without going through the debug API,
      // this ensures music selection still updates.
      const idx = (game as any).getLevelIndex ? ((game as any).getLevelIndex() | 0) : -1;
      if (idx !== lastLevelIndex) {
        lastLevelIndex = idx;
        opts.onLevelIndexChanged?.(idx);
      }
    },
    draw(offCtx: CanvasRenderingContext2D, vw: number, vh: number) {
      // bg depends on camera
      game.mountainBG.render(game.cam.x | 0, game.cam.y | 0);
      game.draw(offCtx, vw, vh);
    },
  };
}
