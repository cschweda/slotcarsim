import { describe, expect, it } from 'vitest';
import { add, clamp, dist, len, lerp, rot, scale, sub, wrapAngle } from './math';

describe('wrapAngle', () => {
  it('leaves π unchanged (the upper bound is inclusive)', () => {
    expect(wrapAngle(Math.PI)).toBeCloseTo(Math.PI, 12);
  });

  it('wraps −π to π (the lower bound is exclusive)', () => {
    expect(wrapAngle(-Math.PI)).toBeCloseTo(Math.PI, 12);
  });

  it('wraps 3π to π', () => {
    expect(wrapAngle(3 * Math.PI)).toBeCloseTo(Math.PI, 12);
  });

  it('leaves an interior angle unchanged', () => {
    expect(wrapAngle(0.5)).toBeCloseTo(0.5, 12);
  });

  it('wraps a large negative multiple of 2π back into range', () => {
    expect(wrapAngle(-5 * Math.PI)).toBeCloseTo(Math.PI, 9);
  });
});

describe('rot', () => {
  it('rotates unit x by π/2 to ≈ unit y', () => {
    const result = rot({ x: 1, y: 0 }, Math.PI / 2);
    expect(result.x).toBeCloseTo(0, 9);
    expect(result.y).toBeCloseTo(1, 9);
  });

  it('rotating by 0 is the identity', () => {
    const result = rot({ x: 3, y: -2 }, 0);
    expect(result.x).toBeCloseTo(3, 12);
    expect(result.y).toBeCloseTo(-2, 12);
  });
});

describe('dist', () => {
  it('measures a 3-4-5 triangle', () => {
    expect(dist({ x: 0, y: 0 }, { x: 3, y: 4 })).toBeCloseTo(5, 12);
  });

  it('is zero for coincident points', () => {
    expect(dist({ x: 1, y: 1 }, { x: 1, y: 1 })).toBe(0);
  });
});

describe('vector arithmetic', () => {
  it('add/sub round-trip', () => {
    const a = { x: 1, y: 2 };
    const b = { x: 3, y: -1 };
    expect(sub(add(a, b), b)).toEqual(a);
  });

  it('scale multiplies both components', () => {
    expect(scale({ x: 2, y: -3 }, 2)).toEqual({ x: 4, y: -6 });
  });

  it('len is the vector magnitude', () => {
    expect(len({ x: 3, y: 4 })).toBeCloseTo(5, 12);
  });
});

describe('clamp', () => {
  it('bounds a value to [lo, hi]', () => {
    expect(clamp(5, 0, 1)).toBe(1);
    expect(clamp(-5, 0, 1)).toBe(0);
    expect(clamp(0.5, 0, 1)).toBe(0.5);
  });
});

describe('lerp', () => {
  it('interpolates linearly', () => {
    expect(lerp(0, 10, 0.5)).toBe(5);
    expect(lerp(0, 10, 0)).toBe(0);
    expect(lerp(0, 10, 1)).toBe(10);
  });
});
