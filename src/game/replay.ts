// Instant replay's pure logic: a fixed-capacity ring buffer that records
// every racing sim tick (createReplayBuffer) and a half-speed playback cursor
// over a captured window of it (createReplayPlayback). DOM-free and
// sim-untouched — this is a READ-ONLY consumer: it clones states after each
// sim step and never feeds anything back. main.ts wires the two together
// (recording from the loop's own step callback, driving the render/audio
// path from the playback cursor during a replay) — see its own REPLAY
// section for that.
import type { CarState } from '../sim/types';

/** Wall-clock-to-playback time scale for createReplayPlayback's `speed` — half speed by default, so a fast tumble reads clearly. */
export const DEFAULT_REPLAY_SPEED = 0.5;

/**
 * One recorded sim tick: a deep-enough clone of every car's state, plus the
 * PLAYER's own raw throttle input for that tick. The throttle isn't otherwise
 * recoverable from CarState — it's needed so a replayed motor voice for the
 * human-controlled car stays honest, matching main.ts's own voice rule
 * (`config.controlled === 'input' ? pendingInput.throttle : state.v / vmax`).
 */
export interface ReplayFrame {
  states: CarState[];
  playerThrottle: number;
}

export interface ReplayBuffer {
  /**
   * Push one tick's states (+ this tick's player throttle) into the ring,
   * deep-enough-cloning so the live sim can never mutate recorded history
   * through a shared reference. `sim/world.ts` already gives each CarState a
   * fresh top-level object every tick, but its nullable `tumble` sub-object is
   * NOT always fresh: `sim/car/deslot.ts`'s `stepDeslot` keeps the exact same
   * `tumble` reference, unmutated, across every tick of the 'waiting' phase —
   * a real aliasing case, not a hypothetical one — so `tumble` gets its own
   * shallow clone too.
   */
  record(states: readonly CarState[], playerThrottle: number): void;
  /** The last `lengthSec` seconds of recorded ticks, oldest first — fewer than `lengthSec/dt` ticks if the buffer hasn't been recording that long yet. */
  window(lengthSec?: number): ReplayFrame[];
  /** Ticks currently held, in [0, capacityTicks]. */
  size(): number;
  /** Drops every recorded tick (session rebuild). */
  clear(): void;
}

const DEFAULT_CAPACITY_SEC = 6;
const DEFAULT_DT = 1 / 120;
const DEFAULT_WINDOW_SEC = 3;

/** `((a % m) + m) % m` — the established double-mod idiom this codebase already uses for wraparound (sim/math.ts's wrapAngle/wrapLerp), needed here because JS's `%` can return negative results. */
function wrapIndex(i: number, capacity: number): number {
  return ((i % capacity) + capacity) % capacity;
}

function cloneState(state: CarState): CarState {
  return { ...state, tumble: state.tumble ? { ...state.tumble } : null };
}

/**
 * `capacitySec`/`dt` fix the ring's tick capacity (`Math.round(capacitySec /
 * dt)`) once, at construction — matching `createReplayPlayback`'s own `dt`,
 * both default to the sim's fixed 120 Hz tick (`loop.ts`'s `DEFAULT_DT`)
 * duplicated as a plain literal here rather than imported, since `src/game/`
 * stays a read-only consumer of the sim, never importing its runtime modules
 * for anything beyond types.
 */
