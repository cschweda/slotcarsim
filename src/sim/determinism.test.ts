import { describe, expect, it } from 'vitest';
import { TRACKS } from '../config/tracks';
import { TUNING } from '../config/tuning';
import { buildTrack } from './track/builder';
import type { InputFrame, SimEvent } from './types';
import { createSim } from './world';

const DT = 1 / 120;
const TOTAL_TICKS = 700;

// Scripted throttle trace covering the interesting branches: ramp up, full
// brake, partial throttle, a below-deadband dip (brake branch again), then
// back to full — run twice through fresh createSim instances.
const TRACE: { untilTick: number; throttle: number }[] = [
  { untilTick: 60, throttle: 1 },
  { untilTick: 120, throttle: 0 },
  { untilTick: 300, throttle: 0.6 },
  { untilTick: 400, throttle: 0.01 },
  { untilTick: TOTAL_TICKS, throttle: 1 },
];

function throttleAtTick(tick: number): number {
  for (const seg of TRACE) {
    if (tick <= seg.untilTick) return seg.throttle;
  }
  return TRACE[TRACE.length - 1]!.throttle;
}

function runTrace() {
  const sim = createSim({
    track: buildTrack(TRACKS.oval.refs),
    cars: [
      { lane: 0, controlled: 'input' },
      { lane: 1, controlled: 'constant', constantV: 1.5 },
    ],
    cfg: TUNING,
  });

  const events: SimEvent[] = [];
  for (let tick = 1; tick <= TOTAL_TICKS; tick++) {
    const input: InputFrame = { throttle: throttleAtTick(tick) };
    events.push(...sim.step(DT, tick, [input]));
  }

  return { finalStates: sim.carStates(), events };
}

describe('determinism', () => {
  it('the same scripted throttle trace run twice yields bit-identical final CarState (Object.is per field)', () => {
    const runA = runTrace();
    const runB = runTrace();

    expect(runA.finalStates.length).toBe(runB.finalStates.length);
    runA.finalStates.forEach((stateA, i) => {
      const stateB = runB.finalStates[i]!;
      expect(Object.is(stateA.s, stateB.s)).toBe(true);
      expect(Object.is(stateA.v, stateB.v)).toBe(true);
      expect(Object.is(stateA.lane, stateB.lane)).toBe(true);
      expect(Object.is(stateA.lapCount, stateB.lapCount)).toBe(true);
    });
  });

  it('the same scripted throttle trace run twice yields identical event lists', () => {
    const runA = runTrace();
    const runB = runTrace();

    expect(runA.events).toEqual(runB.events);
    expect(runA.events.length).toBeGreaterThan(0); // sanity: trace actually produced laps
  });
});
