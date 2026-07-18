// Pinned headless AI coverage for the figure-8 (M7-review ledger item: the
// figure-8 AI behavior was previously only verified via a controller's
// transient browser probe — this commits that probe as a permanent test,
// mirroring src/sim/ai/headless.test.ts's oval suite). Confirms the AI drives
// the criss-cross layout (shared crossing square, self-intersecting lanes)
// without regressions: a full race completes, lap timing stays in a sane
// band, and the deslot count for a fixed seed is pinned exactly.
import { describe, expect, it } from 'vitest';
import { TRACKS } from '../../config/tracks';
import { TUNING } from '../../config/tuning';
import { buildTrack } from '../track/builder';
import type { InputFrame, SimEvent } from '../types';
import { createSim } from '../world';

const DT = 1 / 120;
const MAX_TICKS = 120 * 90; // 90 s — plenty for 5 figure-8 laps (~2.0s each once settled)

describe('headless AI — figure-8', () => {
  it('AI (d=0.65, lane 1) completes exactly 5 laps against an idle player, in a sane sim-time band, with a pinned deslot count and finite state throughout', () => {
    const sim = createSim({
      track: buildTrack(TRACKS.figure8.refs),
      cars: [
        { lane: 0, controlled: 'input' }, // player: idle (never touches the trigger)
        { lane: 1, controlled: 'ai', difficulty: 0.65 }, // Medium, per menus.ts's difficulty table
      ],
      cfg: TUNING,
      seed: 1,
    });

    const idleInput: InputFrame = { throttle: 0 };
    let deslots = 0;
    let aiLaps = 0;
    let finishTick = 0;
    const lapTimes: number[] = [];

    for (let tick = 1; tick <= MAX_TICKS && aiLaps < 5; tick++) {
      const events: SimEvent[] = sim.step(DT, tick, [idleInput]);
      for (const e of events) {
        if (e.type === 'deslot' && e.carIndex === 1) deslots += 1;
        if (e.type === 'lap' && e.carIndex === 1) {
          aiLaps += 1;
          lapTimes.push(e.lapTimeSec);
          if (aiLaps === 5) finishTick = tick;
        }
      }
    }

    expect(aiLaps).toBe(5);
    expect(lapTimes).toHaveLength(5);

    // Sim-time band for 5 laps (standing-start first lap ~2.07s, settled laps
    // ~2.01-2.02s each — pinned seed=1 finishes at tick 1217 / 10.1417s).
    const elapsedSec = finishTick * DT;
    expect(elapsedSec).toBeGreaterThan(9.5);
    expect(elapsedSec).toBeLessThan(10.8);

    // Medium (d=0.65) drives the crossing cleanly for this seed — pinned exact,
    // like the oval suite's d=1.0/d=0.9 zero-deslot cases.
    expect(deslots).toBe(0);

    // No NaN propagation through the crossing/lobe geometry for either car.
    for (const state of sim.carStates()) {
      expect(Number.isFinite(state.s)).toBe(true);
      expect(Number.isFinite(state.v)).toBe(true);
      expect(Number.isFinite(state.slideYaw)).toBe(true);
      expect(Number.isFinite(state.aLatFiltered)).toBe(true);
    }
  });
});