export function createReplayBuffer(capacitySec = DEFAULT_CAPACITY_SEC, dt = DEFAULT_DT): ReplayBuffer {
  const capacityTicks = Math.max(1, Math.round(capacitySec / dt));
  const ring: ReplayFrame[] = new Array(capacityTicks);
  let writeIndex = 0; // the slot the NEXT record() will write
  let count = 0; // ticks held so far, capped at capacityTicks

  function record(states: readonly CarState[], playerThrottle: number): void {
    ring[writeIndex] = { states: states.map(cloneState), playerThrottle };
    writeIndex = wrapIndex(writeIndex + 1, capacityTicks);
    count = Math.min(count + 1, capacityTicks);
  }

  function window(lengthSec = DEFAULT_WINDOW_SEC): ReplayFrame[] {
    const wanted = Math.max(0, Math.round(lengthSec / dt));
    const n = Math.min(wanted, count);
    if (n === 0) return [];
    const start = wrapIndex(writeIndex - n, capacityTicks);
    const result: ReplayFrame[] = new Array(n);
    for (let i = 0; i < n; i++) result[i] = ring[wrapIndex(start + i, capacityTicks)]!;
    return result;
  }

  function size(): number {
    return count;
  }

  function clear(): void {
    ring.length = 0;
    ring.length = capacityTicks;
    writeIndex = 0;
    count = 0;
  }

  return { record, window, size, clear };
}

// ---------------------------------------------------------------------------

/**
 * Where playback currently sits within a captured `ReplayFrame[]` window:
 * `index`/`nextIndex` are the two recorded ticks to interpolate between (via
 * the SAME shared render/carPose.ts helper the live path uses — this cursor
 * carries no CarState/lane knowledge of its own, by design, so it can't
 * diverge from that helper's own wrapLerp-style/generation-snap rules) and
 * `alpha` is the fraction between them, in [0, 1).
 */
export interface PlaybackCursor {
  index: number;
  /** `index + 1`, clamped to the final index once playback has reached it (nothing further to lerp toward). */
  nextIndex: number;
  /** Interpolation fraction between `frames[index]` and `frames[nextIndex]` — 0 once `index === nextIndex` (the final frame). */
  alpha: number;
  /** Overall fraction of the window played so far, in [0, 1] — always 1 once `done`. Drives the REPLAY banner's progress bar. */
  progress: number;
}

export interface ReplayPlaybackOptions {
  /** Wall-clock-to-playback time scale — defaults to DEFAULT_REPLAY_SPEED (0.5, half speed). */
  speed?: number;
  /** The recording tick spacing, in seconds — must match whatever `dt` the frames were recorded at (createReplayBuffer's own `dt`). */
  dt: number;
}

export interface ReplayPlayback {
  /** Advance playback by a REAL wall-clock delta (seconds), scaled internally by `speed`. Returns the new cursor (same value `cursor()` then reflects). Pinned at the final frame once `done` — further calls are harmless no-ops. */
  advance(frameDeltaSec: number): PlaybackCursor;
  /** The cursor as of the last `advance()` call (or the initial one, before any call). */
  cursor(): PlaybackCursor;
  /** True once playback has reached the final recorded frame — the window is exhausted, nothing left to play. */
  readonly done: boolean;
}

export function createReplayPlayback(
  frames: readonly ReplayFrame[],
  opts: ReplayPlaybackOptions,
): ReplayPlayback {
  const speed = opts.speed ?? DEFAULT_REPLAY_SPEED;
  const { dt } = opts;
  const lastIndex = Math.max(0, frames.length - 1);
  const totalSec = lastIndex * dt;

  let elapsed = 0; // playback-timeline seconds, already speed-scaled
  let done = lastIndex === 0; // a 0- or 1-frame window has nothing to interpolate/play

  function computeCursor(): PlaybackCursor {
    if (lastIndex === 0) return { index: 0, nextIndex: 0, alpha: 0, progress: 1 };
    const raw = elapsed / dt;
    const index = Math.min(Math.floor(raw), lastIndex);
    const nextIndex = Math.min(index + 1, lastIndex);
    const alpha = index === nextIndex ? 0 : raw - index;
    return { index, nextIndex, alpha, progress: elapsed / totalSec };
  }

  let current = computeCursor();

  function advance(frameDeltaSec: number): PlaybackCursor {
    if (!done) {
      elapsed = Math.min(elapsed + frameDeltaSec * speed, totalSec);
      current = computeCursor();
      if (current.index >= lastIndex) done = true;
    }
    return current;
  }

  return {
    advance,
    cursor: () => current,
    get done() {
      return done;
    },
  };
}
