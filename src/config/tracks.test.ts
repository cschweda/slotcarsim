import { describe, expect, it } from 'vitest';
import { wrapAngle } from '../sim/math';
import { buildTrack } from '../sim/track/builder';
import { TRACKS } from './tracks';

describe('TRACKS', () => {
  for (const [key, track] of Object.entries(TRACKS)) {
    it(`${key} builds without throwing (closes to the default 1e-9 tolerance)`, () => {
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

describe('figure8 — the criss-cross', () => {
  const built = buildTrack(TRACKS.figure8.refs);
  const crossings = built.pieces.filter((p) => p.crossing);

  it('closes (built without throwing — default 1e-9 closure validation)', () => {
    // Re-assert explicitly: exact closure is the whole point of the 4.5"
    // connector geometry, not a relaxed tolerance.
    expect(() => buildTrack(TRACKS.figure8.refs)).not.toThrow();
  });

  it('traverses the crossing square exactly twice', () => {
    expect(crossings).toHaveLength(2);
    expect(built.pieces.filter((p) => p.piece === 'cross9')).toHaveLength(2);
  });

  it('the two crossing traversals share a world-space center within 1 mm', () => {
    const [a, b] = crossings;
    const dist = Math.hypot(a!.center.x - b!.center.x, a!.center.y - b!.center.y);
    expect(dist).toBeLessThan(0.001);
  });

  it('the two crossing traversals are perpendicular (headings differ by 90°)', () => {
    const [a, b] = crossings;
    const diff = Math.abs(wrapAngle(a!.heading - b!.heading));
    expect(diff).toBeCloseTo(Math.PI / 2, 6);
  });

  it('self-equalizes the lanes: |lane0 − lane1| < 0.02 m (each is inner on one lobe, outer on the other)', () => {
    const d = Math.abs(built.lanes[0].totalLength - built.lanes[1].totalLength);
    expect(d).toBeLessThan(0.02);
  });

  it('has a sane lap length (both lobes + the crossing traversals), ~3 m', () => {
    expect(built.lanes[0].totalLength).toBeGreaterThan(2.5);
    expect(built.lanes[0].totalLength).toBeLessThan(3.5);
  });
});
