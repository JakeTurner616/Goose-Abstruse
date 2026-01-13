// src/input.ts

export type Keys = {
  left: boolean;
  right: boolean;
  up: boolean;
  down: boolean;

  a: boolean;
  b: boolean;

  start: boolean;
  select: boolean;

  // NEW
  r: boolean;
};

export function createKeys(): Keys {
  return {
    left: false,
    right: false,
    up: false,
    down: false,

    a: false,
    b: false,

    start: false,
    select: false,

    r: false,
  };
}

export function bindKeyboard(keys: Keys) {
  const setKey = (e: KeyboardEvent, down: boolean) => {
    if (
      e.code === "ArrowLeft" ||
      e.code === "ArrowRight" ||
      e.code === "ArrowUp" ||
      e.code === "ArrowDown" ||
      e.code === "Space"
    ) {
      e.preventDefault();
    }

    switch (e.code) {
      case "ArrowLeft":
        keys.left = down;
        break;
      case "ArrowRight":
        keys.right = down;
        break;
      case "ArrowUp":
        keys.up = down;
        break;
      case "ArrowDown":
        keys.down = down;
        break;

      case "KeyZ":
      case "Space":
        keys.a = down;
        break;
      case "KeyX":
        keys.b = down;
        break;

      case "Enter":
        keys.start = down;
        break;
      case "ShiftLeft":
      case "ShiftRight":
        keys.select = down;
        break;

      // NEW
      case "KeyR":
        keys.r = down;
        break;
    }
  };

  window.addEventListener(
    "keydown",
    (e) => {
      if (e.repeat) return;
      setKey(e, true);
    },
    { passive: false }
  );

  window.addEventListener(
    "keyup",
    (e) => {
      setKey(e, false);
    },
    { passive: false }
  );

  window.addEventListener("blur", () => {
    for (const k in keys) (keys as any)[k] = false;
  });
}
