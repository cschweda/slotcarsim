import { afterEach, describe, expect, it, vi } from 'vitest';
import { createGamepadThrottle } from './gamepad';

interface FakeButton {
  value: number;
}
interface FakePad {
  mapping: string;
  buttons: FakeButton[];
  axes: number[];
}

function stubPads(pads: (FakePad | null)[]): void {
  vi.stubGlobal('navigator', {
    getGamepads: () => pads,
  });
}

function standardPad(rt: number): FakePad {
  const buttons: FakeButton[] = Array.from({ length: 17 }, () => ({ value: 0 }));
  buttons[7] = { value: rt };
  return { mapping: 'standard', buttons, axes: [] };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('createGamepadThrottle', () => {
  it('is not connected when no pad is present, and reads 0', () => {
    stubPads([]);
    const source = createGamepadThrottle();
    expect(source.connected).toBe(false);
    expect(source.read(0)).toBe(0);
  });

  it('is connected when a pad is present', () => {
    stubPads([standardPad(0.5)]);
    const source = createGamepadThrottle();
    expect(source.connected).toBe(true);
  });

  it('standard mapping reads buttons[7].value (RT) with the deadzone applied', () => {
    stubPads([standardPad(0.515)]);
    const source = createGamepadThrottle();
    expect(source.read(0)).toBeCloseTo(0.5, 12);
  });

  it('deadzone: values < 0.03 read 0, and full trigger reads exactly 1', () => {
    stubPads([standardPad(0.02)]);
    const source = createGamepadThrottle();
    expect(source.read(0)).toBe(0);

    stubPads([standardPad(1)]);
    expect(source.read(0)).toBeCloseTo(1, 12);
  });

  it('uses the first connected pad, skipping null slots', () => {
    stubPads([null, standardPad(0.515)]);
    const source = createGamepadThrottle();
    expect(source.connected).toBe(true);
    expect(source.read(0)).toBeCloseTo(0.5, 12);
  });

  it('non-standard mapping: falls back to the first button with analog value > 0.05', () => {
    const buttons: FakeButton[] = Array.from({ length: 4 }, () => ({ value: 0 }));
    buttons[2] = { value: 0.515 };
    stubPads([{ mapping: '', buttons, axes: [] }]);
    const source = createGamepadThrottle();
    expect(source.read(0)).toBeCloseTo(0.5, 12);
  });

  it('non-standard mapping: falls back to an axis away from the -1 resting value, normalized (v+1)/2', () => {
    const buttons: FakeButton[] = Array.from({ length: 4 }, () => ({ value: 0 }));
    // axis 2 = 0.03 -> normalized (0.03+1)/2 = 0.515 -> deadzone -> 0.5
    stubPads([{ mapping: '', buttons, axes: [-1, -1, 0.03, -1] }]);
    const source = createGamepadThrottle();
    expect(source.read(0)).toBeCloseTo(0.5, 12);
  });

  it('remembers the discovered fallback index across reads, rather than re-scanning every time', () => {
    const buttons: FakeButton[] = Array.from({ length: 4 }, () => ({ value: 0 }));
    buttons[2] = { value: 0.515 }; // -> 0.5 after deadzone
    const pad = { mapping: '', buttons, axes: [] };
    stubPads([pad]);
    const source = createGamepadThrottle();
    expect(source.read(0)).toBeCloseTo(0.5, 12); // discovers button 2

    // Button 0 (earlier index) now ALSO becomes analog-active, with a value
    // that reads distinguishably differently (1.0) from button 2's (0.515).
    // A naive re-scan-every-read implementation would jump to button 0.
    pad.buttons[0] = { value: 1.0 };
    expect(source.read(0)).toBeCloseTo(0.5, 12); // still button 2, unchanged
  });

  it('re-scans for a fallback control after a disconnect/reconnect', () => {
    const buttons1: FakeButton[] = Array.from({ length: 4 }, () => ({ value: 0 }));
    buttons1[2] = { value: 0.515 };
    stubPads([{ mapping: '', buttons: buttons1, axes: [] }]);
    const source = createGamepadThrottle();
    expect(source.read(0)).toBeCloseTo(0.5, 12); // discovers button 2

    stubPads([]); // disconnect
    expect(source.read(0)).toBe(0);
    expect(source.connected).toBe(false);

    // Reconnect with a DIFFERENT active control this time (axis-based) —
    // must re-scan, not stay stuck looking at the old pad's button 2.
    const buttons2: FakeButton[] = Array.from({ length: 4 }, () => ({ value: 0 }));
    stubPads([{ mapping: '', buttons: buttons2, axes: [-1, -1, 0.03, -1] }]);
    expect(source.read(0)).toBeCloseTo(0.5, 12); // discovers axis 2 fresh
  });

  it('never caches the Gamepad object — reflects a freshly returned pad at the same slot', () => {
    stubPads([standardPad(0.515)]);
    const source = createGamepadThrottle();
    expect(source.read(0)).toBeCloseTo(0.5, 12);

    stubPads([standardPad(1)]); // brand-new object at the same slot index
    expect(source.read(0)).toBeCloseTo(1, 12);
  });

  it('is labeled Gamepad', () => {
    stubPads([standardPad(0)]);
    const source = createGamepadThrottle();
    expect(source.label).toBe('Gamepad');
  });
});
