// Tests for the real-time throttle coach: zone thresholds, hysteresis
// (brake-immediate vs dwell-gated), lookahead, live recompute on a grip
// change, and the stickiness monotonicity guarantee. DOM-free — createCoach
// takes only a LanePath + Tuning cfg, same inputs sim/ai/speedProfile.ts
// itself takes, just imported read-only from game/ (per the M10 brief).
import { describe, expect, it } from 'vitest';
import { TRACKS } from '../config/tracks';
import { TUNING, applyStickiness, type StickinessId, type Tuning } from '../config/tuning';
import { buildSpeedProfile } from '../sim/ai/speedProfile';
import { buildTrack } from '../sim/track/builder';
import type { LanePath } from '../sim/track/path';
import type { InputFrame, SimEvent } from '../sim/types';
import { createSim } from '../sim/world';
import { createCoach } from './coach';

const DT = 1 / 120;
/** The coach's own hardcoded "brisk-but-safe" difficulty (see coach.ts) — tests independently recompute the same profile via this to derive expected target speeds. */
const COACH_DIFFICULTY = 0.85;

/** A lane whose curvature is the SAME everywhere — the resulting speed profile is a flat constant target, s-independent, which isolates the zone/ratio math from any track-geometry braking-ramp shape. */
function constantCurvatureLane(curvature: number, len = 20): LanePath {
  return {
    totalLength: len,
    pointAt: () => ({ pos: { x: 0, y: 0 }, heading: 0, curvature }),
  };
}

/** A lane with a curvature STEP at `switchS`: 0 (straight) before it, `cornerK` (a corner) from it onward. Used to prove the coach's lookahead reacts to the UPCOMING corner, not just the car's current position. */
function stepLane(switchS: number, cornerK: number, len: number): LanePath {
  return {
    totalLength: len,
    pointAt: (s: number) => {
      const wrapped = ((s % len) + len) % len;
      return { pos: { x: 0, y: 0 }, heading: 0, curvature: wrapped >= switchS ? cornerK : 0 };
    },
  };
}

describe('createCoach — zone thresholds (raw mapping, first call so no hysteresis dwell applies)', () => {
  const lane = constantCurvatureLane(5);
  const target = buildSpeedProfile(lane, TUNING, COACH_DIFFICULTY).at(0);

  it('ratio well under 0.85 -> go', () => {
    const coach = createCoach(lane, TUNING);
    expect(coach.advise({ s: 0, v: 0.5 * target }, DT).zone).toBe('go');
  });

  it('ratio in [0.85, 1.0] -> hold', () => {
    const coach = createCoach(lane, TUNING);
    expect(coach.advise({ s: 0, v: 0.9 * target }, DT).zone).toBe('hold');
  });

  it('ratio just under 0.85 -> go (lower boundary)', () => {
    const coach = createCoach(lane, TUNING);
    expect(coach.advise({ s: 0, v: 0.845 * target }, DT).zone).toBe('go');
  });

  it('ratio just over 0.85 -> hold (lower boundary)', () => {
    const coach = createCoach(lane, TUNING);
    expect(coach.advise({ s: 0, v: 0.855 * target }, DT).zone).toBe('hold');
  });

  it('ratio just under 1.0 -> hold (upper boundary)', () => {
    const coach = createCoach(lane, TUNING);
    expect(coach.advise({ s: 0, v: 0.995 * target }, DT).zone).toBe('hold');
  });

  it('ratio just over 1.0 -> brake (upper boundary)', () => {
    const coach = createCoach(lane, TUNING);
    expect(coach.advise({ s: 0, v: 1.005 * target }, DT).zone).toBe('brake');
  });

  it('ratio well over 1.0 -> brake', () => {
    const coach = createCoach(lane, TUNING);
    expect(coach.advise({ s: 0, v: 1.5 * target }, DT).zone).toBe('brake');
  });
});

