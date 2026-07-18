// Arc-length parametrized lane path: an ordered list of exact line/arc
// segments, looked up by binary search over precomputed cumulative lengths.
// No polylines/tessellation — s → {pos, heading, curvature} is exact.
import type { Vec2 } from '../math';

// M12 elevation/banking, all OPTIONAL so pre-M12 flat segments (and the
// literal Segment fixtures in path.test.ts) keep compiling and behaving
// identically: absent ⇒ bank 0, z 0, grade 0.
//   bank — signed roll of the surface (rad), constant over the piece.
//   z0/z1 — this lane's centerline elevation (m) at the segment's entry/exit;
//           z ramps linearly between them, so grade = (z1−z0)/length is constant.
interface Elevation {
  bank?: number;
  z0?: number;
  z1?: number;
}

export type Segment =
  | ({ type: 'line'; p0: Vec2; p1: Vec2; length: number } & Elevation)
  // sweep is signed: positive = CCW (left), negative = CW (right).
  | ({ type: 'arc'; center: Vec2; radius: number; a0: number; sweep: number; length: number } & Elevation);

export interface PathPoint {
  pos: Vec2;
  /** Tangent direction, radians, CCW positive. Not wrapped to (−π, π]. */
  heading: number;
  /** Signed curvature: +1/r turning left, −1/r turning right, 0 on a line. */
  curvature: number;
  // M12 elevation/banking. OPTIONAL on the interface (so a minimal hand-rolled
  // LanePath mock — e.g. game/coach.test.ts — stays valid and a missing field
  // reads as flat/unbanked via `?? 0`), but ALWAYS populated by the real
  // createLanePath below, so production paths never actually observe undefined.
  /** M12: signed surface bank, radians. Positive = surface tilts toward the turn center for the current κ sign. 0 on straights/unbanked. */
  bank?: number;
  /** M12: centerline elevation above the table, meters. 0 on flat pieces. */
  z?: number;
  /** M12: longitudinal grade dz/ds (exact from the piece's linear ramp). 0 on flat pieces. */
  grade?: number;
}

export interface LanePath {
  readonly totalLength: number;
  /**
   * Sample the path at arc length s. s may be any real number — it wraps
   * modulo totalLength, so negative values and values beyond totalLength are
   * well-defined (pointAt(s) === pointAt(s + totalLength)).
   */
  pointAt(s: number): PathPoint;
}

export function createLanePath(segments: Segment[]): LanePath {
  if (segments.length === 0) {
    throw new Error('createLanePath requires at least one segment');
  }

  const cumulative: number[] = [];
  let total = 0;
  for (const segment of segments) {
    total += segment.length;
    cumulative.push(total);
  }
  const totalLength = total;

  function pointAt(s: number): PathPoint {
    const wrapped = ((s % totalLength) + totalLength) % totalLength;
    const index = findSegmentIndex(cumulative, wrapped);
    const segment = segments[index]!;
    const segStart = index === 0 ? 0 : cumulative[index - 1]!;
    return evaluateSegment(segment, wrapped - segStart);
  }

  return { totalLength, pointAt };
}

/** Smallest index i such that wrapped < cumulative[i]. Assumes 0 <= wrapped < cumulative[last]. */
function findSegmentIndex(cumulative: number[], wrapped: number): number {
  let lo = 0;
  let hi = cumulative.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (cumulative[mid]! <= wrapped) {
      lo = mid + 1;
    } else {
      hi = mid;
    }
  }
  return lo;
}

/** Linear elevation fields (bank/z/grade) for a segment at local fraction t = sLocal/length. */
function elevationAt(segment: Segment, t: number): { bank: number; z: number; grade: number } {
  const z0 = segment.z0 ?? 0;
  const z1 = segment.z1 ?? 0;
  return {
    bank: segment.bank ?? 0,
    z: z0 + (z1 - z0) * t,
    grade: segment.length > 0 ? (z1 - z0) / segment.length : 0,
  };
}

function evaluateSegment(segment: Segment, sLocal: number): PathPoint {
  if (segment.type === 'line') {
    const t = sLocal / segment.length;
    return {
      pos: {
        x: segment.p0.x + (segment.p1.x - segment.p0.x) * t,
        y: segment.p0.y + (segment.p1.y - segment.p0.y) * t,
      },
      heading: Math.atan2(segment.p1.y - segment.p0.y, segment.p1.x - segment.p0.x),
      curvature: 0,
      ...elevationAt(segment, t),
    };
  }

  const sign = Math.sign(segment.sweep);
  const t = sLocal / segment.length;
  const angle = segment.a0 + segment.sweep * t;
  return {
    pos: {
      x: segment.center.x + segment.radius * Math.cos(angle),
      y: segment.center.y + segment.radius * Math.sin(angle),
    },
    heading: angle + (Math.PI / 2) * sign,
    curvature: sign / segment.radius,
    ...elevationAt(segment, t),
  };
}
