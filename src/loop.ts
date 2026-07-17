// Pure fixed-timestep accumulator loop. No DOM, no requestAnimationFrame —
// callers (main.ts) own the rAF wiring and pass in frame deltas.

const DEFAULT_DT = 1 / 120;
const DEFAULT_MAX_FRAME_DELTA = 0.1;

// 1/120 (and other fractional dt values) have no exact binary64
// representation, so comparing `accumulator >= dt` can spuriously read false
// by a few ULPs right at an exact-multiple boundary and drop a step that is
// mathematically due. Padding the comparison by a tiny fixed epsilon (many
// orders of magnitude smaller than any realistic dt) absorbs that rounding
// noise without ever triggering an extra, unearned step.
const EPSILON = 1e-9;

export interface CreateLoopOptions {
  /** Fixed simulation step, in seconds. Defaults to 1/120. */
  dt?: number;
  /** Upper bound on a single frame's delta, in seconds. Defaults to 0.1. */
  maxFrameDelta?: number;
  /** Called once per fixed step with the step size and the new integer tick. */
  step: (dt: number, tick: number) => void;
}

export interface Loop {
  /** Integer count of sim steps taken so far. Not reset by reset(). */
  readonly tick: number;
  /** Interpolation fraction in [0, 1) for the leftover accumulator time. */
  readonly alpha: number;
  /**
   * Advance the loop by a frame's wall-clock delta (seconds). Clamps the
   * delta, runs `step` zero or more times, and returns the new alpha.
   */
  advance(frameDeltaSeconds: number): number;
  /** Zero the pending accumulator (e.g. on visibility resume). Tick is untouched. */
  reset(): void;
}

export function createLoop(opts: CreateLoopOptions): Loop {
  const dt = opts.dt ?? DEFAULT_DT;
  const maxFrameDelta = opts.maxFrameDelta ?? DEFAULT_MAX_FRAME_DELTA;
  const { step } = opts;

  let accumulator = 0;
  let tick = 0;
  let alpha = 0;

  function advance(frameDeltaSeconds: number): number {
    const clamped = Math.min(frameDeltaSeconds, maxFrameDelta);
    accumulator += clamped;

    while (accumulator + EPSILON >= dt) {
      accumulator -= dt;
      tick += 1;
      step(dt, tick);
    }

    // The epsilon above can let a step fire while the true remainder is a
    // hair below zero; clamp so alpha never reports outside [0, 1).
    if (accumulator < 0) {
      accumulator = 0;
    }
    alpha = accumulator / dt;
    return alpha;
  }

  function reset(): void {
    accumulator = 0;
    alpha = 0;
  }

  return {
    get tick() {
      return tick;
    },
    get alpha() {
      return alpha;
    },
    advance,
    reset,
  };
}
