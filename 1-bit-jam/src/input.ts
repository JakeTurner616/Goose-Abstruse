// src/input.ts
export type Keys = {
  left: boolean; right: boolean; up: boolean; down: boolean;
  a: boolean; b: boolean; start: boolean; select: boolean;
};

export function createKeys(): Keys {
  return {
    left: false, right: false, up: false, down: false,
    a: false, b: false, start: false, select: false,
  };
}

export function bindKeyboard(keys: Keys, onToggleInvert: () => void) {
  // latch so holding Z doesn't toggle every frame
  let invertLatch = false;

  function setKey(e: KeyboardEvent, isDown: boolean) {
    switch (e.code) {
      // --- dpad (arrows)
      case "ArrowLeft":  keys.left = isDown; break;
      case "ArrowRight": keys.right = isDown; break;
      case "ArrowUp":    keys.up = isDown; break;
      case "ArrowDown":  keys.down = isDown; break;

      // --- dpad (WASD)
      case "KeyA": keys.left = isDown; break;
      case "KeyD": keys.right = isDown; break;
      case "KeyW": keys.up = isDown; break;
      case "KeyS": keys.down = isDown; break;

      // --- jump convenience
      // Space should behave like "up" for your entity (jumpPressed = up || a)
      case "Space": keys.up = isDown; break;

      // --- buttons
      case "KeyZ":
        keys.a = isDown;
        if (isDown && !invertLatch) {
          onToggleInvert();
          invertLatch = true;
        }
        if (!isDown) invertLatch = false;
        break;

      case "KeyX": keys.b = isDown; break;
      case "Enter": keys.start = isDown; break;
      case "ShiftLeft":
      case "ShiftRight": keys.select = isDown; break;

      default:
        return;
    }

    // stop page scroll / focus changes for movement keys
    if (
      e.code.startsWith("Arrow") ||
      e.code === "Space" ||
      e.code === "KeyW" || e.code === "KeyA" || e.code === "KeyS" || e.code === "KeyD"
    ) {
      e.preventDefault();
    }
  }

  addEventListener("keydown", (e) => setKey(e, true), { passive: false });
  addEventListener("keyup", (e) => setKey(e, false), { passive: false });
}