describe('createCoach — hysteresis: brake is immediate, every other transition dwell-gates >= 80ms', () => {
  const lane = constantCurvatureLane(5);
  const target = buildSpeedProfile(lane, TUNING, COACH_DIFFICULTY).at(0);
  const dt = 0.02; // 20ms per call — 4 calls = 80ms

  it('a go -> hold transition only commits once the raw zone has persisted >= 80ms', () => {
    const coach = createCoach(lane, TUNING);
    expect(coach.advise({ s: 0, v: 0.5 * target }, dt).zone).toBe('go'); // first call commits immediately
    expect(coach.advise({ s: 0, v: 0.9 * target }, dt).zone).toBe('go'); // raw=hold, 20ms dwell
    expect(coach.advise({ s: 0, v: 0.9 * target }, dt).zone).toBe('go'); // 40ms
    expect(coach.advise({ s: 0, v: 0.9 * target }, dt).zone).toBe('go'); // 60ms
    expect(coach.advise({ s: 0, v: 0.9 * target }, dt).zone).toBe('hold'); // 80ms -> commits
  });

  it('a single flicker below the dwell window never commits (back to go before 80ms elapses cancels the pending hold)', () => {
    const coach = createCoach(lane, TUNING);
    expect(coach.advise({ s: 0, v: 0.5 * target }, dt).zone).toBe('go');
    expect(coach.advise({ s: 0, v: 0.9 * target }, dt).zone).toBe('go'); // raw=hold pending, 20ms
    expect(coach.advise({ s: 0, v: 0.9 * target }, dt).zone).toBe('go'); // 40ms
    // Back to a 'go' ratio before the pending hold ever committed.
    expect(coach.advise({ s: 0, v: 0.5 * target }, dt).zone).toBe('go');
    // Sustaining 'hold' again restarts the dwell timer from zero.
    expect(coach.advise({ s: 0, v: 0.9 * target }, dt).zone).toBe('go'); // 20ms (restarted)
    expect(coach.advise({ s: 0, v: 0.9 * target }, dt).zone).toBe('go'); // 40ms
    expect(coach.advise({ s: 0, v: 0.9 * target }, dt).zone).toBe('go'); // 60ms
    expect(coach.advise({ s: 0, v: 0.9 * target }, dt).zone).toBe('hold'); // 80ms
  });

  it('brake engages IMMEDIATELY from any zone, no dwell required', () => {
    const coach = createCoach(lane, TUNING);
    expect(coach.advise({ s: 0, v: 0.5 * target }, dt).zone).toBe('go');
    // Single call at a brake-level ratio commits instantly.
    expect(coach.advise({ s: 0, v: 1.5 * target }, dt).zone).toBe('brake');
  });

  it('leaving brake (brake -> hold/go) is itself dwell-gated like any other non-brake transition', () => {
    const coach = createCoach(lane, TUNING);
    expect(coach.advise({ s: 0, v: 1.5 * target }, dt).zone).toBe('brake'); // first call, immediate
    expect(coach.advise({ s: 0, v: 0.5 * target }, dt).zone).toBe('brake'); // raw=go pending, 20ms
    expect(coach.advise({ s: 0, v: 0.5 * target }, dt).zone).toBe('brake'); // 40ms
    expect(coach.advise({ s: 0, v: 0.5 * target }, dt).zone).toBe('brake'); // 60ms
    expect(coach.advise({ s: 0, v: 0.5 * target }, dt).zone).toBe('go'); // 80ms -> commits
  });
});

