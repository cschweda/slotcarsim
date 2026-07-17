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

// Full-throttle-into-the-corner trace, deliberately aggressive so it
// provably deslots (car 0, lane 0 — the tighter inner lane) within the tick
// budget. Single input-controlled car keeps the scenario focused; the world
// rng and its seed option are exercised directly via createSim's `seed`.
const DESLOT_TOTAL_TICKS = 900;

function runDeslotTrace(seed: number) {
  const sim = createSim({
    track: buildTrack(TRACKS.oval.refs),
    cars: [{ lane: 0, controlled: 'input' }],
    cfg: TUNING,
    seed,
  });

  const events: SimEvent[] = [];
  let lastTumble: ReturnType<typeof sim.carStates>[number]['tumble'] = null;
  for (let tick = 1; tick <= DESLOT_TOTAL_TICKS; tick++) {
    events.push(...sim.step(DT, tick, [{ throttle: 1 }]));
    const tumble = sim.carStates()[0]!.tumble;
    if (tumble) lastTumble = tumble;
  }

  return { finalStates: sim.carStates(), events, lastTumble };
}

describe('determinism — deslot/reslot', () => {
  it('sustained full throttle into the 9″ curve provably deslots (and reslots) at least once', () => {
    const { events } = runDeslotTrace(1);
    expect(events.some((e) => e.type === 'deslot')).toBe(true);
    expect(events.some((e) => e.type === 'reslot')).toBe(true);
  });

  it('same seed run twice yields identical final CarState (all fields) and identical full event lists', () => {
    const runA = runDeslotTrace(1);
    const runB = runDeslotTrace(1);

    expect(runA.finalStates.length).toBe(runB.finalStates.length);
    runA.finalStates.forEach((stateA, i) => {
      const stateB = runB.finalStates[i]!;
      expect(Object.is(stateA.s, stateB.s)).toBe(true);
      expect(Object.is(stateA.v, stateB.v)).toBe(true);
      expect(Object.is(stateA.lane, stateB.lane)).toBe(true);
      expect(Object.is(stateA.lapCount, stateB.lapCount)).toBe(true);
      expect(Object.is(stateA.slideYaw, stateB.slideYaw)).toBe(true);
      expect(Object.is(stateA.aLatFiltered, stateB.aLatFiltered)).toBe(true);
      expect(Object.is(stateA.hardTicks, stateB.hardTicks)).toBe(true);
      expect(stateA.phase).toBe(stateB.phase);
      expect(Object.is(stateA.phaseTicks, stateB.phaseTicks)).toBe(true);
      expect(Object.is(stateA.generation, stateB.generation)).toBe(true);
      expect(stateA.tumble).toEqual(stateB.tumble);
    });

    expect(runA.events).toEqual(runB.events);
    expect(runA.events.some((e) => e.type === 'deslot')).toBe(true);
  });

  it('different seeds: identical lap/deslot/reslot event list, but different tumble rest kinematics', () => {
    const runA = runDeslotTrace(1);
    const runB = runDeslotTrace(2);

    // The deslot TRIGGER (when/where) is pure physics — no rng involved — so
    // event contents (types, carIndex, atS, speed, lap numbers/times) are
    // seed-independent; only the tumble's post-trigger kick/spin (and so its
    // rest position) vary with the seed. Reslot always resets to a
    // seed-independent (v=0, s=exitS), so later ticks can't diverge either.
    expect(runA.events).toEqual(runB.events);

    expect(runA.lastTumble).not.toBeNull();
    expect(runB.lastTumble).not.toBeNull();
    expect(runA.lastTumble).not.toEqual(runB.lastTumble);
  });
});
