import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { TUNING } from '../config/tuning';
import { createKeyboardThrottle } from './keyboard';

type Listener = (event: { code: string; preventDefault: () => void }) => void;

/** Minimal fake EventTarget so this test needs no jsdom/window. */
class FakeTarget {
  private listeners = new Map<string, Set<Listener>>();

  addEventListener(type: string, listener: Listener): void {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type)!.add(listener);
  }

  removeEventListener(type: string, listener: Listener): void {
    this.listeners.get(type)?.delete(listener);
  }

  dispatch(type: string, code: string): { prevented: boolean } {
    const result = { prevented: false };
    const event = {
      code,
      preventDefault: () => {
        result.prevented = true;
      },
    };
    for (const listener of this.listeners.get(type) ?? []) listener(event);
    return result;
  }
}

const originalRampRate = TUNING.keyboardRampRate;

beforeEach(() => {
  TUNING.keyboardRampRate = originalRampRate;
});

afterEach(() => {
  TUNING.keyboardRampRate = originalRampRate;
});

describe('createKeyboardThrottle', () => {
  it('reads 0 when no throttle key is held', () => {
    const target = new FakeTarget();
    const throttle = createKeyboardThrottle(target as unknown as EventTarget);
    expect(throttle.read(1 / 60)).toBe(0);
  });

  it('ramps up at keyboardRampRate/s while Space is held', () => {
    const target = new FakeTarget();
    const throttle = createKeyboardThrottle(target as unknown as EventTarget);
    TUNING.keyboardRampRate = 2.5;

    target.dispatch('keydown', 'Space');
    expect(throttle.read(0.1)).toBeCloseTo(0.25, 12);
    expect(throttle.read(0.1)).toBeCloseTo(0.5, 12);
  });

  it('ramps up while ArrowUp is held (either key works)', () => {
    const target = new FakeTarget();
    const throttle = createKeyboardThrottle(target as unknown as EventTarget);
    TUNING.keyboardRampRate = 2.5;

    target.dispatch('keydown', 'ArrowUp');
    expect(throttle.read(0.1)).toBeCloseTo(0.25, 12);
  });

  it('clamps at 1 even if held past full ramp time', () => {
    const target = new FakeTarget();
    const throttle = createKeyboardThrottle(target as unknown as EventTarget);
    TUNING.keyboardRampRate = 2.5;

    target.dispatch('keydown', 'Space');
    expect(throttle.read(10)).toBe(1);
    expect(throttle.read(1)).toBe(1);
  });

  it('releasing the held key snaps throttle to 0 immediately (before the next read)', () => {
    const target = new FakeTarget();
    const throttle = createKeyboardThrottle(target as unknown as EventTarget);
    TUNING.keyboardRampRate = 2.5;

    target.dispatch('keydown', 'Space');
    throttle.read(1); // ramp up to 1 (clamped)
    target.dispatch('keyup', 'Space');
    // A read with a tiny dt right after release must already read 0 — the
    // brief requires an immediate snap, not a fast ramp-down.
    expect(throttle.read(1 / 1200)).toBe(0);
  });

  it('holding both Space and ArrowUp, releasing only one, keeps ramping (not a premature snap-to-0)', () => {
    const target = new FakeTarget();
    const throttle = createKeyboardThrottle(target as unknown as EventTarget);
    TUNING.keyboardRampRate = 2.5;

    target.dispatch('keydown', 'Space');
    target.dispatch('keydown', 'ArrowUp');
    throttle.read(0.1);
    target.dispatch('keyup', 'Space'); // ArrowUp is still held
    expect(throttle.read(0.1)).toBeCloseTo(0.5, 12); // continued ramping, not reset

    target.dispatch('keyup', 'ArrowUp'); // now nothing is held
    expect(throttle.read(1 / 1200)).toBe(0);
  });

  it('calls preventDefault on Space/ArrowUp keydown and keyup, but not on other keys', () => {
    const target = new FakeTarget();
    createKeyboardThrottle(target as unknown as EventTarget);

    expect(target.dispatch('keydown', 'Space').prevented).toBe(true);
    expect(target.dispatch('keyup', 'Space').prevented).toBe(true);
    expect(target.dispatch('keydown', 'ArrowUp').prevented).toBe(true);
    expect(target.dispatch('keydown', 'KeyA').prevented).toBe(false);
  });

  it('re-reads TUNING.keyboardRampRate live (mid-hold rate changes take effect immediately)', () => {
    const target = new FakeTarget();
    const throttle = createKeyboardThrottle(target as unknown as EventTarget);

    TUNING.keyboardRampRate = 1;
    target.dispatch('keydown', 'Space');
    expect(throttle.read(1)).toBeCloseTo(1, 12);

    target.dispatch('keyup', 'Space');
    target.dispatch('keydown', 'Space');
    TUNING.keyboardRampRate = 6; // dev drags the debugPanel slider mid-hold
    expect(throttle.read(0.1)).toBeCloseTo(0.6, 12);
  });

  it('is always connected and labeled Keyboard', () => {
    const target = new FakeTarget();
    const throttle = createKeyboardThrottle(target as unknown as EventTarget);
    expect(throttle.connected).toBe(true);
    expect(throttle.label).toBe('Keyboard');
  });
});
