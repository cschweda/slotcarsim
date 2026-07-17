import { describe, expect, it } from 'vitest';
import { TUNING } from '../../config/tuning';
import { buildTrack } from './builder';
import type { PieceRef } from './pieces';

const IN = 0.0254;
const d = TUNING.laneOffset;

describe('buildTrack — closure', () => {
  it('4×curve9_90 left closes into a circle', () => {
    const refs: PieceRef[] = Array.from({ length: 4 }, () => ({
      piece: 'curve9_90',
      dir: 'left',
    }));

    expect(() => buildTrack(refs)).not.toThrow();
  });

  it('4×curve9_90 right closes into a circle', () => {
    const refs: PieceRef[] = Array.from({ length: 4 }, () => ({
      piece: 'curve9_90',
      dir: 'right',
    }));

    expect(() => buildTrack(refs)).not.toThrow();
  });

  it('the classic oval (2 straights + 2×90° left curves, twice) closes', () => {
    const refs: PieceRef[] = [
      { piece: 'straight15' },
      { piece: 'straight15' },
      { piece: 'curve9_90', dir: 'left' },
      { piece: 'curve9_90', dir: 'left' },
      { piece: 'straight15' },
      { piece: 'straight15' },
      { piece: 'curve9_90', dir: 'left' },
      { piece: 'curve9_90', dir: 'left' },
    ];

    expect(() => buildTrack(refs)).not.toThrow();
  });

  it('throws a helpful message naming the gap and piece count when a piece is missing', () => {
    const refs: PieceRef[] = [
      { piece: 'straight15' },
      { piece: 'straight15' },
      { piece: 'curve9_90', dir: 'left' },
      // Second curve9_90 of the first corner omitted — closes neither
      // position nor heading (7 pieces instead of the oval's 8).
      { piece: 'straight15' },
      { piece: 'straight15' },
      { piece: 'curve9_90', dir: 'left' },
      { piece: 'curve9_90', dir: 'left' },
    ];

    expect(() => buildTrack(refs)).toThrow(
      /^Track does not close: gap [\d.]+ m, heading error [\d.]+ rad after 7 pieces$/,
    );
  });

  it('a straight-only list never returns to the start, so it throws', () => {
    const refs: PieceRef[] = [{ piece: 'straight15' }, { piece: 'straight9' }];

    expect(() => buildTrack(refs)).toThrow(/Track does not close/);
  });
});

describe('buildTrack — lane geometry', () => {
  it('pins the inner lane on a left turn to lane 0 (shorter total length)', () => {
    const refs: PieceRef[] = Array.from({ length: 4 }, () => ({
      piece: 'curve9_90',
      dir: 'left',
    }));
    const track = buildTrack(refs);
    const R = 9 * IN;

    expect(track.lanes[0].totalLength).toBeLessThan(track.lanes[1].totalLength);
    expect(track.lanes[0].totalLength).toBeCloseTo(2 * Math.PI * (R - d), 9);
    expect(track.lanes[1].totalLength).toBeCloseTo(2 * Math.PI * (R + d), 9);
  });

  it('mirrors on a right turn: lane 1 becomes the inner (shorter) lane', () => {
    const refs: PieceRef[] = Array.from({ length: 4 }, () => ({
      piece: 'curve9_90',
      dir: 'right',
    }));
    const track = buildTrack(refs);
    const R = 9 * IN;

    expect(track.lanes[1].totalLength).toBeLessThan(track.lanes[0].totalLength);
    expect(track.lanes[1].totalLength).toBeCloseTo(2 * Math.PI * (R - d), 9);
    expect(track.lanes[0].totalLength).toBeCloseTo(2 * Math.PI * (R + d), 9);
  });

  it('records per-lane cumulative piece-boundary lengths', () => {
    const refs: PieceRef[] = Array.from({ length: 4 }, () => ({
      piece: 'curve9_90',
      dir: 'left',
    }));
    const track = buildTrack(refs);

    expect(track.pieceBoundaries[0]).toHaveLength(4);
    expect(track.pieceBoundaries[1]).toHaveLength(4);
    // Cumulative, strictly increasing, last entry equal to totalLength.
    expect(track.pieceBoundaries[0].at(-1)).toBeCloseTo(track.lanes[0].totalLength, 9);
    expect(track.pieceBoundaries[0]).toEqual([...track.pieceBoundaries[0]].sort((a, b) => a - b));
  });
});

describe('buildTrack — dir validation', () => {
  it('throws when a curve piece is missing dir', () => {
    const refs: PieceRef[] = [{ piece: 'curve9_90' }];
    expect(() => buildTrack(refs)).toThrow(/dir/);
  });

  it('throws when a straight piece specifies dir', () => {
    const refs: PieceRef[] = [{ piece: 'straight15', dir: 'left' }];
    expect(() => buildTrack(refs)).toThrow(/dir/);
  });
});
