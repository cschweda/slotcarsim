import { describe, expect, it, vi } from 'vitest';
import { createLoop } from './loop';

const DT = 1 / 120;

describe('createLoop', () => {
  it('advances exactly 2 steps for a 16.7ms frame at dt=1/120', () => {
    const step = vi.fn();
    const loop = createLoop({ step });

    const alpha = loop.advance(0.0167);

    expect(step).toHaveBeenCalledTimes(2);
    expect(loop.tick).toBe(2);
    const expectedAlpha = (0.0167 - 2 / 120) * 120;
    expect(alpha).toBeCloseTo(expectedAlpha, 9);
    expect(loop.alpha).toBeCloseTo(expectedAlpha, 9);
  });

  it('clamps a 500ms frame to the default 100ms max, taking at most 12 steps (no spiral of death)', () => {
    const step = vi.fn();
    const loop = createLoop({ step });

    loop.advance(0.5);

    expect(step.mock.calls.length).toBeLessThanOrEqual(12);
    expect(step.mock.calls.length).toBeGreaterThan(0);
    expect(loop.alpha).toBeGreaterThanOrEqual(0);
    expect(loop.alpha).toBeLessThan(1);
  });

  it('accumulates 120 identical dt-sized frames into exactly 120 steps with no float drift', () => {
    // Floating point note: 1/120 has no exact binary64 representation, so a
    // naive `accumulator >= dt` comparison can spuriously read false by a few
    // ULPs right at an exact-multiple boundary and drop a step that's
    // mathematically due. createLoop guards its accumulator comparison with a
    // small fixed epsilon so landing on (or a hair below) a multiple of dt
    // still fires the step; this test locks that guarantee in across 120
    // consecutive exact-dt frames.
    const step = vi.fn();
    const loop = createLoop({ step });

    for (let i = 0; i < 120; i++) {
      loop.advance(DT);
    }

    expect(step).toHaveBeenCalledTimes(120);
    expect(loop.tick).toBe(120);
  });

  it('reset() clears the pending accumulator remainder', () => {
    const step = vi.fn();
    const loop = createLoop({ step });

    loop.advance(0.9 * DT);
    loop.reset();
    loop.advance(0.9 * DT);

    expect(step).not.toHaveBeenCalled();
    expect(loop.tick).toBe(0);
  });

  it('passes step monotonically increasing consecutive integer ticks across multiple advance() calls', () => {
    const seenTicks: number[] = [];
    const loop = createLoop({
      step: (_dt, tick) => {
        seenTicks.push(tick);
      },
    });

    loop.advance(3 * DT); // 3 whole steps, no remainder
    loop.advance(4 * DT); // 4 more whole steps, no remainder

    expect(seenTicks).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });
});
