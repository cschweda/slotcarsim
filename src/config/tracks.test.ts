import { describe, expect, it } from 'vitest';
import { buildTrack } from '../sim/track/builder';
import { TRACKS } from './tracks';

describe('TRACKS', () => {
  for (const [key, track] of Object.entries(TRACKS)) {
    it(`${key} builds without throwing`, () => {
      expect(() => buildTrack(track.refs)).not.toThrow();
    });
  }

  it('oval is the counterclockwise classic oval (lane 0 is the shorter, inner lane)', () => {
    const built = buildTrack(TRACKS.oval.refs);
    expect(built.lanes[0].totalLength).toBeLessThan(built.lanes[1].totalLength);
    // Centerline lap ≈ 2.96 m; inner lane (lane 0) ≈ 2.84 m, per the brief.
    expect(built.lanes[0].totalLength).toBeCloseTo(2.84, 2);
  });
});
