import { describe, expect, it } from 'vitest';
import type { Tuning } from '../../config/tuning';
import { TUNING } from '../../config/tuning';
import { createRng } from '../rng';
import type { TumbleState } from '../types';
import { beginTumble, stepDeslot, tumblePose } from './deslot';

const DT = 1 / 120;

describe('beginTumble', () => {
  it('left turn (κ>0): outward kick is to the right of travel, spin is negative', () => {
    const cfg: Tuning = { ...TUNING };
    const heading = 0; // tangent = (1,0)
    const v = 2;
    const kappa = 5; // left

    const expectedRng = createRng(11);
    const kickFraction = expectedRng.range(0.2, 0.5);
    const spinMag = expectedRng.range(6, 14);
    const kick = 0.35 * v * kickFraction;

    const tumble = beginTumble({ x: 3, y: 4 }, heading, 1.5, v, kappa, createRng(11), cfg);

    expect(tumble.x).toBe(3);
    expect(tumble.y).toBe(4);
    expect(tumble.exitS).toBe(1.5);
    expect(tumble.yaw).toBe(heading);
    expect(tumble.vx).toBeCloseTo(v, 9); // tangent=(1,0): outward=(0,-1) contributes 0 to vx
    expect(tumble.vy).toBeCloseTo(-kick, 9); // outward y-component is negative (right of travel)
    expect(tumble.yawRate).toBeCloseTo(-spinMag, 9); // spin sign = -sign(κ) = -1
    expect(kickFraction).toBeGreaterThanOrEqual(0.2);
    expect(kickFraction).toBeLessThan(0.5);
    expect(spinMag).toBeGreaterThanOrEqual(6);
    expect(spinMag).toBeLessThan(14);
  });

  it('right turn (κ<0): outward kick is to the left of travel, spin is positive', () => {
    const cfg: Tuning = { ...TUNING };
    const heading = 0;
    const v = 2;
    const kappa = -5; // right

    const expectedRng = createRng(11);
    const kickFraction = expectedRng.range(0.2, 0.5);
    const spinMag = expectedRng.range(6, 14);
    const kick = 0.35 * v * kickFraction;

    const tumble = beginTumble({ x: 0, y: 0 }, heading, 0, v, kappa, createRng(11), cfg);

    expect(tumble.vx).toBeCloseTo(v, 9);
    expect(tumble.vy).toBeCloseTo(kick, 9); // outward is now (0, +1)
    expect(tumble.yawRate).toBeCloseTo(spinMag, 9); // spin sign = -sign(κ) = +1
  });

  it('respects a non-axis-aligned exit heading (rotation applied correctly)', () => {
    const cfg: Tuning = { ...TUNING };
    const heading = Math.PI / 2; // tangent = (0,1)
    const v = 2;
    const kappa = 5; // left → outwardSign = -1 → outward = (1, 0) at this heading

    const rng = createRng(3);
    const kickFraction = createRng(3).range(0.2, 0.5);
    const kick = 0.35 * v * kickFraction;

    const tumble = beginTumble({ x: 0, y: 0 }, heading, 0, v, kappa, rng, cfg);

    expect(tumble.vx).toBeCloseTo(kick, 9);
    expect(tumble.vy).toBeCloseTo(v, 9);
    expect(tumble.yaw).toBeCloseTo(heading, 12);
  });

  it('draws exactly once each from kickFraction and spin ranges (deterministic given a seed)', () => {
    const cfg: Tuning = { ...TUNING };
    const a = beginTumble({ x: 0, y: 0 }, 0, 0, 2, 5, createRng(42), cfg);
    const b = beginTumble({ x: 0, y: 0 }, 0, 0, 2, 5, createRng(42), cfg);
    expect(a).toEqual(b);
  });
});

