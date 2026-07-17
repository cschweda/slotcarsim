import { describe, expect, it } from 'vitest';
import { createLapTimer } from './timing';

describe('createLapTimer', () => {
  it('fires no event while s only moves forward without crossing 0', () => {
    const timer = createLapTimer(10);
    expect(timer.onStep(1, 1 / 120, 0, 1)).toBeNull();
    expect(timer.onStep(2, 1 / 120, 1, 2)).toBeNull();
    expect(timer.onStep(3, 1 / 120, 2, 9.9)).toBeNull();
  });

  it('Δ==0 (stationary on the line) produces no event', () => {
    const timer = createLapTimer(10);
    expect(timer.onStep(1, 1 / 120, 0, 0)).toBeNull();
  });

  it('Δ==0 (stationary elsewhere on the lane) produces no event', () => {
    const timer = createLapTimer(10);
    expect(timer.onStep(1, 1 / 120, 4, 4)).toBeNull();
  });

  it('the first wrap past s=0 completes lap 1 (no event for "leaving the grid")', () => {
    const timer = createLapTimer(10);
    // Car starts at s=0 and only ever wraps once it comes back around.
    expect(timer.onStep(1, 1 / 120, 0, 0.5)).toBeNull();
    const event = timer.onStep(120, 1 / 120, 9.5, 0.5);
    expect(event).not.toBeNull();
    expect(event?.type).toBe('lap');
    expect(event?.lapNumber).toBe(1);
  });

  it('reports carIndex from the constructor (per-car instance)', () => {
    const timer = createLapTimer(10, 3);
    const event = timer.onStep(120, 1 / 120, 9.5, 0.5);
    expect(event?.carIndex).toBe(3);
  });

  it('defaults carIndex to 0 when not given', () => {
    const timer = createLapTimer(10);
    const event = timer.onStep(120, 1 / 120, 9.5, 0.5);
    expect(event?.carIndex).toBe(0);
  });

  it('constant-v car: every lap time is within 1e-6 of L/v, regardless of dt phase', () => {
    const L = 2.8408; // matches the brief's fixture (~inner-lane oval length)
    const v = 1.7;
    const expectedLapTime = L / v;

    // dt chosen so it does NOT evenly divide the lap period — exercises
    // arbitrary sub-tick crossing phase, per the brief.
    const dt = 1 / 97;
    const timer = createLapTimer(L);

    let s = 0;
    let tick = 0;
    const lapTimes: number[] = [];
    const totalTicks = Math.ceil((expectedLapTime * 5.5) / dt); // ~5 laps' worth of ticks

    for (let i = 0; i < totalTicks; i++) {
      tick += 1;
      const sPrev = s;
      s = (s + v * dt) % L;
      const event = timer.onStep(tick, dt, sPrev, s);
      if (event) {
        lapTimes.push(event.lapTimeSec);
      }
    }

    expect(lapTimes.length).toBeGreaterThanOrEqual(5);
    for (const lapTime of lapTimes) {
      expect(Math.abs(lapTime - expectedLapTime)).toBeLessThan(1e-6);
    }
  });

  it('two consecutive laps at different speeds are each measured correctly', () => {
    const L = 10;
    const dt = 1 / 60;
    const timer = createLapTimer(L);

    // Lap 1 at v=2 m/s (period 5s), lap 2 at v=5 m/s (period 2s).
    let s = 0;
    let tick = 0;
    const lapTimes: number[] = [];
    const v1 = 2;
    const lap1Ticks = Math.ceil((L / v1 / dt) * 1.2);
    for (let i = 0; i < lap1Ticks && lapTimes.length < 1; i++) {
      tick += 1;
      const sPrev = s;
      s = (s + v1 * dt) % L;
      const event = timer.onStep(tick, dt, sPrev, s);
      if (event) lapTimes.push(event.lapTimeSec);
    }
    expect(lapTimes).toHaveLength(1);
    // Lap 1 runs at one constant velocity for its entire duration (like the
    // constant-v test above) — the timer's interpolation is essentially
    // exact here too.
    expect(Math.abs(lapTimes[0]! - L / v1)).toBeLessThan(1e-6);

    const v2 = 5;
    const lap2Ticks = Math.ceil((L / v2 / dt) * 1.2);
    for (let i = 0; i < lap2Ticks && lapTimes.length < 2; i++) {
      tick += 1;
      const sPrev = s;
      s = (s + v2 * dt) % L;
      const event = timer.onStep(tick, dt, sPrev, s);
      if (event) lapTimes.push(event.lapTimeSec);
    }
    expect(lapTimes).toHaveLength(2);
    // Lap 2's velocity change lands abruptly at the lap-1/lap-2 boundary, so
    // the single tick straddling that boundary is simulated entirely at v1
    // even though a sliver of it is (in continuous-time terms) "lap 2" — an
    // inherent O(dt) artifact of any fixed-timestep sim's velocity-change
    // handling, not a timer defect (the timer's crossing interpolation
    // itself is exact given whatever (sPrev, sNew) it's fed; verified
    // separately by the constant-v test's 1e-6 precision). Bound by one dt.
    expect(Math.abs(lapTimes[1]! - L / v2)).toBeLessThan(dt);
  });

  it('lap number increments across successive crossings', () => {
    const L = 10;
    const dt = 1 / 60;
    const timer = createLapTimer(L);
    let s = 0;
    let tick = 0;
    const laps: number[] = [];
    for (let i = 0; i < 2000 && laps.length < 3; i++) {
      tick += 1;
      const sPrev = s;
      s = (s + 3 * dt) % L;
      const event = timer.onStep(tick, dt, sPrev, s);
      if (event) laps.push(event.lapNumber);
    }
    expect(laps).toEqual([1, 2, 3]);
  });
});
