import { describe, expect, it } from 'vitest';
import { TRACKS } from '../../config/tracks';
import { TUNING } from '../../config/tuning';
import { createRng } from '../rng';
import { buildTrack } from '../track/builder';
import type { CarState } from '../types';
import { createAiDriver, noiseAmplitude, reactionSeconds } from './driver';

const DT = 1 / 120;
const oval = buildTrack(TRACKS.oval.refs);
const lane = oval.lanes[0];

function baseState(overrides: Partial<CarState> = {}): CarState {
  return {
    s: 0,
    v: 0,
    lane: 0,
    lapCount: 0,
    slideYaw: 0,
    aLatFiltered: 0,
    hardTicks: 0,
    phase: 'slot',
    phaseTicks: 0,
    generation: 0,
    tumble: null,
    ...overrides,
  };
}

describe('reactionSeconds(difficulty)', () => {
  // M9 humanization retune: the d=1 floor moved from 40 ms to 70 ms — even a
  // "perfect" driver now reacts at a distinctly human pace, not a robotic
  // instant. Deliberate change, not a regression.
  it('spans 70–150 ms (d=1 → 70 ms, d=0 → 150 ms)', () => {
    expect(reactionSeconds(1)).toBeCloseTo(0.07, 12);
    expect(reactionSeconds(0)).toBeCloseTo(0.15, 12);
    expect(reactionSeconds(0.35)).toBeGreaterThan(reactionSeconds(1));
    expect(reactionSeconds(0.35)).toBeLessThan(reactionSeconds(0));
  });
});

describe('noiseAmplitude(difficulty)', () => {
  // M9 humanization retune: amplitudes roughly doubled (were ±3%/±8%) so the
  // throttle tremor reads as visible breathing at every difficulty, not just
  // numerical jitter. Deliberate change, not a regression.
  it('is ±5% at d=1 and ±12% at d=0.35', () => {
    expect(noiseAmplitude(1)).toBeCloseTo(0.05, 12);
    expect(noiseAmplitude(0.35)).toBeCloseTo(0.12, 12);
  });
});

describe('createAiDriver', () => {
  it('reaction ring length matches the difficulty (round(reactionSeconds/dt))', () => {
    for (const d of [0.35, 0.65, 0.9, 1]) {
      const driver = createAiDriver(lane, TUNING, d, createRng(1));
      driver.throttleFor(baseState(), DT); // fixes dt / sizes the ring
      expect(driver.reactionSteps).toBe(Math.max(1, Math.round(reactionSeconds(d) / DT)));
    }
    // Higher difficulty → shorter reaction ring.
    const easy = createAiDriver(lane, TUNING, 0.35, createRng(1));
    const hard = createAiDriver(lane, TUNING, 1, createRng(1));
    easy.throttleFor(baseState(), DT);
    hard.throttleFor(baseState(), DT);
    expect(hard.reactionSteps).toBeLessThan(easy.reactionSteps);
  });

  it('always returns a throttle in [0, 1]', () => {
    const driver = createAiDriver(lane, TUNING, 0.65, createRng(7));
    let s = 0;
    let v = 0;
    for (let i = 0; i < 2000; i++) {
      const t = driver.throttleFor(baseState({ s, v }), DT);
      expect(t).toBeGreaterThanOrEqual(0);
      expect(t).toBeLessThanOrEqual(1);
      // crude forward integration to sweep the whole lane
      v = Math.max(0, v + (t - 0.4) * 2 * DT);
      s = (s + v * DT) % lane.totalLength;
    }
  });

  it('is deterministic: the same seed yields an identical throttle sequence', () => {
    const run = () => {
      const driver = createAiDriver(lane, TUNING, 0.35, createRng(42));
      const out: number[] = [];
      let s = 0;
      let v = 1;
      for (let i = 0; i < 1500; i++) {
        const t = driver.throttleFor(baseState({ s, v }), DT);
        out.push(t);
        v = Math.max(0, Math.min(3, v + (t - 0.35) * 3 * DT));
        s = (s + v * DT) % lane.totalLength;
      }
      return out;
    };
    const a = run();
    const b = run();
    expect(a).toEqual(b);
  });

  it('different seeds diverge (the humanization is actually seeded, not constant)', () => {
    // Integrate forward so the car spends time in corners at mid-range throttle
    // (on a straight the target saturates throttle to 1, hiding the tremor).
    const run = (seed: number) => {
      const driver = createAiDriver(lane, TUNING, 0.35, createRng(seed));
      const out: number[] = [];
      let s = 0;
      let v = 1;
      for (let i = 0; i < 1500; i++) {
        const t = driver.throttleFor(baseState({ s, v }), DT);
        out.push(t);
        v = Math.max(0, Math.min(3, v + (t - 0.35) * 3 * DT));
        s = (s + v * DT) % lane.totalLength;
      }
      return out;
    };
    expect(run(1)).not.toEqual(run(2));
  });

  it('brakes for a corner: floors it when the target is far above v, lifts off when far below', () => {
    const driver = createAiDriver(lane, TUNING, 0.9, createRng(1));
    // Warm the ring at the query state so the delayed target reflects it.
    // On a straight (s at the start) the profile is huge → target ≫ v → floor.
    let onStraight = 0;
    for (let i = 0; i < 40; i++) onStraight = driver.throttleFor(baseState({ s: 0.1, v: 1.0 }), DT);
    expect(onStraight).toBeGreaterThan(0.8);

    // Deep in a corner going much too fast → target ≪ v → let off (brake).
    // Find a high-curvature s and set v well above its cap.
    const driver2 = createAiDriver(lane, TUNING, 0.9, createRng(1));
    let sCorner = 0;
    let maxK = 0;
    for (let i = 0; i < 2000; i++) {
      const k = Math.abs(lane.pointAt((i / 2000) * lane.totalLength).curvature);
      if (k > maxK) {
        maxK = k;
        sCorner = (i / 2000) * lane.totalLength;
      }
    }
    let inCorner = 1;
    for (let i = 0; i < 40; i++) inCorner = driver2.throttleFor(baseState({ s: sCorner, v: 3.0 }), DT);
    expect(inCorner).toBeLessThan(0.2);
  });
});
