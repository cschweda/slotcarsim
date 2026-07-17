// Authentic AFX resistor-controller motor model — longitudinal only
// (cornering/grip arrives in M3). Pure functions over a TUNING-shaped config
// param: no module-level state, so callers can pass live-mutated tuning or a
// frozen test fixture with identical semantics.
import type { Tuning } from '../../config/tuning';

/**
 * Effective motor voltage for a trigger position t in [0, 1].
 *
 * - authentic: the real resistor-divider curve. t=0 is NOT zero volts — it's
 *   the idle-band voltage `supplyV·Rm/(Rm+Rc)` (≈3.6V for the default
 *   constants), because the controller's resistance is only ever partial.
 *   That's authentic (cars crawl at first contact), but it sits below
 *   throttleDeadband, so callers only see it through carAccel's brake branch;
 *   driveAccel only takes over once the trigger clears the deadband.
 * - linear: a comfort mode — V_eff scales directly with t.
 * - stepped: quantizes t up to `steppedBands` equal steps (ceil to the band
 *   edge), then applies the authentic curve — mimics the wirewound-coil
 *   controller's discrete taps.
 */
export function effectiveVolts(trigger: number, cfg: Tuning): number {
  if (cfg.responseMode === 'linear') {
    return trigger * cfg.supplyV;
  }

  const t =
    cfg.responseMode === 'stepped' ? Math.ceil(trigger * cfg.steppedBands) / cfg.steppedBands : trigger;

  return (cfg.supplyV * cfg.motorR) / (cfg.motorR + cfg.controllerR * (1 - t));
}

/**
 * Driving acceleration: `a = A·V_eff − B·v − drag`. May be negative at high
 * speed / partial throttle — that's authentic partial-throttle coasting-down,
 * not a bug, so it is intentionally not clamped here.
 */
export function driveAccel(v: number, trigger: number, cfg: Tuning): number {
  return cfg.accelPerVolt * effectiveVolts(trigger, cfg) - cfg.backEmfK * v - cfg.rollingDrag;
}

/**
 * Dynamic-brake acceleration when the trigger is released: `a = −brakeK·v`,
 * EXACTLY this and no drag term. The shorted motor dominates; keeping this
 * pure (proportional-only) makes `dv/ds` a constant `−brakeK` regardless of
 * v, which is what gives the closed-form brake distance `(v0−v1)/brakeK` that
 * both the tests below and the M7 AI rely on.
 */
export function brakeAccel(v: number, cfg: Tuning): number {
  return -cfg.brakeK * v;
}

/** Below the deadband the controller is off the band entirely → braking; at or above it, driving. */
export function carAccel(v: number, trigger: number, cfg: Tuning): number {
  return trigger < cfg.throttleDeadband ? brakeAccel(v, cfg) : driveAccel(v, trigger, cfg);
}
