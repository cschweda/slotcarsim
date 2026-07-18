// Pure math for the synthesized motor voices — no AudioContext, no DOM, no
// Math.random here (that lives in motorVoice.ts's noise-buffer generation,
// which is genuinely audio-only randomness, never sim). Kept separate from
// engine.ts/motorVoice.ts specifically so it is trivially unit-testable
// (vitest's node environment) and so the curves themselves — the actual
// "sound design" — are reviewable as plain numbers, not buried in WebAudio
// node wiring.
//
// One-way dependency onto sim/math's `clamp`, matching the project's
// documented dependency direction (audio/ consumes sim/, never the reverse).
import { clamp } from '../sim/math';

/** Fundamental frequency floor/ceiling, in Hz — see motorF0. */
const F0_MIN = 120;
const F0_MAX = 640;
const F0_RANGE = F0_MAX - F0_MIN;

/**
 * Motor fundamental pitch for a given speed: `120 + 520·(v/vmax)` Hz, clamped
 * to [120, 640]. v may transiently exceed vmax while tuning (or dip negative
 * from float noise) — both clamp to an endpoint rather than extrapolating.
 */
export function motorF0(v: number, vmax: number): number {
  const f0 = F0_MIN + F0_RANGE * (v / vmax);
  return clamp(f0, F0_MIN, F0_MAX);
}

/**
 * Stereo pan for a table-space x position: the signed offset from the table
 * center, scaled by the table half-width, clamped to [-1, 1] (StereoPannerNode
 * range). `centerX` is a param (not hardcoded) — callers pass the track
 * centroid; a car past the table edge (mid-tumble) just pins to full pan
 * rather than exceeding it.
 */
export function panForX(x: number, centerX: number, tableHalfWidth: number): number {
  const xCentered = x - centerX;
  return clamp(xCentered / tableHalfWidth, -1, 1);
}

export interface MotorGains {
  /** Fundamental (triangle osc) branch gain, 0..1. */
  tone: number;
  /** Commutator-buzz (3·f0 square + tracking bandpass) branch gain, 0..1. */
  buzz: number;
  /** Brush-hiss (filtered noise) branch gain, 0..1. */
  hiss: number;
}

/** Below this speed the car reads as fully stopped, not just slow. */
const MOVING_V = 0.01;
/** Below this trigger position the controller reads as released, not driving (mirrors, but is deliberately decoupled from, config/tuning.ts's throttleDeadband — this file has zero sim/config coupling by design). */
const THROTTLE_DEADBAND = 0.02;
/** Tone never fully vanishes once rolling — a stopped-but-silent motor doesn't ease in from zero pitch. */
const TONE_FLOOR = 0.15;

const SILENT_GAINS: MotorGains = { tone: 0, buzz: 0, hiss: 0 };

/**
 * Per-branch gains for one motor voice this frame. Each stays in [0, 1] and is
 * monotone in its stated driver:
 *  - tone: monotone non-decreasing in v (0 below MOVING_V, else a 0.15 floor
 *    rising linearly to 1 at v=vmax) — the clean fundamental hum, louder the
 *    faster the armature spins.
 *  - buzz: monotone non-decreasing in throttle, monotone non-increasing in v
 *    below top speed — `throttle · (1 − v/vmax)`, the commutator noise from
 *    current draw under load, which vanishes as back-EMF closes the gap at
 *    top speed regardless of trigger position.
 *  - hiss: monotone non-decreasing in v, proportional (`v/vmax`) — brush
 *    noise scales with rotation speed alone.
 * Silent (all zero) exactly when the car is stopped (v < 0.01) AND the
 * trigger is released (throttle < deadband) — otherwise buzz alone can keep a
 * stalled-but-driven motor audible (wheelspin), and tone/hiss alone can keep a
 * coasting-but-throttle-off car audible.
 */
export function motorGains(throttle: number, v: number, vmax: number): MotorGains {
  if (v < MOVING_V && throttle < THROTTLE_DEADBAND) {
    return SILENT_GAINS;
  }

  const vFrac = clamp(v / vmax, 0, 1);
  const tone = v < MOVING_V ? 0 : TONE_FLOOR + (1 - TONE_FLOOR) * vFrac;
  const slip = clamp(1 - v / vmax, 0, 1);
  const buzz = clamp(throttle, 0, 1) * slip;
  const hiss = vFrac;

  return { tone, buzz, hiss };
}
