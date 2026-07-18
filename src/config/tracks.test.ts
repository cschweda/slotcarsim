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

describe('daytonaSweep — banked speedway with an elevated back stretch', () => {
  const built = buildTrack(TRACKS.daytonaSweep.refs);

  it('closes in x/y/heading AND elevation (net-zero rise around the loop)', () => {
    expect(() => buildTrack(TRACKS.daytonaSweep.refs)).not.toThrow();
  });

  it('is a longer, faster-feeling lap in the 3.5–4.5 m range', () => {
    expect(built.lanes[0].totalLength).toBeGreaterThan(3.5);
    expect(built.lanes[0].totalLength).toBeLessThan(4.5);
  });

  it('keeps the inner-lane advantage (both ends turn the same way, like the oval)', () => {
    expect(built.lanes[0].totalLength).toBeLessThan(built.lanes[1].totalLength);
    // Both ends left: one net full turn, so the analytic 4π·d lane-length gap.
    const diff = built.lanes[1].totalLength - built.lanes[0].totalLength;
    expect(diff).toBeCloseTo(4 * Math.PI * 0.01905, 6);
  });

  it('both 180° ends are banked 30° (0.5236 rad) into the turn', () => {
    // Sample every 10 mm; the banked samples should all read +0.5236 and the
    // flat samples 0. At least a meaningful fraction is banked (the two ends).
    const lane = built.lanes[0];
    let bankedSamples = 0;
    let maxBank = 0;
    for (let s = 0; s < lane.totalLength; s += 0.01) {
      const b = lane.pointAt(s).bank ?? 0;
      if (b !== 0) {
        bankedSamples += 1;
        expect(b).toBeCloseTo(0.5236, 9); // constant per piece, into the turn
        maxBank = Math.max(maxBank, b);
      }
    }
    expect(maxBank).toBeCloseTo(0.5236, 9);
    expect(bankedSamples).toBeGreaterThan(20); // the two banked ends are a real span
  });

  it('has an elevated back stretch that rises above the table and returns to it', () => {
    const lane = built.lanes[0];
    let maxZ = 0;
    let sawUphill = false;
    let sawDownhill = false;
    for (let s = 0; s < lane.totalLength; s += 0.01) {
      const p = lane.pointAt(s);
      maxZ = Math.max(maxZ, p.z ?? 0);
      if ((p.grade ?? 0) > 0) sawUphill = true;
      if ((p.grade ?? 0) < 0) sawDownhill = true;
    }
    expect(maxZ).toBeCloseTo(0.019, 3); // the plateau sits ~19 mm up (one riser)
    expect(sawUphill).toBe(true);
    expect(sawDownhill).toBe(true);
    // Start/finish is at table level (loop closed in z).
    expect(lane.pointAt(0).z ?? 0).toBe(0);
  });
});
