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
});
