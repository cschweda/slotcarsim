// The AI driver: a per-tick throttle policy that tracks the speed profile with
// anticipatory braking, plus difficulty-scaled human fallibility (reaction
// lag, throttle tremor, occasional brake-point misjudgment). Pure over its OWN
// seeded rng — the world hands each AI car its own createRng(seed*31+carIndex)
// so AI decisions never touch the shared world rng that drives tumble
// kinematics (determinism.test.ts's draw order stays exactly per-M3).
//
// Control law: a motor-inverting feedforward for the (reaction-delayed) target
// speed, plus a P correction on speed error, clamped to [0, 1]. Because the
// clamp floors at 0, "target far below v" collapses to zero throttle — the
// exact −brakeK·v dynamic-brake the speed profile's backward pass assumes, so
// the car sheds speed into a corner right on the brakeable envelope. (No
// derivative term: the motor's back-EMF damps the loop; a raw dv/dt on the
// hard-driving motor only induces per-tick bang-bang that collapses corner speed.)
import type { Tuning } from '../../config/tuning';
import { clamp } from '../math';
import type { Rng } from '../rng';
import type { LanePath } from '../track/path';
import type { CarState } from '../types';
import { buildSpeedProfile } from './speedProfile';

/** How far ahead (seconds of travel) the driver reads the profile — anticipatory braking. */
const LOOKAHEAD_SEC = 0.18;

// Reaction delay ring: 70 ms at d=1 up to 150 ms at d=0. (M9 humanization
// retune: the floor was 40 ms — even a "perfect" d=1 driver now reacts at a
// distinctly human ~70 ms rather than a robotic instant.)
const REACTION_MIN_SEC = 0.07;
const REACTION_MAX_SEC = 0.15;

// P gain on the speed-tracking error (the feedforward carries the steady
// state, so KP only rejects disturbance). No derivative term: the motor's own
// back-EMF (car/motor.ts's −backEmfK·v) already damps the loop, and a raw
// dv/dt derivative on the hard-driving/braking motor (±10 m/s² per tick) just
// drives a per-tick bang-bang oscillation that collapses corner speed. Tuned
// in the headless suite (d=1 holds its line cleanly, zero deslots).
const KP = 1.8;

// Low-pass throttle tremor. Amplitude ±5% at d=1 … ±12% at d=0.35 (M9
// humanization retune: was ±3%/±8% — up across the board so it reads as
// visible breathing, not just numerical jitter); a short-ish filter so the
// tremor wanders faster than the deslot dwell can accumulate a sustained
// corner overshoot (keeps a clean d=1 driver clean).
const NOISE_TAU = 0.09;
const NOISE_AMP_AT_1 = 0.05;
const NOISE_AMP_AT_035 = 0.12;

// Scheduled brake-point misjudgment (overshoot) / early-lift (undershoot)
// events. M9 humanization retune: both intervals are more frequent than
// before (was [8,20]/[25,45]) — a "perfect" d=1 driver now visibly hesitates
// or misjudges every 12–25s instead of 25–45s.
const EVENT_INTERVAL_LOW = [7, 16] as const; // difficulty ≤ 0.5: frequent
const EVENT_INTERVAL_HIGH = [12, 25] as const; // difficulty > 0.5: rarer, but still frequent
const EVENT_BUMP = [0.12, 0.18] as const; // overshoot: raw target-speed bump fraction, still fallibility-scaled (unchanged — this is what keeps the d=1.0 zero-deslot guarantee)
const EVENT_DURATION = [0.35, 0.5] as const; // overshoot duration, seconds
// Undershoot (M9 new): braking early / lifting off on a straight — target
// scaled DOWN, so it can never raise the car's speed above the safe profile
// and therefore never risks a deslot at ANY difficulty. Applied at full
// random magnitude regardless of difficulty (unlike overshoot, which is
// fallibility-scaled) — this is deliberately what gives even a d=1.0
// "perfect" driver visible personality, since its overshoot events are
// scaled to zero effect.
//
// Deviation from the brief's stated 0.85–0.95, disclosed: the brief also asks
// for a per-seed settled-lap-time spread of >=0.15s at EVERY difficulty,
// including d=1.0/0.9 — but a single 0.85–0.95 event (the brief's literal
// range), at ~0.4–0.8s against a ~1.75–1.8s lap, costs at most ~0.10–0.13s of
// lap time (confirmed empirically across hundreds of seeds: noise amplitude
// has almost no effect on this figure — a doubled noise amplitude moved the
// observed spread by only a few thousandths, since the tremor's short 0.09s
// tau averages out over a full lap; the event magnitude is what dominates).
// Widening the lower bound to 0.78 (a 22% max lift/early-brake, up from 15%)
// was the smallest change found empirically that makes >=0.15s reachable
// (with margin) at every difficulty via a real, findable seed — see
// headless.test.ts's "not a robot" pins for the exact (difficulty, seed)
// pairs this was calibrated against.
const UNDERSHOOT_MULTIPLIER = [0.78, 0.95] as const; // direct target multiplier (a 5–22% lift/early-brake)
const UNDERSHOOT_DURATION = [0.4, 0.8] as const; // seconds
/** Fraction of triggered events that are undershoot rather than overshoot. */
const UNDERSHOOT_WEIGHT = 0.6;
const EVENT_DIFFICULTY_SPLIT = 0.5;
/** Reference difficulty at/below which a misjudgment lands with full force. */
const FALLIBILITY_FLOOR_D = 0.35;

