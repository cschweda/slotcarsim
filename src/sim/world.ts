// Deterministic car-physics world: advances every car one fixed tick,
// snapshotting prev/curr state for render interpolation, and feeding each
// car's lap timer. No rng, no wall-clock reads — state is fully determined
// by (track, cfg, input trace), the property that makes ghost replay/netcode
// possible later without retrofitting (see the design doc).
import type { Tuning } from '../config/tuning';
import { carAccel } from './car/motor';
import type { LapTimer } from './timing';
import { createLapTimer } from './timing';
import type { Track } from './track/builder';
import type { LanePath } from './track/path';
import type { CarState, InputFrame, SimEvent } from './types';

export interface CarConfig {
  /** Which of the track's two lanes this car runs on. */
  lane: 0 | 1;
  /** 'input': driven by an InputFrame each step. 'constant': ignores input. */
  controlled: 'input' | 'constant';
  /** Required when controlled === 'constant' (the M2 pace-car placeholder). */
  constantV?: number;
}

export interface CreateSimOptions {
  track: Track;
  cars: CarConfig[];
  cfg: Tuning;
}

export interface Sim {
  step(dt: number, tickIndex: number, inputs: InputFrame[]): SimEvent[];
  /** Current per-car state, in `cars` order. */
  carStates(): readonly CarState[];
  /** Per-car state as of one step ago — for render interpolation via wrapLerp. */
  prevCarStates(): readonly CarState[];
  laneFor(i: number): LanePath;
}

export function createSim(opts: CreateSimOptions): Sim {
  const { track, cars, cfg } = opts;

  const lanes: LanePath[] = cars.map((car) => track.lanes[car.lane]);
  const timers: LapTimer[] = cars.map((_car, i) => createLapTimer(lanes[i]!.totalLength, i));

  // Each 'input'-controlled car claims the next InputFrame slot in car
  // order, independent of overall car index — a 'constant' pace car never
  // consumes a slot, so it can't shift a later player's index.
  const inputSlotForCar: number[] = [];
  let nextSlot = 0;
  for (const car of cars) {
    if (car.controlled === 'input') {
      inputSlotForCar.push(nextSlot);
      nextSlot += 1;
    } else {
      inputSlotForCar.push(-1);
    }
  }

  let curr: CarState[] = cars.map((car) => ({ s: 0, v: 0, lane: car.lane, lapCount: 0 }));
  let prev: CarState[] = curr.map((state) => ({ ...state }));

  function step(dt: number, tickIndex: number, inputs: InputFrame[]): SimEvent[] {
    prev = curr.map((state) => ({ ...state }));

    const events: SimEvent[] = [];

    curr = curr.map((state, i) => {
      const car = cars[i]!;
      const L = lanes[i]!.totalLength;
      const sPrev = state.s;

      let v: number;
      if (car.controlled === 'constant') {
        v = car.constantV ?? 0;
      } else {
        const slot = inputSlotForCar[i]!;
        const throttle = inputs[slot]?.throttle ?? 0;
        const a = carAccel(state.v, throttle, cfg);
        v = Math.max(0, state.v + a * dt);
      }

      const sNew = (((sPrev + v * dt) % L) + L) % L;

      const event = timers[i]!.onStep(tickIndex, dt, sPrev, sNew);
      let lapCount = state.lapCount;
      if (event) {
        events.push(event);
        lapCount += 1;
      }

      return { s: sNew, v, lane: car.lane, lapCount };
    });

    return events;
  }

  function carStates(): readonly CarState[] {
    return curr;
  }

  function prevCarStates(): readonly CarState[] {
    return prev;
  }

  function laneFor(i: number): LanePath {
    return lanes[i]!;
  }

  return { step, carStates, prevCarStates, laneFor };
}