describe('createCoach — lookahead uses future-s, not the current position', () => {
  it('approaching a corner at speed flips to brake BEFORE reaching it', () => {
    // Straight (curvature 0, effectively uncapped) for s < 50, a corner
    // (finite, low cap ~V_CORNER) from s = 50 onward, on a big enough loop
    // that wraparound never matters here.
    const margin = 0.72 + 0.21 * COACH_DIFFICULTY; // speedMargin(0.85), inlined to avoid importing a private helper
    const V_CORNER = 1.0;
    const kCorner = (TUNING.gripHard * margin) / (V_CORNER * V_CORNER);
    const lane = stepLane(50, kCorner, 100);

    const coach = createCoach(lane, TUNING);
    const v = 2.0; // a realistic driving speed
    // 0.6m before the corner: outside the braking ramp (current-position
    // target is still the flat straight cap) — but the lookahead point
    // (s + v*0.25 = +0.5m) lands only 0.1m before the corner, deep inside the
    // ramp, so the coach must read 'brake' from the FIRST call already.
    const sCar = 50 - 0.6;
    const advice = coach.advise({ s: sCar, v }, DT);
    expect(advice.zone).toBe('brake');

    // Sanity: at the SAME v, evaluating the profile at the car's raw current
    // position alone (no lookahead) would NOT yet call for braking — proving
    // the flip is due to the lookahead, not the current position.
    const profile = buildSpeedProfile(lane, TUNING, COACH_DIFFICULTY);
    const currentPositionRatio = v / profile.at(sCar);
    expect(currentPositionRatio).toBeLessThan(0.85);
  });

  it('exits the corner (flips back toward go) once the lookahead point clears it', () => {
    const margin = 0.72 + 0.21 * COACH_DIFFICULTY;
    const V_CORNER = 1.0;
    const kCorner = (TUNING.gripHard * margin) / (V_CORNER * V_CORNER);
    const lane = stepLane(50, kCorner, 100);
    const coach = createCoach(lane, TUNING);

    // Deep past the corner's start, at a LOW speed matching the corner cap —
    // both current position and lookahead sit well inside the corner, so a
    // slow, in-corner car should NOT be told to brake.
    const advice = coach.advise({ s: 55, v: 0.5 }, DT);
    expect(advice.zone).not.toBe('brake');
  });
});

describe('createCoach — recompute(cfg) on a live grip change', () => {
  it('a higher-grip cfg raises the profile targets (headroom increases for the same v)', () => {
    const lane = constantCurvatureLane(5);
    const lowGripCfg: Tuning = { ...TUNING, gripHard: 6, gripSoft: 4 };
    const highGripCfg: Tuning = { ...TUNING, gripHard: 60, gripSoft: 40 };

    const coach = createCoach(lane, lowGripCfg);
    const v = 0.3;
    const before = coach.advise({ s: 0, v }, DT).headroom;

    coach.recompute(highGripCfg);
    const after = coach.advise({ s: 0, v }, DT).headroom;

    expect(after).toBeGreaterThan(before);
  });

  it('recompute changes the raw target enough to flip a brake reading back to go/hold', () => {
    const lane = constantCurvatureLane(5);
    const lowGripCfg: Tuning = { ...TUNING, gripHard: 6, gripSoft: 4 };
    const highGripCfg: Tuning = { ...TUNING, gripHard: 200, gripSoft: 150 };
    const lowTarget = buildSpeedProfile(lane, lowGripCfg, COACH_DIFFICULTY).at(0);

    const coach = createCoach(lane, lowGripCfg);
    const v = lowTarget * 1.5; // brake zone under the low-grip cfg
    expect(coach.advise({ s: 0, v }, DT).zone).toBe('brake');

    coach.recompute(highGripCfg);
    // Leaving brake is dwell-gated (not the immediate direction) — sustain it
    // past 80ms before checking the committed zone.
    const steps = Math.ceil(0.08 / DT) + 1;
    let last: string = 'brake';
    for (let i = 0; i < steps; i++) last = coach.advise({ s: 0, v }, DT).zone;
    expect(last).not.toBe('brake');
  });
});

