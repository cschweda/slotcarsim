import { describe, expect, it } from 'vitest';
import { motorF0, motorGains, panForX } from './mapping';

describe('motorF0', () => {
  it('is 120 Hz (the floor) at v=0', () => {
    expect(motorF0(0, 3)).toBe(120);
  });

  it('is 640 Hz (the ceiling) exactly at v=vmax', () => {
    expect(motorF0(3, 3)).toBe(640);
  });

  it('is linear in between: half of vmax gives the midpoint', () => {
    expect(motorF0(1.5, 3)).toBeCloseTo(380, 9);
  });

  it('clamps to 640 for v beyond vmax (transient overspeed while tuning)', () => {
    expect(motorF0(6, 3)).toBe(640);
  });

  it('clamps to 120 for negative v (defensive — v is never negative in the sim itself)', () => {
    expect(motorF0(-1, 3)).toBe(120);
  });
});

describe('panForX', () => {
  const centerX = 0.381; // track centroid x, sim coords
  const halfWidth = 0.85; // half the 1.7 m table width

  it('is 0 dead center', () => {
    expect(panForX(centerX, centerX, halfWidth)).toBe(0);
  });

  it('is +1 at the right table edge', () => {
    expect(panForX(centerX + halfWidth, centerX, halfWidth)).toBeCloseTo(1, 9);
  });

  it('is -1 at the left table edge', () => {
    expect(panForX(centerX - halfWidth, centerX, halfWidth)).toBeCloseTo(-1, 9);
  });

  it('clamps beyond the right edge to +1', () => {
    expect(panForX(centerX + halfWidth * 3, centerX, halfWidth)).toBe(1);
  });

  it('clamps beyond the left edge to -1', () => {
    expect(panForX(centerX - halfWidth * 3, centerX, halfWidth)).toBe(-1);
  });

  it('is linear in between: halfway to the edge is 0.5', () => {
    expect(panForX(centerX + halfWidth / 2, centerX, halfWidth)).toBeCloseTo(0.5, 9);
  });
});

describe('motorGains', () => {
  const vmax = 3;

  it('is fully silent when stopped and the trigger is released (both conditions)', () => {
    expect(motorGains(0, 0, vmax)).toEqual({ tone: 0, buzz: 0, hiss: 0 });
  });

  it('stays fully silent anywhere inside the joint silence region (v<0.01 AND throttle<deadband)', () => {
    expect(motorGains(0.01, 0.009, vmax)).toEqual({ tone: 0, buzz: 0, hiss: 0 });
  });

  it('is NOT silent once throttle clears the deadband, even at v=0 (slipping brushes under load)', () => {
    const gains = motorGains(0.5, 0, vmax);
    expect(gains.buzz).toBeGreaterThan(0);
  });

  it('is NOT silent once v clears the moving threshold, even at throttle=0 (coasting)', () => {
    const gains = motorGains(0, 1, vmax);
    expect(gains.tone).toBeGreaterThan(0);
    expect(gains.hiss).toBeGreaterThan(0);
  });

  it('tone has (at least) a 0.15 floor the instant the car is moving', () => {
    expect(motorGains(0, 0.01, vmax).tone).toBeGreaterThanOrEqual(0.15);
  });

  it('tone rises monotonically with v at fixed throttle', () => {
    const throttle = 0.6;
    const samples = [0, 0.005, 0.01, 0.5, 1, 2, 3, 5].map((v) => motorGains(throttle, v, vmax).tone);
    for (let i = 1; i < samples.length; i++) {
      expect(samples[i]).toBeGreaterThanOrEqual(samples[i - 1]!);
    }
    expect(samples[samples.length - 1]).toBeLessThanOrEqual(1);
  });

  it('hiss rises monotonically with v (proportional), independent of throttle', () => {
    const samples = [0, 0.5, 1, 1.5, 2, 3, 4].map((v) => motorGains(0, v, vmax).hiss);
    for (let i = 1; i < samples.length; i++) {
      expect(samples[i]).toBeGreaterThanOrEqual(samples[i - 1]!);
    }
  });

  it('buzz rises monotonically with throttle at fixed v (under load)', () => {
    const v = 1;
    const samples = [0.02, 0.2, 0.4, 0.6, 0.8, 1].map((throttle) => motorGains(throttle, v, vmax).buzz);
    for (let i = 1; i < samples.length; i++) {
      expect(samples[i]).toBeGreaterThan(samples[i - 1]!);
    }
  });

  it('buzz falls monotonically as v approaches top speed at fixed high throttle (slip vanishes)', () => {
    const throttle = 0.9;
    const samples = [0, 0.5, 1, 1.5, 2, 2.5, 3, 4].map((v) => motorGains(throttle, v, vmax).buzz);
    for (let i = 1; i < samples.length; i++) {
      expect(samples[i]).toBeLessThanOrEqual(samples[i - 1]!);
    }
    expect(samples[samples.length - 1]).toBeCloseTo(0, 9); // at/beyond vmax, no more slip
  });

  it('all three gains stay within [0, 1] across a grid of v/throttle samples', () => {
    for (let vi = 0; vi <= 10; vi++) {
      for (let ti = 0; ti <= 10; ti++) {
        const v = vi * 0.5; // 0..5 (covers beyond vmax too)
        const throttle = ti / 10; // 0..1
        const gains = motorGains(throttle, v, vmax);
        for (const value of Object.values(gains)) {
          expect(value).toBeGreaterThanOrEqual(0);
          expect(value).toBeLessThanOrEqual(1);
        }
      }
    }
  });
});
