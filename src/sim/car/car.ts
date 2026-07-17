// Per-car step, extracted from world.ts (M3): composes the longitudinal
// motor/brake model with the lateral cornering/deslot models behind a single
// phase dispatch. 'slot' drives motor+cornering+integration as one car
// normally does; 'tumbling'/'waiting' hand off entirely to the deslot state
// machine and ignore throttle input until the car is back in the slot.
import type { Tuning } from '../../config/tuning';
import type { Rng } from '../rng';
import type { LanePath } from '../track/path';
import type { CarState, InputFrame, SimEvent } from '../types';
import { stepCornering } from './cornering';
import { beginTumble, stepDeslot } from './deslot';
import { carAccel } from './motor';

export interface StepCarResult {
  state: CarState;
  /** deslot/reslot events only — world.ts adds 'lap' events itself (it owns the lap timers). */
  events: SimEvent[];
}

export function stepCar(
  state: CarState,
  input: InputFrame,
  lane: LanePath,
  rng: Rng,
  dt: number,
  cfg: Tuning,
  carIndex: number,
): StepCarResult {
  if (state.phase !== 'slot') {
    return stepTumbling(state, lane, dt, cfg, carIndex);
  }
  return stepSlot(state, input, lane, rng, dt, cfg, carIndex);
}

function stepSlot(
  state: CarState,
  input: InputFrame,
  lane: LanePath,
  rng: Rng,
  dt: number,
  cfg: Tuning,
  carIndex: number,
): StepCarResult {
  const L = lane.totalLength;
  const sPrev = state.s;
  const { curvature } = lane.pointAt(sPrev);

  const a = carAccel(state.v, input.throttle, cfg);
  const vMotor = Math.max(0, state.v + a * dt);

  const corner = stepCornering(
    { aLatFiltered: state.aLatFiltered, slideYaw: state.slideYaw, hardTicks: state.hardTicks },
    vMotor,
    curvature,
    dt,
    cfg,
  );

  const v = Math.max(0, vMotor - corner.scrubDecel * dt);
  const sNew = (((sPrev + v * dt) % L) + L) % L;

  if (corner.deslotTriggered) {
    const exitPoint = lane.pointAt(sNew);
    const exitHeading = exitPoint.heading + corner.slideYaw;
    const tumble = beginTumble(exitPoint.pos, exitHeading, sNew, v, curvature, rng, cfg);

    const event: SimEvent = { type: 'deslot', carIndex, atS: sNew, speed: v };
    return {
      state: {
        ...state,
        s: sNew,
        v,
        aLatFiltered: corner.aLatFiltered,
        slideYaw: corner.slideYaw,
        hardTicks: corner.hardTicks,
        phase: 'tumbling',
        phaseTicks: 0,
        tumble,
      },
      events: [event],
    };
  }

  return {
    state: {
      ...state,
      s: sNew,
      v,
      aLatFiltered: corner.aLatFiltered,
      slideYaw: corner.slideYaw,
      hardTicks: corner.hardTicks,
    },
    events: [],
  };
}

function stepTumbling(
  state: CarState,
  _lane: LanePath,
  dt: number,
  cfg: Tuning,
  carIndex: number,
): StepCarResult {
  // Only reachable with phase 'tumbling' | 'waiting' (stepCar's guard above),
  // both of which always carry a tumble — narrow the type for stepDeslot.
  const phase = state.phase as 'tumbling' | 'waiting';
  const result = stepDeslot(state.tumble!, phase, state.phaseTicks, dt, cfg);

  if (result.reslotted) {
    const event: SimEvent = { type: 'reslot', carIndex };
    return {
      state: {
        ...state,
        s: result.tumble.exitS,
        v: 0,
        slideYaw: 0,
        aLatFiltered: 0,
        hardTicks: 0,
        phase: 'slot',
        phaseTicks: 0,
        generation: state.generation + 1,
        tumble: null,
      },
      events: [event],
    };
  }

  return {
    state: {
      ...state,
      phase: result.phase as 'tumbling' | 'waiting',
      phaseTicks: result.phaseTicks,
      tumble: result.tumble,
    },
    events: [],
  };
}
