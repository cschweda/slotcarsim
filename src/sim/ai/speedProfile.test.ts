import { describe, expect, it } from 'vitest';
import { TRACKS } from '../../config/tracks';
import { TUNING } from '../../config/tuning';
import { buildTrack } from '../track/builder';
import type { LanePath } from '../track/path';
import { buildSpeedProfile, speedMargin } from './speedProfile';

const oval = buildTrack(TRACKS.oval.refs);
const lane: LanePath = oval.lanes[0];

describe('speedMargin(difficulty)', () => {
  it('matches the brief anchors: d=1 → 0.93, d=0.35 → ~0.79, d=0 → 0.72', () => {
    expect(speedMargin(1)).toBeCloseTo(0.93, 12);
    expect(speedMargin(0.35)).toBeCloseTo(0.7935, 12);
    expect(speedMargin(0)).toBeCloseTo(0.72, 12);
  });

  it('is strictly increasing in difficulty', () => {
    expect(speedMargin(0.9)).toBeGreaterThan(speedMargin(0.35));
  });
});

describe('buildSpeedProfile', () => {
  it('samples at ~10 mm steps around the whole lane', () => {
    const p = buildSpeedProfile(lane, TUNING, 0.65);
    expect(p.step).toBeGreaterThan(0.009);
    expect(p.step).toBeLessThan(0.011);
    expect(p.count).toBe(Math.round(lane.totalLength / 0.01));
    // Samples span exactly one lap.
    expect(p.count * p.step).toBeCloseTo(lane.totalLength, 9);
  });

  it('the corner cap equals sqrt(gripHard·margin/|κ|) at every sample', () => {
    const d = 0.65;
    const p = buildSpeedProfile(lane, TUNING, d);
    const m = speedMargin(d);
    for (let i = 0; i < p.count; i++) {
      const kappa = Math.abs(lane.pointAt(i * p.step).curvature);
      const expected = Math.sqrt((TUNING.gripHard * m) / Math.max(kappa, 1e-6));
      expect(p.vCap[i]).toBeCloseTo(expected, 9);
    }
  });

  it('straights are effectively uncapped (motor-limited, not corner-limited)', () => {
    const p = buildSpeedProfile(lane, TUNING, 1);
    // On the oval, the max cap (a straight, κ≈0) is enormous vs vmax.
    expect(Math.max(...p.vCap)).toBeGreaterThan(100);
  });

  it('the feasible profile never exceeds the corner caps', () => {
    const p = buildSpeedProfile(lane, TUNING, 0.9);
    for (let i = 0; i < p.count; i++) {
      expect(p.v[i]).toBeLessThanOrEqual(p.vCap[i]! + 1e-9);
    }
  });

  it('the profile is brakeable everywhere: v[i] − v[i+1] ≤ brakeK·ds (closed loop)', () => {
    const p = buildSpeedProfile(lane, TUNING, 0.9);
    const brakeStep = TUNING.brakeK * p.step;
    for (let i = 0; i < p.count; i++) {
      const next = (i + 1) % p.count;
      expect(p.v[i]! - p.v[next]!).toBeLessThanOrEqual(brakeStep + 1e-9);
    }
  });

  it('the cyclic backward pass converges in ≤ 3 sweeps', () => {
    for (const d of [0.35, 0.65, 0.9, 1]) {
      const p = buildSpeedProfile(lane, TUNING, d);
      expect(p.sweeps).toBeLessThanOrEqual(3);
    }
  });

  it('is monotone in difficulty: a higher difficulty is nowhere slower', () => {
    const easy = buildSpeedProfile(lane, TUNING, 0.35);
    const hard = buildSpeedProfile(lane, TUNING, 0.9);
    expect(hard.count).toBe(easy.count); // same lane → same sampling
    for (let i = 0; i < hard.count; i++) {
      expect(hard.v[i]).toBeGreaterThanOrEqual(easy.v[i]! - 1e-12);
    }
  });

  it('at(s) linearly interpolates and wraps modulo the lane length', () => {
    const p = buildSpeedProfile(lane, TUNING, 0.65);
    // Exact sample points.
    expect(p.at(0)).toBeCloseTo(p.v[0]!, 9);
    expect(p.at(p.step)).toBeCloseTo(p.v[1]!, 9);
    // Midpoint between sample 0 and 1.
    expect(p.at(p.step / 2)).toBeCloseTo((p.v[0]! + p.v[1]!) / 2, 9);
    // Wrapping: at(L) === at(0).
    expect(p.at(lane.totalLength)).toBeCloseTo(p.at(0), 9);
    expect(p.at(-p.step)).toBeCloseTo(p.v[p.count - 1]!, 9);
  });

  it('a tighter corner is capped slower than a gentler one', () => {
    // Lane 0 inner-lane corner (κ high) vs a straight sample (κ≈0).
    const p = buildSpeedProfile(lane, TUNING, 0.65);
    const cornerCap = Math.min(...p.vCap);
    const straightCap = Math.max(...p.vCap);
    expect(cornerCap).toBeLessThan(straightCap);
    expect(cornerCap).toBeGreaterThan(0);
  });
});
