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
 * Per-car simulation state along its lane path. No generation counter yet —
 * that arrives with M3's deslot/reslot (renderer needs it to snap instead of
 * lerping a teleport).
 */
export interface CarState {
  s: number;
  v: number;
  lane: number;
  lapCount: number;
}

/** Emitted by sim/world.ts when a car's step crosses the s=0 lap line. */
export type SimEvent = {
  type: 'lap';
  carIndex: number;
  lapNumber: number;
  lapTimeSec: number;
};
