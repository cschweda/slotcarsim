// Tests for the pure instant-replay logic: a fixed-capacity ring buffer of
// recorded sim ticks (createReplayBuffer) and a half-speed playback cursor
// over a captured window (createReplayPlayback). DOM-free, sim-untouched —
// both take/return plain data (CarState clones, indices) only.
import { describe, expect, it } from 'vitest';
import type { CarState } from '../sim/types';
import {
  DEFAULT_REPLAY_SPEED,
  createReplayBuffer,
  createReplayPlayback,
  type ReplayFrame,
} from './replay';

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

/** A one-car state array tagged with a distinguishable `s` value, so recorded ticks can be told apart by identity in wrap-around/window assertions. */
function tagged(s: number): CarState[] {
  return [freshCarState({ s })];
}

describe('createReplayBuffer', () => {
  it('window() is empty before anything is recorded', () => {
    const buf = createReplayBuffer(6, 1);
    expect(buf.window(3)).toEqual([]);
    expect(buf.size()).toBe(0);
  });

  it('window(lengthSec) returns the last N ticks, oldest first, when the buffer holds at least that many', () => {
    const buf = createReplayBuffer(6, 1); // dt=1s/tick -> capacityTicks=6
    for (let s = 0; s < 6; s++) buf.record(tagged(s), 0);

    const win = buf.window(3);
    expect(win.map((f) => f.states[0]!.s)).toEqual([3, 4, 5]);
  });

  it('window when the session is younger than the requested length returns only what has been recorded so far', () => {
    const buf = createReplayBuffer(6, 1);
    buf.record(tagged(0), 0);
    buf.record(tagged(1), 0);

    const win = buf.window(3); // wants 3 ticks, only 2 exist
    expect(win.map((f) => f.states[0]!.s)).toEqual([0, 1]);
    expect(buf.size()).toBe(2);
  });

  it('ring wrap-around: recording past capacity discards the oldest ticks first', () => {
    const buf = createReplayBuffer(3, 1); // capacityTicks=3
    for (let s = 0; s < 5; s++) buf.record(tagged(s), 0); // 0,1,2,3,4 -> keeps 2,3,4

    expect(buf.size()).toBe(3);
    expect(buf.window(3).map((f) => f.states[0]!.s)).toEqual([2, 3, 4]);
  });

  it('size() caps at capacityTicks even after many more records', () => {
    const buf = createReplayBuffer(2, 1); // capacityTicks=2
    for (let s = 0; s < 50; s++) buf.record(tagged(s), 0);
    expect(buf.size()).toBe(2);
    expect(buf.window(10).map((f) => f.states[0]!.s)).toEqual([48, 49]);
  });

  it('clear() drops every recorded tick', () => {
    const buf = createReplayBuffer(6, 1);
    buf.record(tagged(0), 0);
    buf.record(tagged(1), 0);
    buf.clear();
    expect(buf.size()).toBe(0);
    expect(buf.window(3)).toEqual([]);
  });

  it('records the player throttle alongside each tick\'s states', () => {
    const buf = createReplayBuffer(6, 1);
    buf.record(tagged(0), 0.25);
    buf.record(tagged(1), 0.75);
    expect(buf.window(2).map((f) => f.playerThrottle)).toEqual([0.25, 0.75]);
  });

  it('clone isolation: mutating the original states array/tumble object after record() does not change the buffer', () => {
    const buf = createReplayBuffer(6, 1);
    const tumble = { x: 1, y: 2, vx: 3, vy: 4, yaw: 0.1, yawRate: 5, exitS: 9 };
    const states: CarState[] = [freshCarState({ s: 1, tumble })];

    buf.record(states, 0);

    // Mutate the ORIGINAL objects in place, as if the live sim continued
    // (sim/car/deslot.ts's stepDeslot keeps the SAME tumble reference across
    // every 'waiting'-phase tick, so this aliasing risk is real, not
    // hypothetical).
    states[0]!.s = 999;
    tumble.x = 999;
    tumble.yawRate = 999;

    const recorded = buf.window(1)[0]!;
    expect(recorded.states[0]!.s).toBe(1);
    expect(recorded.states[0]!.tumble).not.toBeNull();
    expect(recorded.states[0]!.tumble!.x).toBe(1);
    expect(recorded.states[0]!.tumble!.yawRate).toBe(5);
  });

  it('clone isolation holds for a null tumble too (the common on-track case)', () => {
    const buf = createReplayBuffer(6, 1);
    const states: CarState[] = [freshCarState({ s: 2, tumble: null })];
    buf.record(states, 0);
    states[0]!.s = 999;
    expect(buf.window(1)[0]!.states[0]!.s).toBe(2);
    expect(buf.window(1)[0]!.states[0]!.tumble).toBeNull();
  });

  it('defaults to capacitySec=6, dt=1/120 (120 Hz sim tick) when called with no args', () => {
    const buf = createReplayBuffer();
    for (let i = 0; i < 6 * 120; i++) buf.record(tagged(i), 0);
    expect(buf.size()).toBe(6 * 120); // exactly fills a 6s-at-120Hz capacity, no wrap yet
    buf.record(tagged(999), 0); // one more tick wraps
    expect(buf.size()).toBe(6 * 120);
    expect(buf.window(6 * 120)[0]!.states[0]!.s).toBe(1); // the oldest (s=0) tick was evicted
  });
});

