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
};

/** The shape every sim/input/ui module reads tuning through — same object, never cloned. */
export type Tuning = typeof TUNING;
