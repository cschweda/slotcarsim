import { describe, expect, it } from 'vitest';
import { TRACKS } from '../config/tracks';
import { TUNING } from '../config/tuning';
import { carAccel } from './car/motor';
import { buildTrack } from './track/builder';
import type { InputFrame } from './types';
import { createSim } from './world';

const DT = 1 / 120;

function track() {
  return buildTrack(TRACKS.oval.refs);
}

describe('createSim — constant-controlled car', () => {
  it('holds v exactly at constantV every tick, ignoring inputs entirely', () => {
    const sim = createSim({
      track: track(),
      cars: [{ lane: 1, controlled: 'constant', constantV: 1.5 }],
      cfg: TUNING,
    });

    for (let tick = 1; tick <= 50; tick++) {
      sim.step(DT, tick, []); // empty inputs: must not be read at all
      expect(sim.carStates()[0]!.v).toBe(1.5);
    }
  });
});

describe('createSim — semi-implicit Euler wiring', () => {
  it('matches a manual carAccel + semi-implicit Euler computation for one step', () => {
    const t = track();
    const sim = createSim({
      track: t,
      cars: [{ lane: 0, controlled: 'input' }],
      cfg: TUNING,
    });

    const input: InputFrame = { throttle: 1 };
    sim.step(DT, 1, [input]);

    const L = t.lanes[0].totalLength;
    const expectedA = carAccel(0, 1, TUNING);
    const expectedV = Math.max(0, 0 + expectedA * DT);
    const expectedS = ((0 + expectedV * DT) % L + L) % L;

    const state = sim.carStates()[0]!;
    expect(state.v).toBeCloseTo(expectedV, 12);
    expect(state.s).toBeCloseTo(expectedS, 12);
    expect(state.lane).toBe(0);
    expect(state.lapCount).toBe(0);
  });

  it('velocity is clamped at 0, never negative, under full brake from rest', () => {
    const sim = createSim({
      track: track(),
      cars: [{ lane: 0, controlled: 'input' }],
      cfg: TUNING,
    });
    for (let tick = 1; tick <= 30; tick++) {
      sim.step(DT, tick, [{ throttle: 0 }]);
      expect(sim.carStates()[0]!.v).toBeGreaterThanOrEqual(0);
    }
    expect(sim.carStates()[0]!.v).toBe(0);
  });
});

describe('createSim — prev/curr snapshotting for render interpolation', () => {
  it('prevCarStates() is one step behind carStates()', () => {
    const sim = createSim({
      track: track(),
      cars: [{ lane: 0, controlled: 'input' }],
      cfg: TUNING,
    });

    const initial = { ...sim.carStates()[0]! };
    expect(sim.prevCarStates()[0]).toEqual(initial);

    sim.step(DT, 1, [{ throttle: 1 }]);
    const afterStep1 = { ...sim.carStates()[0]! };
    expect(sim.prevCarStates()[0]).toEqual(initial); // still pre-step-1

    sim.step(DT, 2, [{ throttle: 1 }]);
    expect(sim.prevCarStates()[0]).toEqual(afterStep1); // now what curr was after step 1
    expect(sim.carStates()[0]).not.toEqual(afterStep1); // curr has moved on
  });
});

describe('createSim — laneFor', () => {
  it("returns each car's configured lane LanePath", () => {
    const t = track();
    const sim = createSim({
      track: t,
      cars: [
        { lane: 0, controlled: 'input' },
        { lane: 1, controlled: 'constant', constantV: 1.5 },
      ],
      cfg: TUNING,
    });

    expect(sim.laneFor(0)).toBe(t.lanes[0]);
    expect(sim.laneFor(1)).toBe(t.lanes[1]);
  });
});

describe('createSim — lap events', () => {
  it('emits lap events with plausible lap times (~L/v̄) as a constant-v car circulates', () => {
    const t = track();
    const L = t.lanes[1].totalLength;
    const v = 1.5;
    const sim = createSim({
      track: t,
      cars: [{ lane: 1, controlled: 'constant', constantV: v }],
      cfg: TUNING,
    });

    const laps: number[] = [];
    const maxTicks = Math.ceil((L / v) * 3 * 120);
    for (let tick = 1; tick <= maxTicks && laps.length < 2; tick++) {
      const events = sim.step(DT, tick, []);
      for (const e of events) {
        if (e.type === 'lap') laps.push(e.lapTimeSec);
      }
    }

    expect(laps.length).toBeGreaterThanOrEqual(2);
    const expectedLapTime = L / v;
    for (const lapTime of laps) {
      expect(lapTime).toBeGreaterThan(expectedLapTime * 0.9);
      expect(lapTime).toBeLessThan(expectedLapTime * 1.1);
    }
  });

  it('bumps CarState.lapCount when a lap event fires', () => {
    const t = track();
    const L = t.lanes[1].totalLength;
    const v = 1.5;
    const sim = createSim({
      track: t,
      cars: [{ lane: 1, controlled: 'constant', constantV: v }],
      cfg: TUNING,
    });

    let sawLap = false;
    const maxTicks = Math.ceil((L / v) * 1.5 * 120);
    for (let tick = 1; tick <= maxTicks; tick++) {
      const events = sim.step(DT, tick, []);
      if (events.length > 0) {
        sawLap = true;
        expect(sim.carStates()[0]!.lapCount).toBe(1);
        break;
      }
    }
    expect(sawLap).toBe(true);
  });
});