describe('createReplayPlayback', () => {
  function frames(n: number): ReplayFrame[] {
    return Array.from({ length: n }, (_, i) => ({ states: tagged(i), playerThrottle: 0 }));
  }

  it('starts at index 0 / alpha 0 / progress 0 before any advance() call', () => {
    const playback = createReplayPlayback(frames(4), { dt: 1, speed: 1 });
    const cursor = playback.cursor();
    expect(cursor).toEqual({ index: 0, nextIndex: 1, alpha: 0, progress: 0 });
    expect(playback.done).toBe(false);
  });

  it('advancing by half a recorded tick (at speed=1) produces alpha=0.5 without moving the index', () => {
    const playback = createReplayPlayback(frames(4), { dt: 1, speed: 1 });
    const cursor = playback.advance(0.5);
    expect(cursor.index).toBe(0);
    expect(cursor.nextIndex).toBe(1);
    expect(cursor.alpha).toBeCloseTo(0.5, 12);
  });

  it('advancing by exactly one recorded tick (at speed=1) lands cleanly on the next index, alpha=0', () => {
    const playback = createReplayPlayback(frames(4), { dt: 1, speed: 1 });
    const cursor = playback.advance(1);
    expect(cursor).toEqual({ index: 1, nextIndex: 2, alpha: 0, progress: 1 / 3 });
  });

  it('playback timing at 0.5x: a wall-clock delta of 2·dt advances exactly one recorded tick', () => {
    const dt = 1 / 120;
    const playback = createReplayPlayback(frames(5), { dt, speed: DEFAULT_REPLAY_SPEED });
    expect(DEFAULT_REPLAY_SPEED).toBe(0.5);

    const first = playback.advance(2 * dt);
    expect(first).toEqual({ index: 1, nextIndex: 2, alpha: 0, progress: 1 / 4 });

    const second = playback.advance(2 * dt);
    expect(second).toEqual({ index: 2, nextIndex: 3, alpha: 0, progress: 2 / 4 });
  });

  it('done condition is exact: flips true only once the cursor reaches the final frame, and further advance() calls hold there', () => {
    const dt = 1;
    const playback = createReplayPlayback(frames(3), { dt, speed: 1 }); // lastIndex=2
    expect(playback.done).toBe(false);

    let cursor = playback.advance(1); // index 1
    expect(playback.done).toBe(false);
    expect(cursor.index).toBe(1);

    cursor = playback.advance(1); // index 2 == lastIndex -> exhausted
    expect(playback.done).toBe(true);
    expect(cursor).toEqual({ index: 2, nextIndex: 2, alpha: 0, progress: 1 });

    // Further advances must not overshoot / throw — pinned at the end.
    const held = playback.advance(10);
    expect(held).toEqual({ index: 2, nextIndex: 2, alpha: 0, progress: 1 });
    expect(playback.done).toBe(true);
  });

  it('progress runs linearly from 0 to 1 across the window', () => {
    const playback = createReplayPlayback(frames(5), { dt: 1, speed: 1 }); // lastIndex=4
    expect(playback.advance(2).progress).toBeCloseTo(0.5, 12);
    expect(playback.advance(2).progress).toBe(1);
  });

  it('a single-frame window is done immediately and never divides by zero', () => {
    const playback = createReplayPlayback(frames(1), { dt: 1, speed: 1 });
    expect(playback.done).toBe(true);
    expect(playback.cursor()).toEqual({ index: 0, nextIndex: 0, alpha: 0, progress: 1 });
    expect(playback.advance(5)).toEqual({ index: 0, nextIndex: 0, alpha: 0, progress: 1 });
  });

  it('an empty window is done immediately and harmless', () => {
    const playback = createReplayPlayback([], { dt: 1, speed: 1 });
    expect(playback.done).toBe(true);
    expect(playback.cursor()).toEqual({ index: 0, nextIndex: 0, alpha: 0, progress: 1 });
  });

  it('defaults speed to DEFAULT_REPLAY_SPEED (0.5) when omitted', () => {
    const dt = 1;
    const withDefault = createReplayPlayback(frames(5), { dt });
    const withExplicit = createReplayPlayback(frames(5), { dt, speed: DEFAULT_REPLAY_SPEED });
    expect(withDefault.advance(2)).toEqual(withExplicit.advance(2));
  });
});
