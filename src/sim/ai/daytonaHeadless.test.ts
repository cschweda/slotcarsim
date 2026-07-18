// Pinned headless AI coverage for the M12 Daytona Sweep — the banked speedway
// with an elevated back stretch. The contract the brief calls sacred for the
// new track: a d=1.0 line genuinely handles the banked entries AND the downhill
// with ZERO deslots across seeds, a nervous d=0.35 line occasionally falls off
// (exact pinned count), and the banked-corner backward pass still converges
// fast. Mirrors sim/ai/headless.test.ts's oval suite and figure8Headless.ts.
import { describe, expect, it } from 'vitest';
import { TRACKS } from '../../config/tracks';
import { TUNING } from '../../config/tuning';
import { buildSpeedProfile } from './speedProfile';
import { buildTrack } from '../track/builder';
import type { SimEvent } from '../types';
import { createSim } from '../world';

const DT = 1 / 120;
const MAX_TICKS = 120 * 200; // ≥ 20 Daytona laps (~1.75 s settled) with headroom

function runAiLaps(difficulty: number, seed: number, laps: number, lane: 0 | 1 = 0) {
  const sim = createSim({
    track: buildTrack(TRACKS.daytonaSweep.refs),
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
  const settled = lapTimes.slice(2); // drop the two standing-start laps
  const lapSpread = settled.length > 0 ? Math.max(...settled) - Math.min(...settled) : 0;
  return { deslots, lapCount, lapSpread };
}

describe('headless AI — Daytona Sweep (banked + elevated)', () => {
  it('the banked-corner backward pass still converges fast (≤ 4 sweeps, both lanes, every difficulty)', () => {
    const track = buildTrack(TRACKS.daytonaSweep.refs);
    for (const d of [0.35, 0.65, 0.9, 1]) {
      for (const lane of [0, 1] as const) {
        const p = buildSpeedProfile(track.lanes[lane], TUNING, d);
        expect(p.sweeps).toBeLessThanOrEqual(4);
      }
    }
  });

  it('d=1.0 completes 20 laps with ZERO deslots across seeds and BOTH lanes (banked entries + the downhill, handled)', () => {
    for (const lane of [0, 1] as const) {
      for (let seed = 1; seed <= 5; seed++) {
        const r = runAiLaps(1.0, seed, 20, lane);
        expect(r.lapCount).toBe(20);
        expect(r.deslots).toBe(0);
      }
    }
  });

  it('a full-throttle survivor: a d=1.0 line carries the banked ends at a speed that would spit it off the flat oval', () => {
    // Concrete proof the bank does real work: the AI's inner-lane banked-corner
    // target here is ~1.87 m/s — comfortably ABOVE the flat 9" inner-lane deslot
    // speed of ~1.518 m/s — yet it never deslots (asserted above).
    const track = buildTrack(TRACKS.daytonaSweep.refs);
    const p = buildSpeedProfile(track.lanes[0], TUNING, 1.0);
    const minCap = Math.min(...p.v); // the banked-corner cap dominates the minimum
    expect(minCap).toBeGreaterThan(1.6); // above the flat oval's ~1.46 d=1 corner cap
    expect(minCap).toBeLessThan(1.962); // still safely under the banked deslot speed
  });

  it('d=0.35 (Easy), worldSeed 4 → an EXACT pinned deslot count > 0 over 20 laps', () => {
    const r = runAiLaps(0.35, 4, 20, 0);
    expect(r.lapCount).toBe(20);
    expect(r.deslots).toBe(1); // pinned: Easy misjudges a banked entry and falls off
  });

  it('"not a robot": d=0.35 worldSeed 4 shows a settled-lap spread ≥ 0.15 s (its tumble makes it visibly human)', () => {
    const r = runAiLaps(0.35, 4, 20, 0);
    expect(r.lapSpread).toBeGreaterThanOrEqual(0.15);
  });

  it('determinism is sacred: a fixed seed yields a bit-identical Daytona race run twice', () => {
    const run = (seed: number) => {
      const sim = createSim({
        track: buildTrack(TRACKS.daytonaSweep.refs),
        cars: [{ lane: 0, controlled: 'ai', difficulty: 0.65 }],
        cfg: TUNING,
        seed,
      });
      const events: SimEvent[] = [];
      for (let tick = 1; tick <= 2000; tick++) events.push(...sim.step(DT, tick, []));
      return { states: sim.carStates(), events };
    };
    const a = run(5);
    const b = run(5);
    expect(a.events).toEqual(b.events);
    expect(Object.is(a.states[0]!.s, b.states[0]!.s)).toBe(true);
    expect(Object.is(a.states[0]!.v, b.states[0]!.v)).toBe(true);
    expect(a.events.some((e) => e.type === 'lap')).toBe(true);
  });
});
