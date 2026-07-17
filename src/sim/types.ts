// Minimal skeletal types for later sim milestones. Intentionally sparse
// (YAGNI) — extended as motor/cornering/track/ai land in M1+.

/** Per-tick input for one player/car, decoupled from any input source. */
export interface InputFrame {
  throttle: number;
}

/** Per-car simulation state along its lane path. */
export interface CarState {
  s: number;
  v: number;
  lane: number;
}
