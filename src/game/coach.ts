// Real-time throttle coach: tells the player when to go, hold, or brake.
// DOM-free and pure over its own small carried-forward state (the committed
// zone + hysteresis timer) — main.ts feeds it the player's interpolated
// {s, v} once per frame and reads back {zone, headroom} for the HUD widget
// (ui/coach.ts). Lives in game/ (NOT sim/) but reuses the AI's own
// buildSpeedProfile (sim/ai/speedProfile.ts) as a READ-ONLY import: the same
// "how fast can this car safely carry this corner" question the AI already
// answers for itself is exactly what a beginner needs answered out loud, at
// a brisk-but-safe (not racing-line) margin.
import type { Tuning } from '../config/tuning';
import { clamp } from '../sim/math';
import { buildSpeedProfile } from '../sim/ai/speedProfile';
import type { LanePath } from '../sim/track/path';

/** The coach's own fixed "brisk-but-safe" difficulty fed to buildSpeedProfile — NOT the AI opponent's difficulty. Deliberately brisker than a nervous learner but with real margin under the CURRENT grip cfg, so raising stickiness raises the suggested speeds automatically (recompute() picks up a cfg's higher gripHard/gripSoft the same way the AI would). */
const COACH_DIFFICULTY = 0.85;

/** How far ahead (seconds of travel at the current speed) the coach reads the profile — anticipatory braking, same idea as the AI driver's own lookahead (sim/ai/driver.ts), tuned separately per the M10 brief. */
const LOOKAHEAD_SEC = 0.25;

/** ratio = v / target(lookahead). Below this: plenty of room, 'go'. */
const GO_THRESHOLD = 0.85;
/** Above this: over the safe target, 'brake'. Between GO_THRESHOLD and this (inclusive both ends): 'hold'. */
const BRAKE_THRESHOLD = 1.0;
/** A raw zone must persist this long (seconds) before it commits, EXCEPT 'brake', which is immediate (a safety cue never delayed). Prevents lamp flicker right at a threshold. */
const HYSTERESIS_SEC = 0.08;

export type CoachZone = 'go' | 'hold' | 'brake';

export interface CoachAdvice {
  zone: CoachZone;
  /** (target − v)/target, clamped to [0, 1] — 0 = at or over the safe target (no room left), 1 = maximal headroom. Drives the HUD gauge; not itself hysteresis-gated (only `zone` is). */
  headroom: number;
}

export interface Coach {
  /** Rebuilds the internal speed profile for a new cfg (e.g. a live stickiness change) — call whenever the grip cfg changes mid-session. Does not reset the current committed zone/hysteresis state. */
  recompute(cfg: Tuning): void;
  /** One call per frame with the player's (interpolated) arc-length position and speed, and the frame's dt (for the hysteresis timer). */
  advise(state: { s: number; v: number }, dt: number): CoachAdvice;
}

function zoneForRatio(ratio: number): CoachZone {
  if (ratio > BRAKE_THRESHOLD) return 'brake';
  if (ratio >= GO_THRESHOLD) return 'hold';
  return 'go';
}

export function createCoach(lane: LanePath, cfg: Tuning): Coach {
  let profile = buildSpeedProfile(lane, cfg, COACH_DIFFICULTY);

  // Hysteresis state: `committed` is the zone advise() actually reports.
  // `pendingZone`/`pendingSince` track a DIFFERENT raw zone that hasn't
  // persisted long enough yet to replace it. null `committed` means "no
  // reading yet" — the very first call commits its raw zone immediately
  // (nothing to flicker against).
  let committed: CoachZone | null = null;
  let pendingZone: CoachZone | null = null;
  let pendingSince = 0;

  function recompute(newCfg: Tuning): void {
    profile = buildSpeedProfile(lane, newCfg, COACH_DIFFICULTY);
  }

  function advise(state: { s: number; v: number }, dt: number): CoachAdvice {
    const targetS = state.s + state.v * LOOKAHEAD_SEC;
    const target = profile.at(targetS);
    const ratio = target > 0 ? state.v / target : 0;
    const rawZone = zoneForRatio(ratio);

    if (committed === null) {
      committed = rawZone; // first reading: nothing to debounce against
    } else if (rawZone === 'brake') {
      committed = 'brake'; // safety cue: engages immediately, every time
      pendingZone = null;
      pendingSince = 0;
    } else if (rawZone === committed) {
      pendingZone = null; // already showing this zone; clear any stale pending timer
      pendingSince = 0;
    } else {
      if (rawZone === pendingZone) {
        pendingSince += dt;
      } else {
        pendingZone = rawZone;
        pendingSince = dt;
      }
      if (pendingSince >= HYSTERESIS_SEC) {
        committed = rawZone;
        pendingZone = null;
        pendingSince = 0;
      }
    }

    const headroom = target > 0 ? clamp((target - state.v) / target, 0, 1) : 0;
    return { zone: committed, headroom };
  }

  return { recompute, advise };
}
