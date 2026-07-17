// Real AFX pistol-grip feel via the Gamepad API analog trigger — the primary
// input; keyboard is the fallback. Chrome hands back a FRESH object from
// every navigator.getGamepads() call (Firefox mutates in place), so caching
// a Gamepad reference risks reading stale, frozen values in Chrome. This
// re-fetches on every read/connected check; only a discovered fallback
// button/axis INDEX persists across reads, never the Gamepad object itself.
import type { ThrottleSource } from './types';

const STANDARD_THROTTLE_BUTTON = 7; // RT, per the Gamepad API "standard" mapping
const BUTTON_DISCOVERY_THRESHOLD = 0.05;
const DEADZONE = 0.03;

type FallbackControl = { kind: 'button'; index: number } | { kind: 'axis'; index: number };

function applyDeadzone(raw: number): number {
  if (raw < DEADZONE) return 0;
  return (raw - DEADZONE) / (1 - DEADZONE);
}

function getFirstPad(): Gamepad | null {
  for (const pad of navigator.getGamepads()) {
    if (pad) return pad;
  }
  return null;
}

/** First button whose analog value clears the discovery threshold, else the first axis away from its -1 resting value. */
function discoverFallback(pad: Gamepad): FallbackControl | null {
  const buttonIndex = pad.buttons.findIndex((b) => b.value > BUTTON_DISCOVERY_THRESHOLD);
  if (buttonIndex >= 0) {
    return { kind: 'button', index: buttonIndex };
  }
  const axisIndex = pad.axes.findIndex((v) => v !== -1);
  if (axisIndex >= 0) {
    return { kind: 'axis', index: axisIndex };
  }
  return null;
}

export function createGamepadThrottle(): ThrottleSource {
  let fallback: FallbackControl | null = null;
  let wasConnected = false;

  function read(_dt: number): number {
    const pad = getFirstPad();
    if (!pad) {
      wasConnected = false;
      fallback = null; // force a fresh scan next time a pad appears
      return 0;
    }
    if (!wasConnected) {
      fallback = null; // just (re)connected — re-scan for the active control
    }
    wasConnected = true;

    if (pad.mapping === 'standard') {
      const button = pad.buttons[STANDARD_THROTTLE_BUTTON];
      return applyDeadzone(button ? button.value : 0);
    }

    if (fallback === null) {
      fallback = discoverFallback(pad);
    }
    if (fallback === null) {
      return 0;
    }

    if (fallback.kind === 'button') {
      const button = pad.buttons[fallback.index];
      return applyDeadzone(button ? button.value : 0);
    }
    const axisValue = pad.axes[fallback.index];
    const normalized = axisValue === undefined ? 0 : (axisValue + 1) / 2;
    return applyDeadzone(normalized);
  }

  return {
    read,
    label: 'Gamepad',
    get connected() {
      return getFirstPad() !== null;
    },
  };
}
