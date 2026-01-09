// src/scene.ts
export type Scene = {
  /** called once when scene becomes active */
  enter?(): void;
  /** called once when scene is replaced */
  exit?(): void;

  update(dt: number): void;
  draw(offCtx: CanvasRenderingContext2D, vw: number, vh: number): void;
};

export type SceneManager = {
  get(): Scene;
  set(next: Scene): void;
  update(dt: number): void;
  draw(offCtx: CanvasRenderingContext2D, vw: number, vh: number): void;
};

export function createSceneManager(initial: Scene): SceneManager {
  let cur = initial;

  cur.enter?.();

  return {
    get() {
      return cur;
    },
    set(next: Scene) {
      if (next === cur) return;
      cur.exit?.();
      cur = next;
      cur.enter?.();
    },
    update(dt: number) {
      cur.update(dt);
    },
    draw(offCtx: CanvasRenderingContext2D, vw: number, vh: number) {
      cur.draw(offCtx, vw, vh);
    },
  };
}