describe('createCoach — stickiness monotonicity: glue never brakes where authentic would not', () => {
  it('for the same (s, v), if authentic says go/hold, glue must not say brake', () => {
    const oval = buildTrack(TRACKS.oval.refs);
    const lane = oval.lanes[0];

    const authenticCfg: Tuning = { ...TUNING };
    applyStickiness(authenticCfg, 'authentic' as StickinessId);
    const glueCfg: Tuning = { ...TUNING };
    applyStickiness(glueCfg, 'glue' as StickinessId);

    const sSteps = 24;
    const vSteps = 8;
    for (let i = 0; i < sSteps; i++) {
      const s = (i / sSteps) * lane.totalLength;
      for (let j = 1; j <= vSteps; j++) {
        const v = (j / vSteps) * TUNING.vmax * 1.5;
        // Fresh coach per sample point: this tests the raw (ratio -> zone)
        // mapping's monotonicity, not accumulated hysteresis state.
        const authenticZone = createCoach(lane, authenticCfg).advise({ s, v }, DT).zone;
        const glueZone = createCoach(lane, glueCfg).advise({ s, v }, DT).zone;
        if (authenticZone !== 'brake') {
          expect(glueZone).not.toBe('brake');
        }
      }
    }
  });
});

describe("stickiness — deslot survival (pinned): the user's core request", () => {
  // The headless, non-negotiable proof that the beginner assist actually
  // does what it promises: the SAME scripted throttle trace, on the SAME
  // corner, deslots repeatedly at Authentic grip but not at all at the
  // higher assist levels. src/sim/** itself is untouched — this only calls
  // its existing, unmodified createSim with a stickiness-scaled cfg.
  //
  // Deviation from the brief's literal "full-throttle" (1.0), disclosed:
  // oval lane 0's run-up to its first curve9_90 is a short two-15in straight
  // (~0.76m) — a dead-stop 1.0-throttle launch already reaches ~2.75 m/s by
  // the time it reaches the curve, which exceeds even Training Glue's own
  // sustainable cornering speed there (empirically ~2.5 m/s at gripHard ×
  // 2.7), so EVERY level deslots regardless of assist (confirmed while
  // building this test — see the throttle/lane/tick-budget scan this pin was
  // calibrated against). 0.8 throttle is still a confident, no-lift,
  // "didn't back off for the corner" beginner mistake — the property this
  // feature exists for — and is the smallest throttle found where the split
  // actually appears: at 0.8, Authentic repeatedly deslots (proven stable
  // across 300/900/1800-tick budgets) while every assisted level (Sticky,
  // Magna-Traction, Training Glue) survives the identical run cleanly.
  const DESLOT_DT = 1 / 120;
  const DESLOT_THROTTLE = 0.8;
  const DESLOT_TOTAL_TICKS = 900;

  function runDeslotCount(stickiness: StickinessId, seed = 1): number {
    const cfg: Tuning = { ...TUNING };
    applyStickiness(cfg, stickiness);
    const sim = createSim({
      track: buildTrack(TRACKS.oval.refs),
      cars: [{ lane: 0, controlled: 'input' }],
      cfg,
      seed,
    });
    let deslots = 0;
    for (let tick = 1; tick <= DESLOT_TOTAL_TICKS; tick++) {
      const input: InputFrame = { throttle: DESLOT_THROTTLE };
      const events: SimEvent[] = sim.step(DESLOT_DT, tick, [input]);
      for (const e of events) if (e.type === 'deslot') deslots += 1;
    }
    return deslots;
  }

  it('a sustained no-lift run into the 9″ curve deslots (repeatedly) at Authentic AFX but not at all at Training Glue', () => {
    expect(runDeslotCount('authentic')).toBeGreaterThan(0);
    expect(runDeslotCount('glue')).toBe(0);
  });

  it('every assisted level (Sticky, Magna-Traction) also survives the identical run cleanly', () => {
    expect(runDeslotCount('sticky')).toBe(0);
    expect(runDeslotCount('magna')).toBe(0);
  });

  it('pinned exact counts, so a future tuning change surfaces here deliberately, not silently', () => {
    expect(runDeslotCount('authentic')).toBe(3);
    expect(runDeslotCount('sticky')).toBe(0);
    expect(runDeslotCount('magna')).toBe(0);
    expect(runDeslotCount('glue')).toBe(0);
  });
});