/** Reaction-delay seconds for a difficulty (linear, 70 ms at d=1 → 150 ms at d=0). */
export function reactionSeconds(difficulty: number): number {
  return REACTION_MAX_SEC - (REACTION_MAX_SEC - REACTION_MIN_SEC) * clamp(difficulty, 0, 1);
}

/** Throttle-tremor amplitude for a difficulty (±5% at d=1 … ±12% at d=0.35). */
export function noiseAmplitude(difficulty: number): number {
  const t = (1 - difficulty) / (1 - FALLIBILITY_FLOOR_D); // 0 at d=1, 1 at d=0.35
  return NOISE_AMP_AT_1 + (NOISE_AMP_AT_035 - NOISE_AMP_AT_1) * clamp(t, 0, 1);
}

/**
 * How fallible the driver is, in [0, 1]: 1 at d≤0.35 (a misjudgment lands at
 * its full 1.12–1.18 overshoot), fading to 0 at d=1. This reconciles the
 * brief's two fixed numbers — the 1.12–1.18 event overshoot and the margin(d)
 * corner headroom — with its hard contract (d=1 never deslots, d=0.35 does):
 * at d=1 the margin leaves only ~3.7% speed headroom, so ANY event overshoot
 * would deslot the "perfect" driver; scaling the overshoot by fallibility(d)
 * keeps d=1 inside its headroom while d=0.35 (12% headroom) is exceeded by the
 * full-force events. Verified numerically in headless.test.ts.
 */
function fallibility(difficulty: number): number {
  return clamp((1 - difficulty) / (1 - FALLIBILITY_FLOOR_D), 0, 1);
}

/**
 * Feedforward: the throttle whose steady state holds `target` m/s, from the
 * motor model (car/motor.ts). Solving `accelPerVolt·Veff − backEmfK·v −
 * rollingDrag = 0` for Veff, then inverting the response curve. `linear`
 * inverts directly; `authentic`/`stepped` invert the resistor divider (stepped
 * is close enough at the coarse band count the AI drives through). Clamped so a
 * huge straight-line target simply saturates to full throttle.
 */
function throttleForSpeed(target: number, cfg: Tuning, extraDecel = 0): number {
  const veffNeeded =
    (cfg.backEmfK * Math.max(0, target) + cfg.rollingDrag + Math.max(0, extraDecel)) / cfg.accelPerVolt;
  if (veffNeeded <= 0) return 0;
  if (cfg.responseMode === 'linear') {
    return clamp(veffNeeded / cfg.supplyV, 0, 1);
  }
  const t = 1 - (cfg.motorR * (cfg.supplyV / veffNeeded - 1)) / cfg.controllerR;
  return clamp(t, 0, 1);
}

export interface AiDriver {
  /** Reaction-delay ring length in ticks; 0 until the first throttleFor() fixes dt. */
  readonly reactionSteps: number;
  /** Throttle 0..1 for this tick, given the car's pre-step state and the fixed dt. */
  throttleFor(state: CarState, dt: number): number;
}

