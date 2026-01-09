// src/scenes/gameScene.ts
import type { Keys } from "../input";
import type { Game } from "../game";
import type { Scene } from "../scene";

export function createGameScene(game: Game, keys: Keys): Scene {
  return {
    update(dt: number) {
      game.update(dt, keys);
    },
    draw(offCtx: CanvasRenderingContext2D, vw: number, vh: number) {
      // bg depends on camera
      game.mountainBG.render(game.cam.x | 0, game.cam.y | 0);
      game.draw(offCtx, vw, vh);
    },
  };
}
