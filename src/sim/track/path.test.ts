import { describe, expect, it } from 'vitest';
import { dist, wrapAngle } from '../math';
import { buildTrack } from './builder';
import { createLanePath } from './path';
import type { Segment } from './path';
import type { PieceRef } from './pieces';

const OVAL_REFS: PieceRef[] = [
  { piece: 'straight15' },
  { piece: 'straight15' },
  { piece: 'curve9_90', dir: 'left' },
  { piece: 'curve9_90', dir: 'left' },
  { piece: 'straight15' },
  { piece: 'straight15' },
  { piece: 'curve9_90', dir: 'left' },
  { piece: 'curve9_90', dir: 'left' },
];

// 9 in, matches the curve9_90 catalog radius — chosen so this fixture reads
// as "a real track radius", not an arbitrary number.
const R = 0.2286;

function buildFullCircle() {
  const quarterLength = R * (Math.PI / 2);
  const segments: Segment[] = [0, 1, 2, 3].map((k) => ({
    type: 'arc' as const,
    center: { x: 0, y: 0 },
    radius: R,
    a0: k * (Math.PI / 2),
    sweep: Math.PI / 2,
    length: quarterLength,
  }));
  return createLanePath(segments);
}

describe('createLanePath — single full circle (4×90° arcs)', () => {
  const circle = buildFullCircle();
  const totalLength = 2 * Math.PI * R;

  it('has the expected circumference', () => {
    expect(circle.totalLength).toBeCloseTo(totalLength, 12);
  });

  it('matches the closed-form circle parametrization at 20 sampled s values', () => {
    for (let i = 0; i < 20; i++) {
      const s = (i * totalLength) / 20;
      const theta = s / R;
      const expectedPos = { x: R * Math.cos(theta), y: R * Math.sin(theta) };
      const expectedHeading = theta + Math.PI / 2;

      const { pos, heading, curvature } = circle.pointAt(s);

      expect(pos.x).toBeCloseTo(expectedPos.x, 12);
      expect(pos.y).toBeCloseTo(expectedPos.y, 12);
      // Compare headings mod 2π — raw heading is an unwrapped tangent angle.
      expect(wrapAngle(heading - expectedHeading)).toBeCloseTo(0, 9);
      expect(curvature).toBeCloseTo(1 / R, 12);
    }
  });
});

describe('createLanePath — single line segment', () => {
  // A non-axis-aligned 3-4-5 line so the heading check exercises atan2, not
  // just the degenerate axis-aligned case.
  const segments: Segment[] = [
    { type: 'line', p0: { x: 1, y: 1 }, p1: { x: 4, y: 5 }, length: 5 },
  ];
  const path = createLanePath(segments);

  it('lerps position, holds heading, and has zero curvature', () => {
    const { pos, heading, curvature } = path.pointAt(2.5);
    expect(pos.x).toBeCloseTo(2.5, 12);
    expect(pos.y).toBeCloseTo(3.0, 12);
    expect(heading).toBeCloseTo(Math.atan2(4, 3), 12);
    expect(curvature).toBe(0);
  });
});

describe('createLanePath — wrap', () => {
  const circle = buildFullCircle();
  const totalLength = circle.totalLength;

  it('pointAt(totalLength + 0.1) equals pointAt(0.1)', () => {
    const a = circle.pointAt(totalLength + 0.1);
    const b = circle.pointAt(0.1);
    expect(a.pos.x).toBeCloseTo(b.pos.x, 12);
    expect(a.pos.y).toBeCloseTo(b.pos.y, 12);
    expect(wrapAngle(a.heading - b.heading)).toBeCloseTo(0, 12);
    expect(a.curvature).toBeCloseTo(b.curvature, 12);
  });

  it('pointAt(−0.1) equals pointAt(totalLength − 0.1)', () => {
    const a = circle.pointAt(-0.1);
    const b = circle.pointAt(totalLength - 0.1);
    expect(a.pos.x).toBeCloseTo(b.pos.x, 12);
    expect(a.pos.y).toBeCloseTo(b.pos.y, 12);
    expect(wrapAngle(a.heading - b.heading)).toBeCloseTo(0, 12);
    expect(a.curvature).toBeCloseTo(b.curvature, 12);
  });
});

