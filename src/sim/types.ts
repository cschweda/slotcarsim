// Minimal skeletal types for later sim milestones. Intentionally sparse
// (YAGNI) — extended as motor/cornering/track/ai land in M1+.

/** Per-tick input for one player/car, decoupled from any input source. */
export interface InputFrame {
  throttle: number;
}

/**
 * A car's tumble kinematics while off the track (phase 'tumbling'|'waiting').
 * Plan-view position/velocity plus yaw/yawRate for the spin, and the lane
 * arc-length `exitS` it re-slots at. Drawn from the world rng exactly once,
 * at the moment of deslot (see sim/car/deslot.ts) — nothing after that is
 * randomized, so the whole tumble is a deterministic function of that draw.
 */
export interface TumbleState {
  x: number;
  y: number;
  vx: number;
  vy: number;
  yaw: number;
  yawRate: number;
  exitS: number;
}

/**
 * Per-car simulation state along its lane path.
 *
 * `phase` drives dispatch in sim/car/car.ts: 'slot' runs motor/brake +
 * cornering; 'tumbling'/'waiting' run the deslot state machine and ignore
 * throttle input. `phaseTicks` counts ticks spent in the current phase
 * (reset to 0 on every phase transition). `generation` increments on every
 * reslot — the renderer's cue to snap instead of interpolating a teleport
 * across the table (see main.ts's GENERATION GUARD).
 */
export interface CarState {
  s: number;
  v: number;
  lane: number;
  lapCount: number;
  /** Slide yaw offset added to path heading, in rad. Positive = nose rotates into the turn. */
  slideYaw: number;
  /** First-order-filtered lateral demand, in m/s². */
  aLatFiltered: number;
  /** Consecutive ticks aLatFiltered has exceeded gripHard (dwell counter for deslot). */
  hardTicks: number;
  phase: 'slot' | 'tumbling' | 'waiting';
  phaseTicks: number;
  generation: number;
  tumble: TumbleState | null;
}

/** Emitted by sim/timing.ts when a car's step crosses the s=0 lap line. */
export interface LapEvent {
  type: 'lap';
  carIndex: number;
  lapNumber: number;
  lapTimeSec: number;
}

/** Emitted by sim/car/car.ts when cornering's dwell-limited grip check trips. */
export interface DeslotEvent {
  type: 'deslot';
  carIndex: number;
  atS: number;
  speed: number;
}

/** Emitted by sim/car/car.ts when a tumbling/waiting car returns to the slot. */
export interface ReslotEvent {
  type: 'reslot';
  carIndex: number;
}

/** Emitted by sim/world.ts / sim/car/car.ts as cars cross the lap line or deslot/reslot. */
export type SimEvent = LapEvent | DeslotEvent | ReslotEvent;
