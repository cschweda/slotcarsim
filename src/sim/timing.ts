// Sub-tick lap timing: a lap "crossing" almost never lands exactly on a tick
// boundary, so timing off the raw tick count alone would jitter by up to one
// full dt (~8ms at 120Hz — ~0.3% of a ~2.5s lap). Instead, within the single
// step that wraps past s=0, linearly interpolate the fractional tick at which
// the crossing actually happened (exact for constant-v motion within a step,
// and a good approximation otherwise since steps are tiny relative to a lap).
import type { SimEvent } from './types';

export interface LapTimer {
  /**
   * Feed one sim step's before/after arc-length position. Returns a 'lap'
   * SimEvent iff this step's forward motion wrapped past s=0, else null.
   */
  onStep(tickIndex: number, dt: number, sPrev: number, sNew: number): SimEvent | null;
}

/**
 * One timer per car, keyed to that car's lane length. carIndex tags emitted
 * SimEvents (defaults to 0 for a single-car/standalone use) — world.ts passes
 * each car's own index when it creates one timer per car.
 */
export function createLapTimer(laneLength: number, carIndex = 0): LapTimer {
  let prevCrossTime = 0; // race start, per the brief
  let lapNumber = 0;

  function onStep(tickIndex: number, dt: number, sPrev: number, sNew: number): SimEvent | null {
    const forwardDistance = (((sNew - sPrev) % laneLength) + laneLength) % laneLength;
    if (forwardDistance === 0) {
      return null; // stationary (on the line or anywhere else) — no crossing
    }

    const crossed = sNew < sPrev;
    if (!crossed) {
      return null;
    }

    // Fraction of this step's distance that was still "before" the line.
    const fraction = (laneLength - sPrev) / forwardDistance;
    // tickIndex follows loop.ts's convention (confirmed by loop.test.ts):
    // it is POST-increment, so step(dt, tickIndex=N) covers the simulated
    // interval [(N-1)·dt, N·dt], not [N·dt, (N+1)·dt]. "tickIndex − 1" is
    // therefore the count of whole steps already completed BEFORE this one
    // — the time at the start of the interval this step covers — which
    // `fraction` then advances into. Off by exactly one dt without the −1.
    const crossTime = (tickIndex - 1 + fraction) * dt;

    const lapTimeSec = crossTime - prevCrossTime;
    prevCrossTime = crossTime;
    lapNumber += 1;

    return { type: 'lap', carIndex, lapNumber, lapTimeSec };
  }

  return { onStep };
}
