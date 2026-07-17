// Chains PieceRefs into a closed 2-lane Track: walks the centerline pose
// piece by piece, derives each lane's exact line/arc segment per piece
// (offsetting by the lane's signed perpendicular distance from centerline),
// and validates the walk returns to its start pose.
import { TUNING } from '../../config/tuning';
import type { Vec2 } from '../math';
import { add, dist, rot, sub, wrapAngle } from '../math';
import { createLanePath } from './path';
import type { LanePath, Segment } from './path';
import { PIECES } from './pieces';
import type { PieceRef } from './pieces';

export interface Track {
  lanes: [LanePath, LanePath];
  /** pieceBoundaries[lane] = cumulative s at each piece joint, for that lane. */
  pieceBoundaries: [number[], number[]];
}

export interface BuildTrackOptions {
  /** Position-closure tolerance, in meters. Heading closure is always 1e-9 rad. */
  closureTol?: number;
}

const DEFAULT_CLOSURE_TOL = 1e-9;
const HEADING_CLOSURE_TOL = 1e-9;
const LANES = [0, 1] as const;

interface Pose {
  pos: Vec2;
  heading: number;
}

/** Two lanes, offset o = +d (lane 0) and o = −d (lane 1) from centerline. */
const LANE_OFFSETS: [number, number] = [TUNING.laneOffset, -TUNING.laneOffset];

/** Mutable per-lane accumulators threaded through the piece walk. */
interface BuildState {
  laneSegments: [Segment[], Segment[]];
  laneCumulative: [number, number];
  pieceBoundaries: [number[], number[]];
}

export function buildTrack(refs: readonly PieceRef[], opts: BuildTrackOptions = {}): Track {
  const closureTol = opts.closureTol ?? DEFAULT_CLOSURE_TOL;

  const state: BuildState = {
    laneSegments: [[], []],
    laneCumulative: [0, 0],
    pieceBoundaries: [[], []],
  };

  const startPose: Pose = { pos: { x: 0, y: 0 }, heading: 0 };
  let pose: Pose = startPose;

  for (const ref of refs) {
    const def = PIECES[ref.piece];

    if (def.kind === 'straight') {
      if (ref.dir !== undefined) {
        throw new Error(`Piece ${ref.piece} is a straight; dir must not be specified`);
      }
      pose = appendStraight(def.length, pose, state);
    } else {
      if (ref.dir === undefined) {
        throw new Error(`Piece ${ref.piece} is a curve; dir ('left'|'right') is required`);
      }
      pose = appendCurve(def.radius, def.sweep, ref.dir, pose, state);
    }
  }

  const gap = dist(pose.pos, startPose.pos);
  const headingError = Math.abs(wrapAngle(pose.heading - startPose.heading));
  if (gap >= closureTol || headingError >= HEADING_CLOSURE_TOL) {
    throw new Error(
      `Track does not close: gap ${gap.toFixed(3)} m, heading error ${headingError.toFixed(3)} rad after ${refs.length} pieces`,
    );
  }

  return {
    lanes: [createLanePath(state.laneSegments[0]), createLanePath(state.laneSegments[1])],
    pieceBoundaries: state.pieceBoundaries,
  };
}

function appendStraight(length: number, entry: Pose, state: BuildState): Pose {
  const exitPos = add(entry.pos, rot({ x: length, y: 0 }, entry.heading));
  const exit: Pose = { pos: exitPos, heading: entry.heading };

  for (const lane of LANES) {
    const o = LANE_OFFSETS[lane];
    const segment: Segment = {
      type: 'line',
      p0: add(entry.pos, rot({ x: 0, y: o }, entry.heading)),
      p1: add(exit.pos, rot({ x: 0, y: o }, exit.heading)),
      length,
    };
    pushSegment(state, lane, segment, length);
  }

  return exit;
}

function appendCurve(
  radius: number,
  sweep: number,
  dir: 'left' | 'right',
  entry: Pose,
  state: BuildState,
): Pose {
  // Left: center is to the left of travel, at +R along local +y. Right:
  // center is to the right, at −R along local +y. Rotating the entry point
  // around that center by the signed sweep gives the exit pose.
  const centerOffset = dir === 'left' ? radius : -radius;
  const center = add(entry.pos, rot({ x: 0, y: centerOffset }, entry.heading));
  const signedSweep = dir === 'left' ? sweep : -sweep;

  const rel = sub(entry.pos, center);
  const a0 = Math.atan2(rel.y, rel.x);
  const exitPos = add(center, rot(rel, signedSweep));
  const exit: Pose = { pos: exitPos, heading: entry.heading + signedSweep };

  for (const lane of LANES) {
    const o = LANE_OFFSETS[lane];
    // Left turn: offsetting toward +o (left of travel) moves toward the
    // center, shrinking the radius. Right turn: the center is on the other
    // side, so the same +o offset moves away from it, growing the radius.
    const laneRadius = dir === 'left' ? radius - o : radius + o;
    const length = laneRadius * Math.abs(signedSweep);
    const segment: Segment = {
      type: 'arc',
      center,
      radius: laneRadius,
      a0,
      sweep: signedSweep,
      length,
    };
    pushSegment(state, lane, segment, length);
  }

  return exit;
}

function pushSegment(state: BuildState, lane: 0 | 1, segment: Segment, length: number): void {
  state.laneSegments[lane].push(segment);
  state.laneCumulative[lane] += length;
  state.pieceBoundaries[lane].push(state.laneCumulative[lane]);
}
