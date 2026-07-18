// Physics/tuning constants, consumed by sim/car/motor.ts, sim/world.ts, and
// input/keyboard.ts. This is the ONLY place tuning numbers live. All fields
// are flat and live-tunable: ui/debugPanel.ts mutates this object directly at
// runtime, and every consumer re-reads it fresh each call (no caching, no
// cloning) so a mid-race slider drag takes effect on the very next sim step.
export const TUNING = {
  /** Reference top speed target, in m/s — a sanity anchor, not a clamp. */
  vmax: 3.0,
  /** Distance from track centerline to a lane's slot, in meters (19.05mm). */
  laneOffset: 0.01905,
  /** Dynamic (trigger-released) brake deceleration constant, in 1/s (B_short). */
  brakeK: 8,
  /** Wall-pack supply voltage, in V. */
  supplyV: 18,
  /** Motor armature resistance, in Ω (R_m). */
  motorR: 15,
  /** Full-band controller resistance, in Ω (R_c). */
  controllerR: 60,
  /** Accel per effective volt, in (m/s²)/V — A in `a = A·V_eff − B·v − drag`. */
  accelPerVolt: 1.02,
  /** Speed-proportional back-EMF drag while driving, in 1/s (B). */
  backEmfK: 6,
  /** Constant rolling resistance while driving, in m/s². */
  rollingDrag: 0.3,
  /** Trigger values below this count as released (braking), not driving. */
  throttleDeadband: 0.02,
  /** Motor response curve: authentic resistor-divider, linear, or quantized. */
  responseMode: 'authentic' as 'authentic' | 'linear' | 'stepped',
  /** Discrete voltage steps 'stepped' mode quantizes the trigger into. */
  steppedBands: 7,
  /** Keyboard throttle ramp rate while a throttle key is held, in 1/s. */
  keyboardRampRate: 2.5,
  /** Lateral accel where slide begins, in m/s² (plain AFX seed; Magna-Traction reference ≈17). */
  gripSoft: 8,
  /** Lateral accel where deslot triggers (sustained), in m/s² (Magna-Traction reference ≈24). */
  gripHard: 11,
  /** First-order filter time constant on lateral demand ("chassis takes a set"), in s. */
  latFilterTau: 0.05,
  /** Slide yaw response time constant, in s. */
  slideTau: 0.08,
  /** Slide yaw magnitude per (m/s²) of over-soft lateral demand, in rad per (m/s²). */
  yawPerAccel: 0.08,
  /** Speed scrub while sliding: decel per (m/s²) over-soft, in (m/s²) per (m/s²). */
  scrubPerAccel: 0.6,
  /** Hard-limit must be exceeded continuously this long before deslot fires, in s. */
  deslotDwell: 0.04,
  /** Duration of the tumbling phase after deslot, in s. */
  tumbleDuration: 1.1,
  /** Duration of the waiting-for-marshal phase after tumbling, in s. */
  marshalDuration: 0.9,
  /** Ground friction decelerating the tumbling car, in m/s². */
  tumbleFriction: 8,
  /** Gravitational acceleration, in m/s² — powers banked-curve lateral assist and grade (elevation) longitudinal terms (M12). On a flat, unbanked track (bank 0, grade 0) every g-derived term vanishes exactly, so pre-M12 behavior is bit-identical. */
  gravity: 9.81,
};

/** The shape every sim/input/ui module reads tuning through — same object, never cloned. */
export type Tuning = typeof TUNING;

// ---- M10: Stickiness (beginner grip assist) ------------------------------
// A menu-selectable multiplier on TUNING's own gripSoft/gripHard, from
// authentic (1.0×, unchanged) up through a Magna-Traction-like level and a
// deliberately overpowered "Training Glue" level for absolute beginners.
// Captured HERE, once, at module load — decoupled from whatever gripSoft/
// gripHard currently read (which the dev ?tune panel can also drag around) —
// so applying a stickiness level is idempotent: it always re-derives from the
// same fixed 8/11 base, never compounds on a previously-applied level.
const BASE_GRIP_SOFT = TUNING.gripSoft;
const BASE_GRIP_HARD = TUNING.gripHard;

export const STICKINESS_LEVELS = [
  { id: 'authentic', label: 'Authentic AFX', mult: 1.0 },
  { id: 'sticky', label: 'Sticky', mult: 1.5 },
  { id: 'magna', label: 'Magna-Traction', mult: 2.1 },
  { id: 'glue', label: 'Training Glue', mult: 2.7 },
] as const;

export type StickinessLevel = (typeof STICKINESS_LEVELS)[number];
export type StickinessId = StickinessLevel['id'];

/** Index of a stickiness id in STICKINESS_LEVELS (0 = authentic); falls back to 0 for an unrecognized id. */
export function stickinessIndex(id: StickinessId): number {
  const i = STICKINESS_LEVELS.findIndex((level) => level.id === id);
  return i === -1 ? 0 : i;
}

/** gripSoft/gripHard for a stickiness level: the fixed BASE_GRIP_* values times the level's multiplier — the "mapping math" (base 8/11; e.g. magna ≈ 16.8/23.1, matching the documented Magna-Traction reference ~17/24). */
export function stickinessGrip(id: StickinessId): { gripSoft: number; gripHard: number } {
  const level = STICKINESS_LEVELS[stickinessIndex(id)]!;
  return { gripSoft: BASE_GRIP_SOFT * level.mult, gripHard: BASE_GRIP_HARD * level.mult };
}

/**
 * Applies a stickiness level to `cfg` by MUTATING its gripSoft/gripHard in
 * place — the same live-mutation mechanism the dev ?tune panel already uses
 * (src/ui/debugPanel.ts): every sim step re-reads cfg fresh, so this takes
 * effect on the very next tick, no matter whether `cfg` is the shared TUNING
 * singleton or a session-local copy. Called once at session build time and
 * again on every practice-mode live [ ]/[ ] step.
 */
export function applyStickiness(cfg: Tuning, id: StickinessId): void {
  const { gripSoft, gripHard } = stickinessGrip(id);
  cfg.gripSoft = gripSoft;
  cfg.gripHard = gripHard;
}

/**
 * Steps to the next (dir=1, `]`) or previous (dir=-1, `[`) stickiness level,
 * CLAMPED at both ends (never wraps) — a live in-race adjustment shouldn't
 * suddenly jump from the most forgiving level back to the least (or vice
 * versa) just because the player held the key one step too many while mid
 * corner. (The menu's own ‹ › Stickiness row is a separate control and uses
 * the menu's usual wrap-around cycling, like every other setup row.)
 */
export function stepStickiness(id: StickinessId, dir: 1 | -1): StickinessId {
  const i = stickinessIndex(id);
  const next = Math.min(STICKINESS_LEVELS.length - 1, Math.max(0, i + dir));
  return STICKINESS_LEVELS[next]!.id;
}