describe('createLanePath — M12 elevation & banking fields', () => {
  it('a flat, unbanked segment (no optional fields) reports bank/z/grade all 0', () => {
    const path = createLanePath([{ type: 'line', p0: { x: 0, y: 0 }, p1: { x: 1, y: 0 }, length: 1 }]);
    const p = path.pointAt(0.5);
    expect(p.bank).toBe(0);
    expect(p.z).toBe(0);
    expect(p.grade).toBe(0);
  });

  it('a rising line ramps z linearly and reports the exact constant grade', () => {
    const path = createLanePath([
      { type: 'line', p0: { x: 0, y: 0 }, p1: { x: 2, y: 0 }, length: 2, z0: 0, z1: 0.1 },
    ]);
    expect(path.pointAt(0).z).toBeCloseTo(0, 12);
    expect(path.pointAt(1).z).toBeCloseTo(0.05, 12); // halfway → half the rise
    expect(path.pointAt(2 - 1e-9).z).toBeCloseTo(0.1, 9); // near the top (s=2 itself wraps to 0)
    // grade = dz/ds = 0.1 / 2, constant everywhere on the piece.
    for (const s of [0, 0.5, 1, 1.9]) expect(path.pointAt(s).grade).toBeCloseTo(0.05, 12);
  });

  it('a downhill line has a negative grade', () => {
    const path = createLanePath([
      { type: 'line', p0: { x: 0, y: 0 }, p1: { x: 1, y: 0 }, length: 1, z0: 0.1, z1: 0 },
    ]);
    expect(path.pointAt(0.5).grade).toBeCloseTo(-0.1, 12);
    expect(path.pointAt(0.5).z).toBeCloseTo(0.05, 12);
  });

  it('a banked arc reports its constant bank (and preserves pos/heading/curvature)', () => {
    const R = 0.2;
    const path = createLanePath([
      { type: 'arc', center: { x: 0, y: 0 }, radius: R, a0: 0, sweep: Math.PI / 2, length: R * (Math.PI / 2), bank: 0.5236 },
    ]);
    const p = path.pointAt(R * (Math.PI / 4)); // mid-arc
    expect(p.bank).toBeCloseTo(0.5236, 12);
    expect(p.curvature).toBeCloseTo(1 / R, 12);
    expect(p.z).toBe(0); // banked but not elevated
    expect(p.grade).toBe(0);
  });
});

describe('createLanePath — oval (via builder)', () => {
  const track = buildTrack(OVAL_REFS);

  it('lane 0 (inner) is shorter than lane 1 (outer)', () => {
    expect(track.lanes[0].totalLength).toBeLessThan(track.lanes[1].totalLength);
  });

  it('the lane length difference matches the analytic 4π·d for one net full turn', () => {
    // Per full 360° of turning, inner/outer radii differ by 2d, so arc
    // length differs by 2π·2d = 4π·d — independent of how many straights
    // separate the corners. 0.01905 m = TUNING.laneOffset, pinned literally
    // per the spec so this test also catches an accidental tuning edit.
    const diff = track.lanes[1].totalLength - track.lanes[0].totalLength;
    expect(diff).toBeCloseTo(4 * Math.PI * 0.01905, 9);
  });

  it('is C0/C1 continuous at every piece boundary (curvature may still step)', () => {
    const EPS = 1e-7;
    track.lanes.forEach((lane, laneIndex) => {
      for (const sStar of track.pieceBoundaries[laneIndex]!) {
        const before = lane.pointAt(sStar - EPS);
        const after = lane.pointAt(sStar + EPS);
        expect(dist(before.pos, after.pos)).toBeLessThan(1e-5);
        expect(Math.abs(wrapAngle(after.heading - before.heading))).toBeLessThan(1e-5);
      }
    });
  });

  it('pointAt(totalLength) equals pointAt(0) with pos, heading, curvature continuous', () => {
    const lane = track.lanes[0];
    const a = lane.pointAt(lane.totalLength);
    const b = lane.pointAt(0);
    expect(a.pos.x).toBeCloseTo(b.pos.x, 12);
    expect(a.pos.y).toBeCloseTo(b.pos.y, 12);
    expect(wrapAngle(a.heading - b.heading)).toBeCloseTo(0, 12);
    expect(a.curvature).toBeCloseTo(b.curvature, 12);
  });

  it('pointAt at interior piece boundary s* is continuous with s* + 1e-9', () => {
    track.lanes.forEach((lane, laneIndex) => {
      const boundaries = track.pieceBoundaries[laneIndex]!;
      // Test one interior boundary (not the last, which wraps)
      if (boundaries.length > 0) {
        const sStar = boundaries[0]!;
        const a = lane.pointAt(sStar);
        const b = lane.pointAt(sStar + 1e-9);
        expect(a.pos.x).toBeCloseTo(b.pos.x, 8);
        expect(a.pos.y).toBeCloseTo(b.pos.y, 8);
        expect(wrapAngle(a.heading - b.heading)).toBeCloseTo(0, 8);
        expect(a.curvature).toBeCloseTo(b.curvature, 8);
      }
    });
  });
});