describe('stepDeslot — tumbling kinematics', () => {
  function tumbleAt(vx: number, vy: number): TumbleState {
    return { x: 0, y: 0, vx, vy, yaw: 0, yawRate: 0, exitS: 1.23 };
  }

  it('decelerates speed by tumbleFriction·dt on a single tick, preserving direction', () => {
    const cfg: Tuning = { ...TUNING };
    const tumble = tumbleAt(2, 0);

    const result = stepDeslot(tumble, 'tumbling', 0, DT, cfg);

    const expectedSpeed = 2 - cfg.tumbleFriction * DT;
    expect(result.tumble.vx).toBeCloseTo(expectedSpeed, 9);
    expect(result.tumble.vy).toBeCloseTo(0, 12);
    expect(result.tumble.x).toBeCloseTo(expectedSpeed * DT, 9);
    expect(result.phase).toBe('tumbling');
    expect(result.phaseTicks).toBe(1);
    expect(result.reslotted).toBe(false);
  });

  it('comes to rest and then sits still for the remainder of the tumbling phase', () => {
    const cfg: Tuning = { ...TUNING };
    let tumble = tumbleAt(2, 0);
    let phaseTicks = 0;

    // 2 m/s at 8 m/s² friction takes exactly 30 ticks (at dt=1/120) to reach 0.
    for (let i = 0; i < 35; i++) {
      const result = stepDeslot(tumble, 'tumbling', phaseTicks, DT, cfg);
      tumble = result.tumble;
      phaseTicks = result.phaseTicks;
    }
    expect(tumble.vx).toBe(0);
    expect(tumble.vy).toBe(0);
    const restX = tumble.x;

    for (let i = 0; i < 10; i++) {
      const result = stepDeslot(tumble, 'tumbling', phaseTicks, DT, cfg);
      tumble = result.tumble;
      phaseTicks = result.phaseTicks;
    }
    expect(tumble.x).toBe(restX);
    expect(tumble.vx).toBe(0);
  });

  it('integrates yaw by yawRate·dt each tick', () => {
    const cfg: Tuning = { ...TUNING };
    const tumble: TumbleState = { x: 0, y: 0, vx: 0, vy: 0, yaw: 0, yawRate: 10, exitS: 0 };
    const result = stepDeslot(tumble, 'tumbling', 0, DT, cfg);
    expect(result.tumble.yaw).toBeCloseTo(10 * DT, 12);
  });

  it('transitions tumbling → waiting at exactly round(tumbleDuration/dt) ticks, snapping velocity to 0', () => {
    const cfg: Tuning = { ...TUNING };
    let tumble = tumbleAt(2, 1);
    let phase: 'tumbling' | 'waiting' = 'tumbling';
    let phaseTicks = 0;

    const durationTicks = Math.round(cfg.tumbleDuration / DT);
    expect(durationTicks).toBe(132);

    for (let i = 1; i < durationTicks; i++) {
      const result = stepDeslot(tumble, phase, phaseTicks, DT, cfg);
      expect(result.phase).toBe('tumbling');
      tumble = result.tumble;
      phaseTicks = result.phaseTicks;
    }

    const finalResult = stepDeslot(tumble, phase, phaseTicks, DT, cfg);
    expect(finalResult.phase).toBe('waiting');
    expect(finalResult.phaseTicks).toBe(0);
    expect(finalResult.tumble.vx).toBe(0);
    expect(finalResult.tumble.vy).toBe(0);
    expect(finalResult.reslotted).toBe(false);
  });
});

describe('stepDeslot — waiting phase', () => {
  it('the car sits motionless for the whole waiting phase, then reslots at exactly round(marshalDuration/dt) ticks', () => {
    const cfg: Tuning = { ...TUNING };
    const tumble: TumbleState = { x: 5, y: -2, vx: 0, vy: 0, yaw: 1.1, yawRate: 10, exitS: 0.7 };
    let phaseTicks = 0;

    const durationTicks = Math.round(cfg.marshalDuration / DT);
    expect(durationTicks).toBe(108);

    for (let i = 1; i < durationTicks; i++) {
      const result = stepDeslot(tumble, 'waiting', phaseTicks, DT, cfg);
      expect(result.phase).toBe('waiting');
      expect(result.tumble).toEqual(tumble); // frozen: no kinematics during waiting
      expect(result.reslotted).toBe(false);
      phaseTicks = result.phaseTicks;
    }

    const finalResult = stepDeslot(tumble, 'waiting', phaseTicks, DT, cfg);
    expect(finalResult.phase).toBe('slot');
    expect(finalResult.phaseTicks).toBe(0);
    expect(finalResult.reslotted).toBe(true);
  });
});

