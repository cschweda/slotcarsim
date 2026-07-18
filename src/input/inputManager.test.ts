import { afterEach, describe, expect, it, vi } from 'vitest';
import { createInputManager } from './inputManager';

type Listener = (event: unknown) => void;

/** Minimal fake window: EventTarget-like, enough for keyboard.ts + inputManager.ts. */
class FakeWindow {
  private listeners = new Map<string, Set<Listener>>();

  addEventListener(type: string, listener: Listener): void {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type)!.add(listener);
  }

  removeEventListener(type: string, listener: Listener): void {
    this.listeners.get(type)?.delete(listener);
  }

  dispatch(type: string, event: unknown = {}): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}

interface FakeButton {
  value: number;
}
interface FakePad {
  mapping: string;
  buttons: FakeButton[];
  axes: number[];
}

function standardPad(rt: number): FakePad {
  const buttons: FakeButton[] = Array.from({ length: 17 }, () => ({ value: 0 }));
  buttons[7] = { value: rt };
  return { mapping: 'standard', buttons, axes: [] };
}

function stubPads(pads: (FakePad | null)[]): void {
  vi.stubGlobal('navigator', { getGamepads: () => pads });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('createInputManager', () => {
  it('prefers the gamepad when connected', () => {
    stubPads([standardPad(0.515)]);
    vi.stubGlobal('window', new FakeWindow());

    const manager = createInputManager();
    expect(manager.readPlayerThrottle(1 / 60)).toBeCloseTo(0.5, 12);
    expect(manager.activeSourceLabel()).toBe('Gamepad');
  });

  it('falls back to keyboard when no gamepad is connected', () => {
    stubPads([]);
    const fakeWindow = new FakeWindow();
    vi.stubGlobal('window', fakeWindow);

    const manager = createInputManager();
    fakeWindow.dispatch('keydown', { code: 'Space', preventDefault: () => {} });
    expect(manager.readPlayerThrottle(0.1)).toBeGreaterThan(0);
    expect(manager.activeSourceLabel()).toBe('Keyboard');
  });

  it('falls through to keyboard on a mid-race gamepad disconnect (0 throttle if no key held)', () => {
    stubPads([standardPad(0.515)]);
    vi.stubGlobal('window', new FakeWindow());

    const manager = createInputManager();
    expect(manager.readPlayerThrottle(1 / 60)).toBeCloseTo(0.5, 12);

    stubPads([]); // disconnect mid-race
    expect(manager.readPlayerThrottle(1 / 60)).toBe(0); // no key held -> full brake
    expect(manager.activeSourceLabel()).toBe('Keyboard');
  });

  it('updates activeSourceLabel promptly via gamepadconnected, even before the next throttle read', () => {
    stubPads([]);
    const fakeWindow = new FakeWindow();
    vi.stubGlobal('window', fakeWindow);

    const manager = createInputManager();
    expect(manager.activeSourceLabel()).toBe('Keyboard');

    stubPads([standardPad(0.515)]); // pad shows up
    fakeWindow.dispatch('gamepadconnected');
    expect(manager.activeSourceLabel()).toBe('Gamepad'); // no readPlayerThrottle call yet
  });

  // M8: outside a race (menu/countdown), main.ts calls pollGamepad() instead
  // of readPlayerThrottle() so gamepad connection/calibration state can
  // progress before the player starts racing, without ever touching the
  // keyboard fallback's stateful ramp-up.
  describe('pollGamepad (M8)', () => {
    it('registers the gamepad as seen without needing a readPlayerThrottle call', () => {
      stubPads([]);
      vi.stubGlobal('window', new FakeWindow());
      const manager = createInputManager();
      expect(manager.everSeenGamepad()).toBe(false);

      stubPads([standardPad(0.515)]);
      manager.pollGamepad(1 / 60);
      expect(manager.everSeenGamepad()).toBe(true);
    });

    it('never advances the keyboard ramp — a held key does not accumulate throttle while only pollGamepad is called', () => {
      stubPads([]); // no gamepad at all — keyboard is the active source
      const fakeWindow = new FakeWindow();
      vi.stubGlobal('window', fakeWindow);
      const manager = createInputManager();
      fakeWindow.dispatch('keydown', { code: 'Space', preventDefault: () => {} });

      // Simulate several "at the menu" frames: only pollGamepad, never readPlayerThrottle.
      for (let i = 0; i < 30; i++) manager.pollGamepad(1 / 60);

      // The keyboard's internal ramp must still be at 0 — pollGamepad never touched it.
      expect(manager.readPlayerThrottle(0)).toBe(0);
    });
  });
});
