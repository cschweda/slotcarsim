// Regression guard for the main.ts -> render/carPose.ts extraction (a
// mechanical move — see that file's own docblock): slot-phase wrapLerp
// interpolation, the generation-change snap, and tumble passthrough, for
// both computeCarPose (debug view) and computeCarRenderPose (the real
// CarsView). This is the ONE helper both the live render loop and instant
// replay drive (game/replay.ts) — a regression here would silently desync
// the two.
import { describe, expect, it } from 'vitest';
import { createLanePath } from '../sim/track/path';
import type { CarState } from '../sim/types';
import { computeCarPose, computeCarRenderPose } from './carPose';

function straightLane(length = 10) {
  return createLanePath([{ type: 'line', p0: { x: 0, y: 0 }, p1: { x: length, y: 0 }, length }]);
}

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

describe('computeCarPose / computeCarRenderPose — slot phase, same generation', () => {
  it('interpolates s (wrapLerp) and slideYaw (lerp) by alpha', () => {
    const lane = straightLane();
    const prev = freshCarState({ s: 2, slideYaw: 0 });
    const curr = freshCarState({ s: 4, slideYaw: 0.2 });

    const pose = computeCarPose(prev, curr, 0.5, lane);
    expect(pose.x).toBeCloseTo(3, 12); // halfway between s=2 and s=4 on a straight line
    expect(pose.elevated).toBeUndefined();

    const renderPose = computeCarRenderPose(prev, curr, 0.5, lane);
    expect(renderPose).toMatchObject({ mode: 'slot', slideYaw: 0.1, lane: 0, generation: 0 });
    if (renderPose.mode === 'slot') expect(renderPose.s).toBeCloseTo(3, 12);
  });

  it('wraps forward across the s=0 seam rather than interpolating backward', () => {
    const lane = straightLane(10);
    const prev = freshCarState({ s: 9 });
    const curr = freshCarState({ s: 1 }); // wrapped forward by 2 (9 -> 10/0 -> 1)

    const renderPose = computeCarRenderPose(prev, curr, 0.5, lane);
    if (renderPose.mode === 'slot') expect(renderPose.s).toBeCloseTo(0, 12); // halfway of a 2-unit forward hop from 9
  });

  it('at alpha=0 reads exactly the prev state; at alpha approaching 1, approaches curr', () => {
    const lane = straightLane();
    const prev = freshCarState({ s: 2 });
    const curr = freshCarState({ s: 6 });
    expect(computeCarRenderPose(prev, curr, 0, lane)).toMatchObject({ s: 2 });
    const near1 = computeCarRenderPose(prev, curr, 0.999, lane);
    if (near1.mode === 'slot') expect(near1.s).toBeCloseTo(6, 2);
  });
});

describe('computeCarPose / computeCarRenderPose — generation guard', () => {
  it('snaps to curr.s directly (ignoring alpha/prev.s) when generation changes — a reslot teleport, never interpolated', () => {
    const lane = straightLane();
    const prev = freshCarState({ s: 9.5, generation: 0 });
    const curr = freshCarState({ s: 0.2, generation: 1 }); // reslotted at the exit point, far from prev.s

    const pose = computeCarPose(prev, curr, 0.5, lane);
    const expected = lane.pointAt(0.2).pos;
    expect(pose.x).toBeCloseTo(expected.x, 12);

    const renderPose = computeCarRenderPose(prev, curr, 0.5, lane);
    expect(renderPose).toMatchObject({ mode: 'slot', s: 0.2, generation: 1 });
  });
});

describe('computeCarPose / computeCarRenderPose — tumble phase', () => {
  it('reads the tumble pose (elevated / mode "tumble"), ignoring prevState/alpha entirely', () => {
    const lane = straightLane();
    const tumble = { x: 1.5, y: -0.3, vx: 0, vy: 0, yaw: 0.4, yawRate: 8, exitS: 3 };
    const prev = freshCarState({ s: 5, phase: 'slot' });
    const curr = freshCarState({ phase: 'tumbling', phaseTicks: 3, tumble });

    const pose = computeCarPose(prev, curr, 0.7, lane);
    expect(pose).toMatchObject({ x: 1.5, y: -0.3, yaw: 0.4, elevated: true });

    const renderPose = computeCarRenderPose(prev, curr, 0.7, lane);
    expect(renderPose).toMatchObject({ mode: 'tumble', x: 1.5, y: -0.3, yaw: 0.4, yawRate: 8, phase: 'tumbling' });
  });
});
