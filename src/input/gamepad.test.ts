import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CALIBRATION_DURATION_SEC,
  createGamepadThrottle,
  rumbleOnDeslot,
  rumbleOnReslot,
} from './gamepad';

interface FakeButton {
  value: number;
}
interface FakePad {
  id?: string;
  mapping: string;
  buttons: FakeButton[];
  axes: number[];
  vibrationActuator?: { playEffect: (type: string, params: unknown) => Promise<unknown> };
}

function stubPads(pads: (FakePad | null)[]): void {
  vi.stubGlobal('navigator', {
    getGamepads: () => pads,
  });
}

function standardPad(rt: number, id = 'standard-pad'): FakePad {
  const buttons: FakeButton[] = Array.from({ length: 17 }, () => ({ value: 0 }));
  buttons[7] = { value: rt };
  return { id, mapping: 'standard', buttons, axes: [] };
}

/** Simple in-memory localStorage stand-in (real Storage interface has more, gamepad.ts only needs get/set). */
class FakeStorage {
  private data = new Map<string, string>();
  getItem(key: string): string | null {
    return this.data.has(key) ? this.data.get(key)! : null;
  }
  setItem(key: string, value: string): void {
    this.data.set(key, value);
  }
}

/** Drive `read(dt)` for `frames` iterations, calling `setFrame(i)` to mutate pad state before each read. Returns the last read() result. */
function driveFrames(
  source: { read(dt: number): number },
  dt: number,
  frames: number,
  setFrame?: (i: number) => void,
): number {
  let last = 0;
  for (let i = 0; i < frames; i++) {
    setFrame?.(i);
    last = source.read(dt);
  }
  return last;
}

