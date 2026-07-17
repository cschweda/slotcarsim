// Composes the two ThrottleSources into one per-player input: prefers the
// gamepad trigger (closest to a real AFX pistol grip) whenever a pad is
// connected, else the keyboard fallback. On a mid-race gamepad disconnect,
// reads fall through to keyboard — 0 if no key is held, i.e. the authentic
// "dropped controller full-brake."
import { createGamepadThrottle } from './gamepad';
import { createKeyboardThrottle } from './keyboard';
import type { ThrottleSource } from './types';

export interface InputManager {
  readPlayerThrottle(dt: number): number;
  activeSourceLabel(): string;
}

export function createInputManager(): InputManager {
  const gamepad = createGamepadThrottle();
  const keyboard = createKeyboardThrottle();

  // readPlayerThrottle() re-polls gamepad.connected on every call, so this
  // cache can never leave the wrong source selected during actual play — the
  // gamepadconnected/disconnected listeners below just mean a caller asking
  // activeSourceLabel() between throttle reads (e.g. the HUD) also sees an
  // up-to-date answer promptly, not stale until the next read.
  let gamepadConnected = gamepad.connected;

  function refreshConnected(): void {
    gamepadConnected = gamepad.connected;
  }

  window.addEventListener('gamepadconnected', refreshConnected);
  window.addEventListener('gamepaddisconnected', refreshConnected);

  function activeSource(): ThrottleSource {
    return gamepadConnected ? gamepad : keyboard;
  }

  function readPlayerThrottle(dt: number): number {
    refreshConnected();
    return activeSource().read(dt);
  }

  function activeSourceLabel(): string {
    return activeSource().label;
  }

  return { readPlayerThrottle, activeSourceLabel };
}
