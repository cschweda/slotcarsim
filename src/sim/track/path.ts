// Arc-length parametrized lane path: an ordered list of exact line/arc
// segments, looked up by binary search over precomputed cumulative lengths.
// No polylines/tessellation — s → {pos, heading, curvature} is exact.
import type { Vec2 } from '../math';

export type Segment =
  | { type: 'line'; p0: Vec2; p1: Vec2; length: number }
  // sweep is signed: positive = CCW (left), negative = CW (right).
  | { type: 'arc'; center: Vec2; radius: number; a0: number; sweep: number; length: number };

export interface PathPoint {
  pos: Vec2;
  /** Tangent direction, radians, CCW positive. Not wrapped to (−π, π]. */
  heading: number;
  /** Signed curvature: +1/r turning left, −1/r turning right, 0 on a line. */
  curvature: number;
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
    };
  }

  const sign = Math.sign(segment.sweep);
  const angle = segment.a0 + segment.sweep * (sLocal / segment.length);
  return {
    pos: {
      x: segment.center.x + segment.radius * Math.cos(angle),
      y: segment.center.y + segment.radius * Math.sin(angle),
    },
    heading: angle + (Math.PI / 2) * sign,
    curvature: sign / segment.radius,
  };
}
