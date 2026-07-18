// Steady-state cornering speed profile for the AI driver. For a lane, samples
// a corner-limited speed cap every ~10 mm, then runs a cyclic backward
// braking pass that exploits the motor's EXACT closed-form braking law
// (dv/ds = −brakeK, see car/motor.ts): the fastest speed you can carry at a
// sample while still braking down to the next sample's speed is
// v[i+1] + brakeK·ds. The result is the driver's target-speed envelope —
// full-out on straights (motor-limited), braking into corners.
//
// Pure: no rng, DOM, or three. The steady-state profile deliberately uses the
// RAW curvature |κ(s)|, not the car's first-order-filtered lateral demand —
// the filter is a per-tick chassis transient, whereas this envelope is the
// speed the car can hold indefinitely in the corner.
import type { Tuning } from '../../config/tuning';
import type { LanePath } from '../track/path';

/** Arc-length spacing of profile samples, in meters (10 mm per the brief). */
const SAMPLE_STEP = 0.01;
/** Curvature floor so a straight (κ=0) yields a finite (huge) cap, not ∞. */
const CURVATURE_FLOOR = 1e-6;
/**
 * Hard cap on backward sweeps. The cyclic relaxation provably converges in
 * ≤3 sweeps (each corner minimum propagates backward through the array in one
 * sweep and around the wrap in a second; a third confirms no change) — this is
 * only a safety net, and speedProfile.test.ts asserts the real count is ≤3.
 */
const MAX_SWEEPS = 8;

/**
 * Cornering grip margin as a function of difficulty ∈ [0, 1].
 * `0.72 + 0.21·d`: d=1 → 0.93·gripHard (racing in the slide zone just below
 * deslot), d=0.35 → ~0.79 (brisk but safe, closer to gripSoft comfort).
 */
export function speedMargin(difficulty: number): number {
  return 0.72 + 0.21 * difficulty;
}

export interface SpeedProfile {
  /** Actual sample spacing used, in meters (lane length / count, ≈ SAMPLE_STEP). */
  readonly step: number;
  /** Number of samples around the lane. */
  readonly count: number;
  /** Feasible (brakeable) target speed at each sample, in m/s. */
  readonly v: readonly number[];
  /** Corner cap at each sample (pre-braking-pass), in m/s. */
  readonly vCap: readonly number[];
  /** Backward sweeps taken to converge (≤3 for real tracks). */
  readonly sweeps: number;
  /** Feasible target speed at arc length s (wraps mod lane length; linearly interpolated). */
  at(s: number): number;
}

export function buildSpeedProfile(lane: LanePath, cfg: Tuning, difficulty: number): SpeedProfile {
  const L = lane.totalLength;
  const count = Math.max(1, Math.round(L / SAMPLE_STEP));
  const ds = L / count;
  const margin = speedMargin(difficulty);

  // Corner cap: the steady-state speed at which v²·|κ| = margin·gripHard.
  const vCap: number[] = new Array(count);
  for (let i = 0; i < count; i++) {
    const kappa = Math.abs(lane.pointAt(i * ds).curvature);
    vCap[i] = Math.sqrt((cfg.gripHard * margin) / Math.max(kappa, CURVATURE_FLOOR));
  }

  // Cyclic backward braking pass. v starts at the caps and is only ever
  // lowered by the brakeable-from-the-next-sample constraint, so it converges
  // monotonically to min(vCap[i], min over the loop of vCap[j] + brakeK·dist).
  const v = vCap.slice();
  const brakeStep = cfg.brakeK * ds;
  let sweeps = 0;
  for (;;) {
    sweeps += 1;
    let changed = false;
    for (let i = count - 1; i >= 0; i--) {
      const next = (i + 1) % count;
      const cand = v[next]! + brakeStep;
      if (cand < v[i]!) {
        v[i] = cand;
        changed = true;
      }
    }
    if (!changed || sweeps >= MAX_SWEEPS) break;
  }

  function at(s: number): number {
    const wrapped = ((s % L) + L) % L;
    const f = wrapped / ds;
    const i0 = Math.floor(f) % count;
    const i1 = (i0 + 1) % count;
    const frac = f - Math.floor(f);
    return v[i0]! + (v[i1]! - v[i0]!) * frac;
  }

  return { step: ds, count, v, vCap, sweeps, at };
}