describe('stepDeslot — total penalty', () => {
  it('tumbling + waiting sums to exactly tumbleDuration + marshalDuration = 2.0s', () => {
    const cfg: Tuning = { ...TUNING };
    let tumble: TumbleState = { x: 0, y: 0, vx: 1, vy: 0, yaw: 0, yawRate: 8, exitS: 0 };
    let phase: 'tumbling' | 'waiting' = 'tumbling';
    let phaseTicks = 0;
    let totalTicks = 0;
    let reslotted = false;

    const guard = 10_000;
    while (!reslotted && totalTicks < guard) {
      const result = stepDeslot(tumble, phase, phaseTicks, DT, cfg);
      tumble = result.tumble;
      phaseTicks = result.phaseTicks;
      totalTicks += 1;
      if (result.reslotted) {
        reslotted = true;
      } else {
        phase = result.phase as 'tumbling' | 'waiting';
      }
    }

    expect(reslotted).toBe(true);
    expect(totalTicks).toBe(132 + 108);
    expect(totalTicks * DT).toBeCloseTo(2.0, 9);
    expect(cfg.tumbleDuration + cfg.marshalDuration).toBe(2.0);
  });
});

describe('tumblePose', () => {
  it('progress is 0 at phaseTicks=0 and approaches 1 near the phase duration', () => {
    const cfg: Tuning = { ...TUNING };
    const tumble: TumbleState = { x: 1, y: 2, vx: 0, vy: 0, yaw: 0.5, yawRate: 0, exitS: 0 };

    const start = tumblePose({ phase: 'tumbling', phaseTicks: 0, tumble }, cfg, DT);
    expect(start.progress).toBe(0);

    const durationTicks = Math.round(cfg.tumbleDuration / DT);
    const almostDone = tumblePose({ phase: 'tumbling', phaseTicks: durationTicks - 1, tumble }, cfg, DT);
    expect(almostDone.progress).toBeGreaterThan(0.9);
    expect(almostDone.progress).toBeLessThan(1);
  });

  it('clamps progress at 1 even if phaseTicks exceeds the phase duration', () => {
    const cfg: Tuning = { ...TUNING };
    const tumble: TumbleState = { x: 0, y: 0, vx: 0, vy: 0, yaw: 0, yawRate: 0, exitS: 0 };
    const durationTicks = Math.round(cfg.marshalDuration / DT);
    const pose = tumblePose({ phase: 'waiting', phaseTicks: durationTicks + 50, tumble }, cfg, DT);
    expect(pose.progress).toBe(1);
  });

  it('uses the correct duration per phase (tumbling vs waiting differ)', () => {
    const cfg: Tuning = { ...TUNING };
    const tumble: TumbleState = { x: 0, y: 0, vx: 0, vy: 0, yaw: 0, yawRate: 0, exitS: 0 };
    const ticks = 50;
    const tumbling = tumblePose({ phase: 'tumbling', phaseTicks: ticks, tumble }, cfg, DT);
    const waiting = tumblePose({ phase: 'waiting', phaseTicks: ticks, tumble }, cfg, DT);
    expect(tumbling.progress).not.toBeCloseTo(waiting.progress, 3);
  });

  it('passes pos/yaw straight through from the tumble state', () => {
    const cfg: Tuning = { ...TUNING };
    const tumble: TumbleState = { x: 7.5, y: -3.2, vx: 0, vy: 0, yaw: 2.1, yawRate: 0, exitS: 0 };
    const pose = tumblePose({ phase: 'waiting', phaseTicks: 0, tumble }, cfg, DT);
    expect(pose.pos).toEqual({ x: 7.5, y: -3.2 });
    expect(pose.yaw).toBe(2.1);
    expect(pose.phase).toBe('waiting');
  });
});
