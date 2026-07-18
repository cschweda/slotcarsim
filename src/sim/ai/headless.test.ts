// Pinned headless AI behavior + determinism. These are the contract the brief
// calls sacred: a fixed worldSeed makes an AI race bit-for-bit reproducible,
// and difficulty gates deslots (a perfect d=1 line never falls off; a nervous
// d=0.35 one occasionally does). If a tuning change moves these numbers,
// that's a deliberate behavior change and the pin must move with it.
import { describe, expect, it } from 'vitest';
import { TRACKS } from '../../config/tracks';
import { TUNING } from '../../config/tuning';
import { buildTrack } from '../track/builder';
import type { CarState, InputFrame, SimEvent } from '../types';
import { createSim } from '../world';

const DT = 1 / 120;
const MAX_TICKS = 120 * 120; // 120 s — plenty for 20 laps

/** Run a single AI car until it completes `laps`, tallying deslots. */
function runAiLaps(difficulty: number, seed: number, laps: number, lane: 0 | 1 = 0) {
  const sim = createSim({
    track: buildTrack(TRACKS.oval.refs),
    cars: [{ lane, controlled: 'ai', difficulty }],
    cfg: TUNING,
    seed,
  });
  let deslots = 0;
  let lapCount = 0;
  const lapTimes: number[] = [];
  for (let tick = 1; tick <= MAX_TICKS && lapCount < laps; tick++) {
    for (const e of sim.step(DT, tick, [])) {
      if (e.type === 'deslot') deslots += 1;
      if (e.type === 'lap') {
        lapCount += 1;
        lapTimes.push(e.lapTimeSec);
      }
    }
  }
  // Mean of the settled laps (skip the standing-start first two).
  const settled = lapTimes.slice(2);
  const meanLap = settled.reduce((a, b) => a + b, 0) / settled.length;
  return { deslots, lapCount, meanLap };
}

describe('headless AI — difficulty gates deslots', () => {
  it('d=1.0 completes 20 laps with ZERO deslots (across many worldSeeds)', () => {
    for (let seed = 1; seed <= 10; seed++) {
      const r = runAiLaps(1.0, seed, 20);
      expect(r.lapCount).toBe(20);
      expect(r.deslots).toBe(0);
    }
  });

  it('d=0.9 (Hard) also completes 20 laps cleanly (zero deslots)', () => {
    for (let seed = 1; seed <= 6; seed++) {
      expect(runAiLaps(0.9, seed, 20).deslots).toBe(0);
    }
  });

  it('d=0.35 (Easy), worldSeed 3 → an EXACT pinned deslot count > 0 over 20 laps', () => {
    const r = runAiLaps(0.35, 3, 20);
    expect(r.lapCount).toBe(20);
    expect(r.deslots).toBe(2); // pinned: Easy misjudges brake points and falls off
  });

  it('difficulty orders clean lap times: Hard laps faster than Easy', () => {
    // Seed 1 is clean at both difficulties on lane 0 (Easy still corners slower).
    const easy = runAiLaps(0.35, 13, 12); // seed 13 is a clean Easy run
    const hard = runAiLaps(1.0, 13, 12);
    expect(hard.meanLap).toBeLessThan(easy.meanLap);
  });
});

// A scripted player throttle trace, reused across identical race runs.
const TRACE: { untilTick: number; throttle: number }[] = [
  { untilTick: 90, throttle: 1 },
  { untilTick: 160, throttle: 0 },
  { untilTick: 900, throttle: 0.7 },
  { untilTick: 100000, throttle: 1 },
];
function throttleAt(tick: number): number {
  for (const seg of TRACE) if (tick <= seg.untilTick) return seg.throttle;
  return 1;
}

function runRace(seed: number) {
  const sim = createSim({
    track: buildTrack(TRACKS.oval.refs),
    cars: [
      { lane: 0, controlled: 'input' }, // scripted player
      { lane: 1, controlled: 'ai', difficulty: 0.35 }, // AI (Easy → will deslot, exercises the world rng too)
    ],
    cfg: TUNING,
    seed,
  });
  const events: SimEvent[] = [];
  for (let tick = 1; tick <= 2400; tick++) {
    const input: InputFrame = { throttle: throttleAt(tick) };
    events.push(...sim.step(DT, tick, [input]));
  }
  return { finalStates: sim.carStates(), events };
}

function statesEqual(a: readonly CarState[], b: readonly CarState[]): void {
  expect(a.length).toBe(b.length);
  a.forEach((sa, i) => {
    const sb = b[i]!;
    expect(Object.is(sa.s, sb.s)).toBe(true);
    expect(Object.is(sa.v, sb.v)).toBe(true);
    expect(Object.is(sa.lapCount, sb.lapCount)).toBe(true);
    expect(Object.is(sa.slideYaw, sb.slideYaw)).toBe(true);
    expect(sa.phase).toBe(sb.phase);
    expect(Object.is(sa.generation, sb.generation)).toBe(true);
    expect(sa.tumble).toEqual(sb.tumble);
  });
}

describe('headless AI — determinism is sacred', () => {
  it('a fixed seed + scripted player trace yields a bit-identical race (state + events) run twice', () => {
    const a = runRace(7);
    const b = runRace(7);
    statesEqual(a.finalStates, b.finalStates);
    expect(a.events).toEqual(b.events);
    // Sanity: the race actually did interesting things (laps happened).
    expect(a.events.some((e) => e.type === 'lap')).toBe(true);
  });

  it('a different seed changes the AI race (its private rng really is seeded per worldSeed)', () => {
    const a = runRace(7);
    const b = runRace(8);
    // The AI's throttle stream differs, so the two races are not identical.
    expect(a.events).not.toEqual(b.events);
  });
});
