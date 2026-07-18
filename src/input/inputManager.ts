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
  /**
   * M8: polls the gamepad directly (bypassing keyboard entirely), so
   * connection detection and the calibration wizard can progress even
   * outside a race (menu, countdown) — callers should call EITHER this OR
   * readPlayerThrottle each frame, never both, since each calls the
   * gamepad's own read(dt) exactly once and calling it twice in the same
   * frame would double-advance the calibration timer.
   */
  pollGamepad(dt: number): void;
  /** M8: true once any gamepad has ever been seen this session — drives the HUD's "squeeze the trigger to connect" hint. */
  everSeenGamepad(): boolean;
  /** M8: true while the gamepad calibration wizard is sampling. */
  gamepadCalibrating(): boolean;
  /** M8: seconds remaining in the calibration window (0 when not calibrating). */
  gamepadCalibrationSecondsLeft(): number;
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

  function pollGamepad(dt: number): void {
    gamepad.read(dt);
  }

  return {
    readPlayerThrottle,
    activeSourceLabel,
    pollGamepad,
    everSeenGamepad: () => gamepad.everConnected,
    gamepadCalibrating: () => gamepad.calibrating,
    gamepadCalibrationSecondsLeft: () => gamepad.calibrationSecondsLeft,
  };
}
