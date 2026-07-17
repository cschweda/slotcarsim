// Per-player throttle abstraction. Deliberately decoupled from any concrete
// device — sim/world.ts only ever sees the InputFrame this produces, never a
// Gamepad or KeyboardEvent, which is what keeps 2P/net-ready input feasible
// without retrofitting (see the design doc's multiplayer note).
export interface ThrottleSource {
  /**
   * Sample the current throttle in [0, 1]. `dt` (seconds since this source's
   * last read) is required so time-based sources (keyboard ramp) can advance
   * their internal state without depending on wall-clock reads of their own,
   * which would violate sim purity. Device-polled sources (gamepad) accept
   * but ignore it.
   */
  read(dt: number): number;
  readonly label: string;
  readonly connected: boolean;
}
