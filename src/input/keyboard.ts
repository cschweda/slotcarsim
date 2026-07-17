// Keyboard throttle: hold Space or ArrowUp to ramp up (like squeezing a
// trigger progressively), release to snap to 0 (= brake) — the authentic
// AFX pistol-grip feel via the only always-available input device. This is
// the "testable one" (no hardware needed); gamepad is the primary input,
// keyboard is the guaranteed fallback.
import { TUNING } from '../config/tuning';
import type { ThrottleSource } from './types';

const THROTTLE_KEYS = new Set(['Space', 'ArrowUp']);

export function createKeyboardThrottle(target: EventTarget = window): ThrottleSource {
  const heldKeys = new Set<string>();
  let throttle = 0;

  function onKeyDown(event: Event): void {
    const code = (event as KeyboardEvent).code;
    if (!THROTTLE_KEYS.has(code)) return;
    event.preventDefault();
    heldKeys.add(code);
  }

  function onKeyUp(event: Event): void {
    const code = (event as KeyboardEvent).code;
    if (!THROTTLE_KEYS.has(code)) return;
    event.preventDefault();
    heldKeys.delete(code);
    if (heldKeys.size === 0) {
      throttle = 0; // release snaps to 0 immediately, not a ramp-down
    }
  }

  target.addEventListener('keydown', onKeyDown);
  target.addEventListener('keyup', onKeyUp);

  function read(dt: number): number {
    if (heldKeys.size > 0) {
      // Re-read TUNING fresh every call so a debugPanel slider drag takes
      // effect on the very next read, mid-hold.
      throttle = Math.min(1, throttle + TUNING.keyboardRampRate * dt);
    }
    return throttle;
  }

  return {
    read,
    label: 'Keyboard',
    connected: true,
  };
}
