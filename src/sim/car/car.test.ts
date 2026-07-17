import { describe, expect, it } from 'vitest';
import type { Tuning } from '../../config/tuning';
import { TUNING } from '../../config/tuning';
import { createRng } from '../rng';
import { createLanePath } from '../track/path';
import type { CarState, InputFrame } from '../types';
import { carAccel } from './motor';
import { stepCar } from './car';

const DT = 1 / 120;
const IN = 0.0254;

function freshCarState(overrides: Partial<CarState> = {}): CarState {
  return {
    s: 0,
    v: 0,
    lane: 0,
    lapCount: 0,
    slideYaw: 0,
    aLatFiltered: 0,
    hardTicks: 0,
    phase: 'slot',
    phaseTicks: 0,
    generation: 0,
    tumble: null,
    ...overrides,
  };
}

function straightLane() {
  // A single 10m line, wrapped — kappa=0 everywhere.
  return createLanePath([{ type: 'line', p0: { x: 0, y: 0 }, p1: { x: 10, y: 0 }, length: 10 }]);
}

function fullCircleLane9in() {
  // A full-circle "lane" of constant curvature (9" radius, left turn) — lets
  // tests drive sustained hard cornering without needing a whole closed oval.
  const r = 9 * IN;
  return createLanePath([
    { type: 'arc', center: { x: 0, y: 0 }, radius: r, a0: 0, sweep: 2 * Math.PI, length: r * 2 * Math.PI },
  ]);
}

describe('stepCar — slot phase on a straight (kappa=0): equivalent to motor-only physics', () => {
  it('matches carAccel + semi-implicit Euler exactly (cornering is fully inert at κ=0)', () => {
    const cfg: Tuning = { ...TUNING };
    const lane = straightLane();
    const state = freshCarState();
    const input: InputFrame = { throttle: 1 };

    const { state: next, events } = stepCar(state, input, lane, createRng(1), DT, cfg, 0);

    const expectedA = carAccel(0, 1, cfg);
    const expectedV = Math.max(0, 0 + expectedA * DT);
    const expectedS = ((0 + expectedV * DT) % 10 + 10) % 10;

    expect(next.v).toBeCloseTo(expectedV, 12);
    expect(next.s).toBeCloseTo(expectedS, 12);
    expect(next.phase).toBe('slot');
    expect(next.slideYaw).toBe(0);
    expect(next.aLatFiltered).toBe(0);
    expect(events).toEqual([]);
  });
});

describe('stepCar — sustained hard cornering triggers deslot', () => {
  it('transitions to tumbling, populates tumble, and emits a deslot event tagged with carIndex', () => {
    const cfg: Tuning = { ...TUNING };
    const lane = fullCircleLane9in();
    // v=3 on a 9in-radius curve is far above sqrt(gripHard·r) ≈ 1.5 m/s.
    let state = freshCarState({ v: 3 });
    const input: InputFrame = { throttle: 0 };
    const rng = createRng(1);

    let deslotEvent: { type: 'deslot'; carIndex: number; atS: number; speed: number } | undefined;
    let ticks = 0;
    const maxTicks = 60;
    for (; ticks < maxTicks; ticks++) {
      const result = stepCar(state, input, lane, rng, DT, cfg, 5);
      state = result.state;
      const found = result.events.find((e) => e.type === 'deslot');
      if (found) {
        deslotEvent = found as typeof deslotEvent;
        break;
      }
    }

    expect(deslotEvent).toBeDefined();
    expect(deslotEvent!.carIndex).toBe(5);
    expect(deslotEvent!.speed).toBeGreaterThan(0);
    expect(state.phase).toBe('tumbling');
    expect(state.phaseTicks).toBe(0);
    expect(state.tumble).not.toBeNull();
    expect(state.tumble!.exitS).toBeCloseTo(deslotEvent!.atS, 12);
    expect(state.generation).toBe(0); // generation bumps only on RESLOT, not on deslot
  });
});

describe('stepCar — tumbling/waiting phases', () => {
  function deslottedState(): CarState {
    return freshCarState({
      phase: 'tumbling',
      phaseTicks: 0,
      v: 2,
      tumble: { x: 1, y: 2, vx: 2, vy: 0, yaw: 0, yawRate: 10, exitS: 4.5 },
    });
  }

  it('ignores throttle input entirely while tumbling — s stays frozen', () => {
    const cfg: Tuning = { ...TUNING };
    const lane = straightLane();
    const state = deslottedState();

    const { state: next, events } = stepCar(state, { throttle: 1 }, lane, createRng(1), DT, cfg, 0);

    expect(next.s).toBe(state.s); // s untouched — frozen at exit position
    expect(next.phase).toBe('tumbling');
    expect(next.phaseTicks).toBe(1);
    expect(events).toEqual([]);
  });

  it('advances tumble kinematics identically to stepDeslot', () => {
    const cfg: Tuning = { ...TUNING };
    const lane = straightLane();
    const state = deslottedState();

    const { state: next } = stepCar(state, { throttle: 0 }, lane, createRng(1), DT, cfg, 0);

    const expectedSpeed = 2 - cfg.tumbleFriction * DT;
    expect(next.tumble!.vx).toBeCloseTo(expectedSpeed, 9);
    expect(next.tumble!.x).toBeCloseTo(expectedSpeed * DT + 1, 9);
  });

  it('completes tumbling → waiting → reslot, resetting fields and bumping generation', () => {
    const cfg: Tuning = { ...TUNING };
    const lane = straightLane();
    let state = deslottedState();
    const input: InputFrame = { throttle: 1 }; // must stay ignored right up to reslot

    let reslotEvent: { type: 'reslot'; carIndex: number } | undefined;
    const guard = 1000;
    let i = 0;
    for (; i < guard; i++) {
      const result = stepCar(state, input, lane, createRng(1), DT, cfg, 2);
      state = result.state;
      const found = result.events.find((e) => e.type === 'reslot');
      if (found) {
        reslotEvent = found as typeof reslotEvent;
        break;
      }
    }

    expect(reslotEvent).toBeDefined();
    expect(reslotEvent!.carIndex).toBe(2);
    expect(i + 1).toBe(132 + 108); // tumbleDuration + marshalDuration in ticks at dt=1/120

    expect(state.phase).toBe('slot');
    expect(state.phaseTicks).toBe(0);
    expect(state.v).toBe(0);
    expect(state.slideYaw).toBe(0);
    expect(state.aLatFiltered).toBe(0);
    expect(state.hardTicks).toBe(0);
    expect(state.s).toBe(4.5); // exitS
    expect(state.generation).toBe(1);
    expect(state.tumble).toBeNull();
  });
});