export function createAiDriver(
  lane: LanePath,
  cfg: Tuning,
  difficulty: number,
  rng: Rng,
): AiDriver {
  const profile = buildSpeedProfile(lane, cfg, difficulty);
  const reactionSec = reactionSeconds(difficulty);
  const noiseAmp = noiseAmplitude(difficulty);
  const fall = fallibility(difficulty);
  const interval = difficulty > EVENT_DIFFICULTY_SPLIT ? EVENT_INTERVAL_HIGH : EVENT_INTERVAL_LOW;

  // Reaction ring (targets), sized lazily once dt is known on the first call.
  let ring: number[] | null = null;
  let ringPtr = 0;

  let noiseState = 0;

  // Event scheduler clock (seconds since driver creation).
  let clock = 0;
  let eventActive = false;
  let eventEndsAt = 0;
  let eventMultiplier = 1;
  let nextEventAt = rng.range(interval[0], interval[1]);

  function throttleFor(state: CarState, dt: number): number {
    clock += dt;

    // --- Scheduled brake-point misjudgment (overshoot) / early-lift (undershoot) ---
    // Two-sided (M9 humanization retune): ~60% of triggered events are
    // undershoot (braking early / lifting off — always safe, so applied at
    // full random magnitude regardless of difficulty) and ~40% are the
    // original overshoot (still fallibility-scaled, so the d=1.0
    // zero-deslot guarantee holds exactly as before).
    if (!eventActive && clock >= nextEventAt) {
      if (rng.next() < UNDERSHOOT_WEIGHT) {
        eventMultiplier = rng.range(UNDERSHOOT_MULTIPLIER[0], UNDERSHOOT_MULTIPLIER[1]);
        eventEndsAt = clock + rng.range(UNDERSHOOT_DURATION[0], UNDERSHOOT_DURATION[1]);
      } else {
        const bump = rng.range(EVENT_BUMP[0], EVENT_BUMP[1]) * fall;
        eventMultiplier = 1 + bump;
        eventEndsAt = clock + rng.range(EVENT_DURATION[0], EVENT_DURATION[1]);
      }
      eventActive = true;
    } else if (eventActive && clock >= eventEndsAt) {
      eventActive = false;
      eventMultiplier = 1;
      nextEventAt = clock + rng.range(interval[0], interval[1]);
    }

    // --- Target from the profile, read ahead and (mis)judged ---
    // The lookahead lets the driver see a corner coming and brake early, but it
    // must NEVER raise the target above what's safe at the CURRENT position:
    // taking the min with profile.at(s) stops the car accelerating out of a
    // corner while it's still in the curvature (which would spike aLat past
    // gripHard and deslot). So lookahead only ever lowers the target — pure
    // braking anticipation — which is what keeps the tight-margin d=1 line clean.
    const lookaheadS = state.s + state.v * LOOKAHEAD_SEC;
    const baseTarget = Math.min(profile.at(lookaheadS), profile.at(state.s));
    const rawTarget = baseTarget * (eventActive ? eventMultiplier : 1);

    // --- Reaction delay: act on the target we perceived `reactionSteps` ago ---
    if (ring === null) {
      const n = Math.max(1, Math.round(reactionSec / dt));
      ring = new Array<number>(n).fill(rawTarget);
      ringPtr = 0;
    }
    const delayedTarget = ring[ringPtr]!;
    ring[ringPtr] = rawTarget;
    ringPtr = (ringPtr + 1) % ring.length;

    // --- Feedforward + P on speed error ---
    // The feedforward also replaces the slide's speed-scrub (car/cornering.ts
    // bleeds scrubPerAccel·(aLat−gripSoft) once the target sits above gripSoft,
    // which it does in the corners at higher difficulty): without this, a
    // higher-margin car scrubs harder and paradoxically laps SLOWER than a
    // low-margin one. Compensating it keeps corner speed ordered by difficulty.
    const kappaHere = Math.abs(lane.pointAt(state.s).curvature);
    const aLatTarget = delayedTarget * delayedTarget * kappaHere;
    const scrub = aLatTarget > cfg.gripSoft ? cfg.scrubPerAccel * (aLatTarget - cfg.gripSoft) : 0;
    const error = delayedTarget - state.v;
    let throttle = throttleForSpeed(delayedTarget, cfg, scrub) + KP * error;

    // --- Low-pass throttle tremor (from the driver's own rng) ---
    const sample = rng.range(-noiseAmp, noiseAmp);
    noiseState += (sample - noiseState) * clamp(dt / NOISE_TAU, 0, 1);
    throttle += noiseState;

    return clamp(throttle, 0, 1);
  }

  return {
    get reactionSteps() {
      return ring === null ? 0 : ring.length;
    },
    throttleFor,
  };
}
