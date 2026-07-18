// Lateral grip model: filtered cornering demand → progressive tail-out slide
// with speed scrub → sustained-overlimit deslot trigger. Pure per-tick
// function over a small carried-forward state slice; car.ts folds the result
// back into CarState every tick.
//
// Curvature sign convention (matches sim/track/path.ts): κ>0 turns left, κ<0
// turns right. On a left turn the corner's center is to the car's left (see
// track/builder.ts), so grip loss swings the tail to the RIGHT — the nose
// rotates INTO the turn. That makes slideYaw's sign track sign(κ) directly:
// positive on a left turn, negative on a right turn, zero on a straight.
import type { Tuning } from '../../config/tuning';
import { clamp } from '../math';
import { aLatEff } from './aLatEff';

export interface CorneringState {
  /** First-order-filtered lateral demand, in m/s². */
  aLatFiltered: number;
  /** Slide yaw offset added to path heading, in rad. */
  slideYaw: number;
  /** Consecutive ticks aLatFiltered has exceeded gripHard. */
  hardTicks: number;
}

export interface CorneringResult extends CorneringState {
  /** Additional longitudinal decel to apply this tick, in m/s² (world subtracts it). */
  scrubDecel: number;
  /** True the instant the hard-limit dwell requirement is met. */
  deslotTriggered: boolean;
}

/** Slide yaw never exceeds this magnitude, in rad — a crude visual/physical cap. */
const SLIDE_YAW_CAP = 0.6;

export function stepCornering(
  state: CorneringState,
  v: number,
  kappa: number,
  dt: number,
  cfg: Tuning,
  bank = 0,
): CorneringResult {
  // M12: the raw v²·|κ| is replaced by the SHARED aLatEff (car/aLatEff.ts) —
  // the same helper the AI's speed profile inverts, so a banked corner raises
  // the deslot speed in lockstep with the line the AI plans. `bank` defaults to
  // 0, and aLatEff(v, κ, 0, g) === v²·|κ| bit-for-bit, so every pre-M12 caller
  // and flat-track tick is byte-identical. Everything downstream (filter, slide,
  // scrub, dwell) consumes the effective demand unchanged.
  const aLat = aLatEff(v, kappa, bank, cfg.gravity);

  const filterBlend = clamp(dt / cfg.latFilterTau, 0, 1);
  const aLatFiltered = state.aLatFiltered + (aLat - state.aLatFiltered) * filterBlend;

  const over = Math.max(0, aLatFiltered - cfg.gripSoft);
  const targetMagnitude = Math.min(cfg.yawPerAccel * over, SLIDE_YAW_CAP);
  const target = Math.sign(kappa) * targetMagnitude;

  const slideBlend = clamp(dt / cfg.slideTau, 0, 1);
  const slideYaw = state.slideYaw + (target - state.slideYaw) * slideBlend;

  const scrubDecel = cfg.scrubPerAccel * over;

  const hardTicks = aLatFiltered > cfg.gripHard ? state.hardTicks + 1 : 0;
  const dwellTicks = Math.round(cfg.deslotDwell / dt);
  const deslotTriggered = hardTicks >= dwellTicks;

  return { aLatFiltered, slideYaw, hardTicks, scrubDecel, deslotTriggered };
}
