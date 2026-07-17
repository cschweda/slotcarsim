import { describe, expect, it } from 'vitest';
import { createRng } from './rng';

describe('createRng', () => {
  it('same seed produces identical first 5 values', () => {
    const a = createRng(42);
    const b = createRng(42);
    const seqA = Array.from({ length: 5 }, () => a.next());
    const seqB = Array.from({ length: 5 }, () => b.next());
    expect(seqA).toEqual(seqB);
  });

  it('different seeds produce different first 5 values', () => {
    const a = createRng(1);
    const b = createRng(2);
    const seqA = Array.from({ length: 5 }, () => a.next());
    const seqB = Array.from({ length: 5 }, () => b.next());
    expect(seqA).not.toEqual(seqB);
  });

  it('next() values are always in [0, 1)', () => {
    const rng = createRng(12345);
    for (let i = 0; i < 2000; i++) {
      const v = rng.next();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });

  it('default seed 1 is deterministic across instances', () => {
    const a = createRng(1);
    const b = createRng(1);
    expect(a.next()).toBe(b.next());
  });

  describe('range(lo, hi)', () => {
    it('values always fall in [lo, hi)', () => {
      const rng = createRng(7);
      for (let i = 0; i < 2000; i++) {
        const v = rng.range(0.2, 0.5);
        expect(v).toBeGreaterThanOrEqual(0.2);
        expect(v).toBeLessThan(0.5);
      }
    });

    it('same seed produces identical range() sequence', () => {
      const a = createRng(99);
      const b = createRng(99);
      const seqA = Array.from({ length: 5 }, () => a.range(6, 14));
      const seqB = Array.from({ length: 5 }, () => b.range(6, 14));
      expect(seqA).toEqual(seqB);
    });

    it('consumes the same underlying stream as next() (interleaving is order-dependent)', () => {
      const a = createRng(5);
      const b = createRng(5);
      const viaNext = a.next();
      const viaRange = (b.range(0, 1) - 0) / (1 - 0);
      expect(viaRange).toBeCloseTo(viaNext, 12);
    });
  });
});
