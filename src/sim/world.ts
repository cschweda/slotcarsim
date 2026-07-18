// Deterministic car-physics world: advances every car one fixed tick,
// snapshotting prev/curr state for render interpolation, and feeding each
// car's lap timer. Orchestration only — per-car motor/cornering/deslot
// physics lives in car/car.ts's stepCar. The world owns exactly one seeded
// rng, threaded into every 'input'-controlled car's step in car order each
// tick, so a fixed seed (default 1) makes tumble kinematics fully
// reproducible: state is fully determined by (track, cfg, seed, input
// trace), the property that makes ghost replay/netcode possible later
// without retrofitting (see the design doc).
import type { Tuning } from '../config/tuning';
import type { AiDriver } from './ai/driver';
import { createAiDriver } from './ai/driver';
import { stepCar } from './car/car';
import { createRng } from './rng';
import type { LapTimer } from './timing';
import { createLapTimer } from './timing';
import type { Track } from './track/builder';
import type { LanePath } from './track/path';
import type { CarState, InputFrame, SimEvent } from './types';

const DEFAULT_SEED = 1;

function initialCarState(lane: 0 | 1): CarState {
  return {
    s: 0,
    v: 0,
    lane,
    lapCount: 0,
    slideYaw: 0,
    aLatFiltered: 0,
    hardTicks: 0,
    phase: 'slot',
    phaseTicks: 0,
    generation: 0,
    tumble: null,
  };
}

export interface CarConfig {
  /** Which of the track's two lanes this car runs on. */
  lane: 0 | 1;
  /**
   * 'input': driven by an InputFrame each step. 'constant': ignores input
   * (the M2/attract pace-car placeholder). 'ai': driven by an AiDriver the
   * world constructs and owns; consumes no InputFrame.
   */
  controlled: 'input' | 'constant' | 'ai';
  /** Required when controlled === 'constant' (the pace-car placeholder). */
  constantV?: number;
  /** Difficulty ∈ [0,1] for controlled === 'ai' (defaults to 0.5 if omitted). */
  difficulty?: number;
}

export interface CreateSimOptions {
  track: Track;
  cars: CarConfig[];
  cfg: Tuning;
  /** Seeds the world's single shared rng (deslot tumble kinematics). Defaults to 1. */
  seed?: number;
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
  const worldSeed = opts.seed ?? DEFAULT_SEED;
  const rng = createRng(worldSeed);

  const lanes: LanePath[] = cars.map((car) => track.lanes[car.lane]);
  const timers: LapTimer[] = cars.map((_car, i) => createLapTimer(lanes[i]!.totalLength, i));

  // Each 'ai' car gets its OWN rng, seeded worldSeed*31 + carIndex — SEPARATE
  // from the shared world rng above. So AI throttle decisions never interleave
  // draws into the world rng that drives tumble kinematics (M3 draw order =
  // car order, on deslots only, stays byte-identical), while a fixed worldSeed
  // still makes the whole race — AI included — bit-for-bit reproducible.
  const drivers: (AiDriver | null)[] = cars.map((car, i) =>
    car.controlled === 'ai'
      ? createAiDriver(lanes[i]!, cfg, car.difficulty ?? 0.5, createRng(worldSeed * 31 + i))
      : null,
  );

  // Each 'input'-controlled car claims the next InputFrame slot in car
  // order, independent of overall car index — 'constant' and 'ai' cars never
  // consume a slot, so they can't shift a later player's index.
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

  let curr: CarState[] = cars.map((car) => initialCarState(car.lane));
  let prev: CarState[] = curr.map((state) => ({ ...state }));

  function step(dt: number, tickIndex: number, inputs: InputFrame[]): SimEvent[] {
    prev = curr.map((state) => ({ ...state }));

    const events: SimEvent[] = [];

    // stepCar may draw from the single shared rng on a deslot; Array.map
    // invokes its callback in ascending index order, so draw order is
    // exactly car order, deterministically — no explicit loop needed.
    curr = curr.map((state, i) => {
      const car = cars[i]!;
      const lane = lanes[i]!;
      const sPrev = state.s;

      let newState: CarState;

      if (car.controlled === 'constant') {
        // Pace-car placeholder: holds constantV exactly and bypasses
        // motor/cornering/deslot entirely, so grip limits never apply to it
        // (at 1.5 m/s it would slide but not deslot on lane 1 if they did).
        const v = car.constantV ?? 0;
        const sNew = (((sPrev + v * dt) % lane.totalLength) + lane.totalLength) % lane.totalLength;
        newState = { ...state, s: sNew, v };
      } else {
        // 'input' reads its InputFrame slot; 'ai' asks its own driver for a
        // throttle (drawing only from that car's private rng). Both then run
        // the identical stepCar physics, which may draw the WORLD rng on a
        // deslot — so world-rng draw order stays exactly car order.
        const input: InputFrame =
          car.controlled === 'ai'
            ? { throttle: drivers[i]!.throttleFor(state, dt) }
            : (inputs[inputSlotForCar[i]!] ?? { throttle: 0 });
        const result = stepCar(state, input, lane, rng, dt, cfg, i);
        events.push(...result.events);
        newState = result.state;
      }

      const lapEvent = timers[i]!.onStep(tickIndex, dt, sPrev, newState.s);
      let lapCount = newState.lapCount;
      if (lapEvent) {
        events.push(lapEvent);
        lapCount += 1;
      }

      return { ...newState, lapCount };
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
