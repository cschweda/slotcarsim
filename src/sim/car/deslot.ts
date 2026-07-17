// Tumble/marshal state machine: what happens after cornering.ts's deslot
// trigger fires. One rng draw at the moment of deslot (kick fraction + spin
// rate) fully determines the tumble; everything after is deterministic
// kinematics through two fixed-duration phases (tumbling → waiting) and back
// onto the track at the exit point. Pure — no rng/DOM/three anywhere here.
import type { Tuning } from '../../config/tuning';
import type { Vec2 } from '../math';
import { rot } from '../math';
import type { Rng } from '../rng';
import type { TumbleState } from '../types';

export type DeslotPhase = 'tumbling' | 'waiting';

const KICK_FRACTION_MIN = 0.2;
const KICK_FRACTION_MAX = 0.5;
const SPIN_RATE_MIN = 6;
const SPIN_RATE_MAX = 14;
/** Fraction of exit speed applied as the outward kick's magnitude scale. */
const KICK_SPEED_FACTOR = 0.35;

/**
 * Begins a tumble: captures the exit pose/speed and draws ONCE from rng for
 * the kick fraction and spin rate. Outward side and spin sign both follow
 * −sign(κ) — the tail (already hanging outward per slideYaw) continues
 * swinging the same way into a spin as it lets go; "outward" on a left turn
 * (κ>0) is to the car's right, matching track/builder.ts's convention that a
 * left turn's center — and so its inward side — is to the car's left.
 */
export function beginTumble(
  exitPos: Vec2,
  exitHeadingWithSlide: number,
  exitS: number,
  exitSpeed: number,
  kappa: number,
  rng: Rng,
  cfg: Tuning,
): TumbleState {
  const kickFraction = rng.range(KICK_FRACTION_MIN, KICK_FRACTION_MAX);
  const spinMagnitude = rng.range(SPIN_RATE_MIN, SPIN_RATE_MAX);
  const outwardSign = -Math.sign(kappa);

  const tangent = rot({ x: 1, y: 0 }, exitHeadingWithSlide);
  const outward = rot({ x: 0, y: outwardSign }, exitHeadingWithSlide);
  const kick = KICK_SPEED_FACTOR * exitSpeed * kickFraction;

  return {
    x: exitPos.x,
    y: exitPos.y,
    vx: exitSpeed * tangent.x + kick * outward.x,
    vy: exitSpeed * tangent.y + kick * outward.y,
    yaw: exitHeadingWithSlide,
    yawRate: outwardSign * spinMagnitude,
    exitS,
  };
}

function phaseDurationTicks(phase: DeslotPhase, cfg: Tuning, dt: number): number {
  const seconds = phase === 'tumbling' ? cfg.tumbleDuration : cfg.marshalDuration;
  return Math.round(seconds / dt);
}

export interface DeslotStepResult {
  tumble: TumbleState;
  phase: DeslotPhase | 'slot';
  phaseTicks: number;
  /** True on exactly the tick the car returns to the slot. */
  reslotted: boolean;
}

/**
 * Advances one tick of tumbling/waiting. Pure function of (tumble, phase,
 * phaseTicks) — no wall-clock, no rng. `phaseTicks` is ticks ALREADY spent in
 * `phase` before this call; the returned `phaseTicks` resets to 0 whenever
 * the phase itself changes.
 */
export function stepDeslot(
  tumble: TumbleState,
  phase: DeslotPhase,
  phaseTicks: number,
  dt: number,
  cfg: Tuning,
): DeslotStepResult {
  let advanced: TumbleState = tumble;

  if (phase === 'tumbling') {
    const speed = Math.hypot(tumble.vx, tumble.vy);
    const decelerated = Math.max(0, speed - cfg.tumbleFriction * dt);
    const scale = speed > 0 ? decelerated / speed : 0;
    const vx = tumble.vx * scale;
    const vy = tumble.vy * scale;
    advanced = {
      ...tumble,
      x: tumble.x + vx * dt,
      y: tumble.y + vy * dt,
      vx,
      vy,
      yaw: tumble.yaw + tumble.yawRate * dt,
    };
  }
  // 'waiting': the car sits where it stopped — no kinematics to advance.

  const newPhaseTicks = phaseTicks + 1;
  const durationTicks = phaseDurationTicks(phase, cfg, dt);

  if (newPhaseTicks >= durationTicks) {
    if (phase === 'tumbling') {
      return {
        tumble: { ...advanced, vx: 0, vy: 0 },
        phase: 'waiting',
        phaseTicks: 0,
        reslotted: false,
      };
    }
    return { tumble: advanced, phase: 'slot', phaseTicks: 0, reslotted: true };
  }

  return { tumble: advanced, phase, phaseTicks: newPhaseTicks, reslotted: false };
}

export interface TumblePoseInput {
  phase: DeslotPhase;
  phaseTicks: number;
  tumble: TumbleState;
}

export interface TumblePose {
  phase: DeslotPhase;
  /** Fraction of the current phase elapsed, in [0, 1]. Render-side bounce/height (M5) is a function of this. */
  progress: number;
  pos: Vec2;
  yaw: number;
}

/**
 * Read-only view for the renderer — does not advance state. `dt` is the
 * sim's fixed tick (not stored on CarState, so it's threaded through
 * explicitly here rather than assumed).
 */
export function tumblePose(state: TumblePoseInput, cfg: Tuning, dt: number): TumblePose {
  const durationTicks = phaseDurationTicks(state.phase, cfg, dt);
  const progress = durationTicks > 0 ? Math.min(1, state.phaseTicks / durationTicks) : 1;
  return {
    phase: state.phase,
    progress,
    pos: { x: state.tumble.x, y: state.tumble.y },
    yaw: state.tumble.yaw,
  };
}
