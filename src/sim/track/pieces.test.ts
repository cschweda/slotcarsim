import { describe, expect, it } from 'vitest';
import { PIECE_WIDTH, PIECES } from './pieces';

const IN = 0.0254;

describe('PIECES catalog', () => {
  it('has exactly these 10 keys and no extras', () => {
    const expectedKeys = [
      'straight15',
      'straight9',
      'straight6',
      'straight3',
      'curve6_90',
      'curve9_90',
      'curve12_90',
      'curve6_45',
      'curve9_45',
      'curve12_45',
    ];
    expect(Object.keys(PIECES).sort()).toEqual(expectedKeys.sort());
    expect(Object.keys(PIECES)).toHaveLength(10);
  });

  describe('straights', () => {
    const straights = [
      { id: 'straight15' as const, inches: 15 },
      { id: 'straight9' as const, inches: 9 },
      { id: 'straight6' as const, inches: 6 },
      { id: 'straight3' as const, inches: 3 },
    ];

    straights.forEach(({ id, inches }) => {
      it(`${id} has kind 'straight' and length ${inches} inches`, () => {
        const piece = PIECES[id];
        expect(piece.kind).toBe('straight');
        if (piece.kind === 'straight') {
          expect(piece.length).toBeCloseTo(inches * IN, 15);
        }
      });
    });
  });

  describe('90-degree curves', () => {
    const curves90 = [
      { id: 'curve6_90' as const, inches: 6 },
      { id: 'curve9_90' as const, inches: 9 },
      { id: 'curve12_90' as const, inches: 12 },
    ];

    curves90.forEach(({ id, inches }) => {
      it(`${id} has kind 'curve', radius ${inches} inches, sweep π/2`, () => {
        const piece = PIECES[id];
        expect(piece.kind).toBe('curve');
        if (piece.kind === 'curve') {
          expect(piece.radius).toBeCloseTo(inches * IN, 15);
          expect(piece.sweep).toBeCloseTo(Math.PI / 2, 15);
        }
      });
    });
  });

  describe('45-degree curves', () => {
    const curves45 = [
      { id: 'curve6_45' as const, inches: 6 },
      { id: 'curve9_45' as const, inches: 9 },
      { id: 'curve12_45' as const, inches: 12 },
    ];

    curves45.forEach(({ id, inches }) => {
      it(`${id} has kind 'curve', radius ${inches} inches, sweep π/4`, () => {
        const piece = PIECES[id];
        expect(piece.kind).toBe('curve');
        if (piece.kind === 'curve') {
          expect(piece.radius).toBeCloseTo(inches * IN, 15);
          expect(piece.sweep).toBeCloseTo(Math.PI / 4, 15);
        }
      });
    });
  });

  it('PIECE_WIDTH is 3 inches', () => {
    expect(PIECE_WIDTH).toBeCloseTo(3 * IN, 15);
  });
});
