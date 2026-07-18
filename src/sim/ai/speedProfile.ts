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
import { maxCornerSpeed } from '../car/aLatEff';
import type { LanePath } from '../track/path';

/** Arc-length spacing of profile samples, in meters (10 mm per the brief). */
const SAMPLE_STEP = 0.01;
/** Curvature floor so a straight (κ=0) yields a finite (huge) cap, not ∞. */
const CURVATURE_FLOOR = 1e-6;
/**
 * Hard cap on backward sweeps. The cyclic relaxation provably converges in
 * ≤3 sweeps on a flat track (each corner minimum propagates backward through
 * the array in one sweep and around the wrap in a second; a third confirms no
 * change) — this is only a safety net, and speedProfile.test.ts asserts the
 * real count is ≤3. M12: a graded track's nonlinear grade term (below) can add
 * one settling sweep; the Daytona Sweep pin allows ≤4.
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

  // Corner cap via the SHARED aLatEff inverse (car/aLatEff.ts) — the exact
  // helper the chassis grip model uses, so a banked corner's higher cap and the
  // car's higher deslot speed are the same closed form. On a flat, unbanked
  // sample this is bit-for-bit the pre-M12 sqrt(margin·gripHard/|κ|). grade[i]
  // is captured here for the backward pass below (0 on flat pieces).
  const vCap: number[] = new Array(count);
  const grade: number[] = new Array(count);
  const marginSpeed = Math.sqrt(margin); // the flat cap/deslot speed ratio (see below)
  for (let i = 0; i < count; i++) {
    const pt = lane.pointAt(i * ds);
    const kappa = Math.max(Math.abs(pt.curvature), CURVATURE_FLOOR);
    const bank = pt.bank ?? 0;
    // Keep the SAME fractional speed headroom below the deslot speed whether the
    // corner is flat or banked. On flat (bank 0) this is bit-for-bit the pre-M12
    // sqrt(margin·gripHard/|κ|). On a bank the gravity-assist term (+G·sinθ) adds
    // EQUALLY to the cap and the true deslot speed, which would shrink the AI's
    // SPEED headroom from ~3.6% to ~2.5% at d=1 and trip the tight-margin line
    // right at the apex — so the margin is applied instead as a fractional speed
    // discount off the real deslot speed (factor sqrt(margin), the exact flat
    // ratio), giving a banked corner the identical headroom a flat one gets.
    vCap[i] =
      bank === 0
        ? maxCornerSpeed(cfg.gripHard * margin, kappa, 0, cfg.gravity)
        : maxCornerSpeed(cfg.gripHard, kappa, bank, cfg.gravity) * marginSpeed;
    grade[i] = pt.grade ?? 0;
  }

  // Cyclic backward braking pass. v starts at the caps and is only ever
  // lowered by the brakeable-from-the-next-sample constraint, so it converges
  // monotonically. M12 grade term: a downhill (grade < 0) reduces the
  // deceleration gravity leaves for braking, so the feasible entry speed drops.
  const v = vCap.slice();
  const brakeStep = cfg.brakeK * ds;
  let sweeps = 0;
  for (;;) {
    sweeps += 1;
    let changed = false;
    for (let i = count - 1; i >= 0; i--) {
      const next = (i + 1) % count;
      const g = grade[i]!;
      // Flat (g === 0): the exact pre-M12 linear bound v[i+1] + brakeK·ds
      // (dv/ds = −brakeK), preserved BIT-for-BIT so flat tracks never move.
      // Graded: the kinematic bound v[i]² = v[i+1]² + 2·(brakeK·v[i+1] + G·g)·ds.
      const cand =
        g === 0
          ? v[next]! + brakeStep
          : Math.sqrt(
              Math.max(0, v[next]! * v[next]! + 2 * (cfg.brakeK * v[next]! + cfg.gravity * g) * ds),
            );
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