/** Frame count comfortably clearing the calibration window at a given dt (a few extra frames past the exact threshold, immune to float-boundary rounding). */
function framesToClearCalibration(dt: number): number {
  return Math.ceil(CALIBRATION_DURATION_SEC / dt) + 10;
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

  it('standard mapping reads buttons[7].value (RT) with the deadzone applied — no calibration gate', () => {
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

// ===========================================================================
// M8: calibration wizard
// ===========================================================================
// A brand-new NON-standard gamepad.id now auto-runs a 5s calibration wizard
// before its throttle reading is usable (buttons[7] on a `standard`-mapping
// pad is trusted immediately and skips this entirely) — so the tests below
// that exercise a fresh non-standard pad drive it THROUGH the wizard first
// (feeding `read(dt)` with a real dt, per CALIBRATION_DURATION_SEC), then
// assert on the calibrated reading, rather than the old immediate-fallback
// value. This supersedes the pre-M8 "falls back immediately" behavior for a
// pad's FIRST sighting; discoverFallback itself is unchanged and still runs
// (see the "nothing moves" tests below) whenever calibration finds no result.
describe('calibration wizard — non-standard mapping', () => {
  it('returns 0 throughout the active calibration window, regardless of the raw pad value', () => {
    const buttons: FakeButton[] = Array.from({ length: 4 }, () => ({ value: 0 }));
    const pad: FakePad = { id: 'pad-a', mapping: '', buttons, axes: [] };
    stubPads([pad]);
    const source = createGamepadThrottle();

    const dt = 0.1;
    // Well within the 5s window (10 frames * 0.1s = 1s) — some movement, but must still read 0.
    for (let i = 0; i < 10; i++) {
      pad.buttons[2] = { value: i % 2 === 0 ? 0 : 0.7 };
      expect(source.read(dt)).toBe(0);
    }
  });

  it('picks the control with the LARGEST range of motion, not just the first one that moved', () => {
    const buttons: FakeButton[] = Array.from({ length: 4 }, () => ({ value: 0 }));
    const pad: FakePad = { id: 'pad-b', mapping: '', buttons, axes: [] };
    stubPads([pad]);
    const source = createGamepadThrottle();

    const dt = 0.1;
    const frames = framesToClearCalibration(dt);
    driveFrames(source, dt, frames, (i) => {
      const mid = Math.floor(frames / 2);
      // Button 1: a small squeeze (range 0.3). Button 2: a bigger squeeze
      // (range 0.8) — button 1 moved FIRST (lower index) but button 2 has
      // the larger range and must be the one chosen.
      pad.buttons[1] = { value: i > 2 && i < mid ? 0.3 : 0 };
      pad.buttons[2] = { value: i >= mid ? 0.8 : 0 };
    });

    // Leave button 1 at its OWN rest value (0) and set button 2 to a clear
    // mid-range value: if button 1 had been (wrongly) chosen, this reads 0
    // (rest); only if button 2 (the larger range) was chosen does it read
    // the mid-range value's normalized+deadzone result. (An earlier draft of
    // this test set button 1 to an out-of-range 1.0 "to prove no effect" —
    // that value clamps to 1 regardless of WHICH button was picked, since
    // button 1's own calibrated max would also clamp-saturate to 1, so it
    // couldn't actually distinguish the two hypotheses. Verified by
    // deliberately breaking pickBestControl to a first-mover rule: this
    // version fails as expected, the old version didn't.)
    pad.buttons[1] = { value: 0 };
    pad.buttons[2] = { value: 0.4 }; // half of button 2's observed 0.8 range
    expect(source.read(dt)).toBeCloseTo((0.5 - 0.03) / (1 - 0.03), 6);
  });

  it('rescales rest..max to 0..1 and then applies the existing deadzone', () => {
    const buttons: FakeButton[] = Array.from({ length: 4 }, () => ({ value: 0.1 })); // a pad that rests at 0.1, not 0
    const pad: FakePad = { id: 'pad-c', mapping: '', buttons, axes: [] };
    stubPads([pad]);
    const source = createGamepadThrottle();

    const dt = 0.1;
    const frames = framesToClearCalibration(dt);
    const mid = Math.floor(frames / 2);
    driveFrames(source, dt, frames, (i) => {
      pad.buttons[3] = { value: i > 2 && i < mid ? 0.9 : 0.1 }; // rest 0.1, squeeze to 0.9
    });

    // At rest (0.1) -> normalized 0 -> reads 0.
    pad.buttons[3] = { value: 0.1 };
    expect(source.read(dt)).toBe(0);
    // At the observed max (0.9) -> normalized 1 -> reads 1.
    pad.buttons[3] = { value: 0.9 };
    expect(source.read(dt)).toBeCloseTo(1, 6);
    // Halfway (0.5) -> normalized 0.5 -> deadzone-adjusted per applyDeadzone(0.5).
    pad.buttons[3] = { value: 0.5 };
    expect(source.read(dt)).toBeCloseTo((0.5 - 0.03) / (1 - 0.03), 9);
  });

  it('calibrates an axis control too (normalized the same way as a button)', () => {
    const buttons: FakeButton[] = Array.from({ length: 2 }, () => ({ value: 0 }));
    const pad: FakePad = { id: 'pad-axis', mapping: '', buttons, axes: [-1, -1] };
    stubPads([pad]);
    const source = createGamepadThrottle();

    const dt = 0.1;
    const frames = framesToClearCalibration(dt);
    const mid = Math.floor(frames / 2);
    driveFrames(source, dt, frames, (i) => {
      pad.axes = [-1, i > 2 && i < mid ? 1 : -1]; // axis 1 sweeps from rest (-1) to full (1)
    });

    pad.axes = [-1, -1];
    expect(source.read(dt)).toBeCloseTo(0, 6);
    pad.axes = [-1, 1];
    expect(source.read(dt)).toBeCloseTo(1, 6);
  });

  it('persists the calibration to localStorage keyed by gamepad.id, applied on the very next read after the window ends', () => {
    vi.stubGlobal('localStorage', new FakeStorage());
    const buttons: FakeButton[] = Array.from({ length: 3 }, () => ({ value: 0 }));
    const pad: FakePad = { id: 'pad-persist', mapping: '', buttons, axes: [] };
    stubPads([pad]);
    const source = createGamepadThrottle();

    const dt = 0.1;
    const frames = framesToClearCalibration(dt);
    const mid = Math.floor(frames / 2);
    driveFrames(source, dt, frames, (i) => {
      pad.buttons[0] = { value: i > 2 && i < mid ? 0.6 : 0 };
    });

    const stored = localStorage.getItem('slotcar.gamepadCalibration');
    expect(stored).not.toBeNull();
    const parsed = JSON.parse(stored!);
    expect(parsed['pad-persist']).toEqual({ kind: 'button', index: 0, rest: 0, max: 0.6 });
  });

  it('a fresh createGamepadThrottle() (simulated reload) reuses a persisted calibration without re-running the wizard', () => {
    const storage = new FakeStorage();
    storage.setItem(
      'slotcar.gamepadCalibration',
      JSON.stringify({ 'pad-reload': { kind: 'button', index: 0, rest: 0, max: 0.6 } }),
    );
    vi.stubGlobal('localStorage', storage);

    const buttons: FakeButton[] = Array.from({ length: 2 }, () => ({ value: 0.6 }));
    const pad: FakePad = { id: 'pad-reload', mapping: '', buttons, axes: [] };
    stubPads([pad]);
    const source = createGamepadThrottle();

    // No calibration window this time — the stored calibration applies immediately.
    expect(source.read(0)).toBeCloseTo(1, 6);
    expect(source.calibrating).toBe(false);
  });

  it('if nothing moves during the window, no calibration is stored and discoverFallback is used from then on (sticky index, re-scans on reconnect)', () => {
    const buttons1: FakeButton[] = Array.from({ length: 4 }, () => ({ value: 0 }));
    const pad: FakePad = { id: 'pad-flat', mapping: '', buttons: buttons1, axes: [] };
    stubPads([pad]);
    const source = createGamepadThrottle();

    const dt = 0.1;
    driveFrames(source, dt, framesToClearCalibration(dt)); // completely flat the whole window

    // Now behaves exactly like the pre-M8 fallback mechanism: discovers
    // button 2 and remembers it (sticky), ignoring a later-activating earlier index.
    pad.buttons[2] = { value: 0.515 };
    expect(source.read(dt)).toBeCloseTo(0.5, 12);
    pad.buttons[0] = { value: 1.0 };
    expect(source.read(dt)).toBeCloseTo(0.5, 12); // still button 2, unchanged

    // Disconnect/reconnect re-scans fresh, as before.
    stubPads([]);
    expect(source.read(dt)).toBe(0);
    const buttons2: FakeButton[] = Array.from({ length: 4 }, () => ({ value: 0 }));
    stubPads([{ id: 'pad-flat', mapping: '', buttons: buttons2, axes: [-1, -1, 0.03, -1] }]);
    expect(source.read(dt)).toBeCloseTo(0.5, 12); // discovers axis 2 fresh
  });

  it('standard mapping never enters the calibration wizard, even on a brand-new id', () => {
    stubPads([standardPad(0.515, 'brand-new-standard-pad')]);
    const source = createGamepadThrottle();
    expect(source.read(0)).toBeCloseTo(0.5, 12); // immediate, no 5s dead zone
    expect(source.calibrating).toBe(false);
  });

  it('?calibrate forces the wizard to re-run even on a standard-mapping pad', () => {
    vi.stubGlobal('window', { location: { search: '?calibrate' } });
    const pad = standardPad(0.6, 'forced-standard-pad');
    stubPads([pad]);
    const source = createGamepadThrottle();

    expect(source.read(0)).toBe(0); // calibrating now, even though mapping === 'standard'
    expect(source.calibrating).toBe(true);
  });

  it('?calibrate forces re-calibration even when a calibration is already stored for this id', () => {
    const storage = new FakeStorage();
    storage.setItem(
      'slotcar.gamepadCalibration',
      JSON.stringify({ 'pad-recal': { kind: 'button', index: 0, rest: 0, max: 0.6 } }),
    );
    vi.stubGlobal('localStorage', storage);
    vi.stubGlobal('window', { location: { search: '?calibrate' } });

    const buttons: FakeButton[] = Array.from({ length: 2 }, () => ({ value: 0.6 }));
    const pad: FakePad = { id: 'pad-recal', mapping: '', buttons, axes: [] };
    stubPads([pad]);
    const source = createGamepadThrottle();

    expect(source.read(0)).toBe(0); // re-calibrating despite the existing stored entry
    expect(source.calibrating).toBe(true);
  });

  it('exposes calibrating/calibrationSecondsLeft while the wizard runs, both clearing once it completes', () => {
    const buttons: FakeButton[] = Array.from({ length: 2 }, () => ({ value: 0 }));
    const pad: FakePad = { id: 'pad-progress', mapping: '', buttons, axes: [] };
    stubPads([pad]);
    const source = createGamepadThrottle();

    source.read(1); // 1s elapsed
    expect(source.calibrating).toBe(true);
    expect(source.calibrationSecondsLeft).toBeCloseTo(CALIBRATION_DURATION_SEC - 1, 9);

    driveFrames(source, 1, CALIBRATION_DURATION_SEC); // clears the remaining window
    expect(source.calibrating).toBe(false);
    expect(source.calibrationSecondsLeft).toBe(0);
  });

  it('never throws when localStorage/window are unavailable (defensive guards)', () => {
    // No window/localStorage stubbed at all in this test (vitest's node env has neither).
    const buttons: FakeButton[] = Array.from({ length: 2 }, () => ({ value: 0 }));
    const pad: FakePad = { id: 'pad-no-storage', mapping: '', buttons, axes: [] };
    stubPads([pad]);
    expect(() => {
      const source = createGamepadThrottle();
      driveFrames(source, 0.1, framesToClearCalibration(0.1), (i) => {
        pad.buttons[0] = { value: i % 3 === 0 ? 0.5 : 0 };
      });
    }).not.toThrow();
  });
});

describe('everConnected (HUD connect hint)', () => {
  it('is false until a pad has ever been seen, then stays true even after a disconnect', () => {
    stubPads([]);
    const source = createGamepadThrottle();
    expect(source.everConnected).toBe(false);

    stubPads([standardPad(0)]);
    source.read(0);
    expect(source.everConnected).toBe(true);

    stubPads([]); // disconnect
    source.read(0);
    expect(source.everConnected).toBe(true); // stays true — "has been seen," not "is seen now"
  });
});

// ===========================================================================
// M8: rumble
// ===========================================================================
describe('rumbleOnDeslot / rumbleOnReslot', () => {
  it('do nothing (and never throw) when no gamepad is connected', () => {
    stubPads([]);
    expect(() => rumbleOnDeslot()).not.toThrow();
    expect(() => rumbleOnReslot()).not.toThrow();
  });

  it('do nothing (and never throw) when the connected pad has no vibrationActuator', () => {
    stubPads([standardPad(0)]); // no vibrationActuator field
    expect(() => rumbleOnDeslot()).not.toThrow();
    expect(() => rumbleOnReslot()).not.toThrow();
  });

  it('rumbleOnDeslot plays a strong 300ms dual-rumble effect when available', () => {
    const playEffect = vi.fn().mockResolvedValue('complete');
    stubPads([{ ...standardPad(0), vibrationActuator: { playEffect } }]);

    rumbleOnDeslot();

    expect(playEffect).toHaveBeenCalledWith('dual-rumble', {
      duration: 300,
      strongMagnitude: 0.9,
      weakMagnitude: 0.5,
    });
  });

  it('rumbleOnReslot plays a short, light 80ms pulse when available', () => {
    const playEffect = vi.fn().mockResolvedValue('complete');
    stubPads([{ ...standardPad(0), vibrationActuator: { playEffect } }]);

    rumbleOnReslot();

    expect(playEffect).toHaveBeenCalledWith('dual-rumble', {
      duration: 80,
      strongMagnitude: 0.25,
      weakMagnitude: 0.15,
    });
  });

  it('never throws (and never surfaces an unhandled rejection) when playEffect rejects', async () => {
    const playEffect = vi.fn().mockRejectedValue(new Error('not supported'));
    stubPads([{ ...standardPad(0), vibrationActuator: { playEffect } }]);

    expect(() => rumbleOnDeslot()).not.toThrow();
    // Let the rejected promise's microtask settle; vitest fails the test on
    // an unhandled rejection surfacing during this tick if it isn't caught.
    await Promise.resolve();
    await Promise.resolve();
  });

  it('never throws when playEffect itself throws synchronously', () => {
    const playEffect = vi.fn(() => {
      throw new Error('synchronous haptics failure');
    });
    stubPads([{ ...standardPad(0), vibrationActuator: { playEffect } }]);

    expect(() => rumbleOnDeslot()).not.toThrow();
    expect(() => rumbleOnReslot()).not.toThrow();
  });
});
