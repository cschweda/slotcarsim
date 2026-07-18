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
import type { PieceId, PieceRef } from './pieces';

/**
 * Per-piece centerline pose, in walk order — a documented builder addition so
 * callers can reason about pieces in world space without re-deriving the walk.
 * `center`/`heading` are the piece's CENTERLINE midpoint and tangent there
 * (the exact center of a curve's arc, not the entry/exit chord midpoint). The
 * figure-8 crossing test uses this to prove the two cross9 traversals share a
 * center; the renderer uses it to dedupe the crossing square.
 */
export interface PieceInfo {
  piece: PieceId;
  kind: 'straight' | 'curve';
  crossing: boolean;
  center: Vec2;
  heading: number;
}

export interface Track {
  lanes: [LanePath, LanePath];
  /** pieceBoundaries[lane] = cumulative s at each piece joint, for that lane. */
  pieceBoundaries: [number[], number[]];
  /** Per-piece centerline pose (center + heading + crossing flag), in walk order. */
  pieces: PieceInfo[];
}

export interface BuildTrackOptions {
  /** Position-closure tolerance, in meters. Heading closure is always 1e-9 rad. */
  closureTol?: number;
}

const DEFAULT_CLOSURE_TOL = 1e-9;
const HEADING_CLOSURE_TOL = 1e-9;
const Z_CLOSURE_TOL = 1e-9;
const LANES = [0, 1] as const;

interface Pose {
  pos: Vec2;
  heading: number;
  /** M12: centerline elevation above the table, meters. Accumulated across risers. */
  z: number;
}

/** Two lanes, offset o = +d (lane 0) and o = −d (lane 1) from centerline. */
const LANE_OFFSETS: [number, number] = [TUNING.laneOffset, -TUNING.laneOffset];

/** Mutable per-lane accumulators threaded through the piece walk. */
interface BuildState {
  laneSegments: [Segment[], Segment[]];
  laneCumulative: [number, number];
  pieceBoundaries: [number[], number[]];
  pieces: PieceInfo[];
}

export function buildTrack(refs: readonly PieceRef[], opts: BuildTrackOptions = {}): Track {
  const closureTol = opts.closureTol ?? DEFAULT_CLOSURE_TOL;

  const state: BuildState = {
    laneSegments: [[], []],
    laneCumulative: [0, 0],
    pieceBoundaries: [[], []],
    pieces: [],
  };

  const startPose: Pose = { pos: { x: 0, y: 0 }, heading: 0, z: 0 };
  let pose: Pose = startPose;

  for (const ref of refs) {
    const def = PIECES[ref.piece];
    const rise = ref.rise ?? 0;

    if (def.kind === 'straight') {
      if (ref.dir !== undefined) {
        throw new Error(`Piece ${ref.piece} is a straight; dir must not be specified`);
      }
      if (ref.bank !== undefined) {
        throw new Error(`Piece ${ref.piece} is a straight; bank must not be specified`);
      }
      const entry = pose;
      pose = appendStraight(def.length, rise, pose, state);
      state.pieces.push({
        piece: ref.piece,
        kind: 'straight',
        crossing: def.crossing === true,
        center: midpoint(entry.pos, pose.pos),
        heading: entry.heading,
      });
    } else {
      if (ref.dir === undefined) {
        throw new Error(`Piece ${ref.piece} is a curve; dir ('left'|'right') is required`);
      }
      const entry = pose;
      // bank magnitude, applied INTO the turn (positive per path.ts's sign
      // convention — the renderer combines it with the κ sign to roll the
      // correct way; the physics uses it directly).
      pose = appendCurve(def.radius, def.sweep, ref.dir, ref.bank ?? 0, rise, pose, state);
      // Centerline arc midpoint: rotate the entry point about the arc center by
      // half the signed sweep. dir/radius/sweep recompute the same center the
      // append used (kept local to avoid threading it back out).
      const signedSweep = ref.dir === 'left' ? def.sweep : -def.sweep;
      const centerOffset = ref.dir === 'left' ? def.radius : -def.radius;
      const arcCenter = add(entry.pos, rot({ x: 0, y: centerOffset }, entry.heading));
      const mid = add(arcCenter, rot(sub(entry.pos, arcCenter), signedSweep / 2));
      state.pieces.push({
        piece: ref.piece,
        kind: 'curve',
        crossing: false,
        center: mid,
        heading: entry.heading + signedSweep / 2,
      });
    }
  }

  const gap = dist(pose.pos, startPose.pos);
  const headingError = Math.abs(wrapAngle(pose.heading - startPose.heading));
  if (gap >= closureTol || headingError >= HEADING_CLOSURE_TOL) {
    throw new Error(
      `Track does not close: gap ${gap.toFixed(3)} m, heading error ${headingError.toFixed(3)} rad after ${refs.length} pieces`,
    );
  }
  // M12: elevation must also return to the start height (net rise 0 around the
  // loop). Kept a SEPARATE check after the position/heading one so the pinned
  // position/heading message above is untouched — a flat track (every rise 0)
  // never reaches here with a nonzero z gap.
  const zGap = Math.abs(pose.z - startPose.z);
  if (zGap >= Z_CLOSURE_TOL) {
    throw new Error(
      `Track does not close in elevation: z gap ${zGap.toFixed(4)} m after ${refs.length} pieces`,
    );
  }

  return {
    lanes: [createLanePath(state.laneSegments[0]), createLanePath(state.laneSegments[1])],
    pieceBoundaries: state.pieceBoundaries,
    pieces: state.pieces,
  };
}

function midpoint(a: Vec2, b: Vec2): Vec2 {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}

function appendStraight(length: number, rise: number, entry: Pose, state: BuildState): Pose {
  const exitPos = add(entry.pos, rot({ x: length, y: 0 }, entry.heading));
  const exitZ = entry.z + rise;
  const exit: Pose = { pos: exitPos, heading: entry.heading, z: exitZ };

  for (const lane of LANES) {
    const o = LANE_OFFSETS[lane];
    const segment: Segment = {
      type: 'line',
      p0: add(entry.pos, rot({ x: 0, y: o }, entry.heading)),
      p1: add(exit.pos, rot({ x: 0, y: o }, exit.heading)),
      length,
      // Both lanes ride the same centerline elevation ramp (the piece is a
      // rigid tilted plank; banking, if any, is a separate cross-section roll).
      // Omit the fields entirely on a flat piece so pointAt returns exactly the
      // pre-M12 z 0 / grade 0 (and the segment stays byte-identical).
      ...(rise !== 0 ? { z0: entry.z, z1: exitZ } : {}),
    };
    pushSegment(state, lane, segment, length);
  }

  return exit;
}

function appendCurve(
  radius: number,
  sweep: number,
  dir: 'left' | 'right',
  bank: number,
  rise: number,
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
  const exitZ = entry.z + rise;
  const exit: Pose = { pos: exitPos, heading: entry.heading + signedSweep, z: exitZ };

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
      // Positive bank = banked into the turn (both lanes carry the same bank);
      // omit on unbanked/flat curves so pointAt returns the exact pre-M12 zeros.
      ...(bank !== 0 ? { bank } : {}),
      ...(rise !== 0 ? { z0: entry.z, z1: exitZ } : {}),
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
