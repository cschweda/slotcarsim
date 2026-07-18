import {
  BufferGeometry,
  CanvasTexture,
  Float32BufferAttribute,
  Group,
  Mesh,
  MeshPhysicalMaterial,
  MeshStandardMaterial,
  RepeatWrapping,
  type Material,
  type Texture,
} from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { TUNING } from '../config/tuning';
import type { Vec2 } from '../sim/math';
import { wrapAngle } from '../sim/math';
import type { Track } from '../sim/track/builder';
import { PIECE_WIDTH } from '../sim/track/pieces';

// Extrudes an authentic AFX 2-lane track from a built Track: a near-black
// roadbed slab with recessed slots, raised steel rails, lock-and-joiner seams
// at every piece boundary, and white snap-on guardrails on the curve outsides.
//
// The whole thing is swept along the reconstructed piece CENTERLINE (the exact
// midpoint of the two lane paths — concentric arcs / parallel lines, so the
// midpoint is the true centerline) and merged BY MATERIAL so the entire static
// track renders in <=5 draw calls: roadbed, slots, rails, seams, guardrails.
//
// Sim (x, y) -> three (x, 0, -y); "up" is +y in three, matching debugView so
// the real mesh lands exactly under the car poses the sim drives.

// ---- Cross-section dimensions (meters) ----
// Exported (values unchanged) so tests can pin them to the design spec — see
// the "cross-section literal dimensions" block in trackMesh.test.ts.
export const HALF_WIDTH = PIECE_WIDTH / 2; // 0.0381
const ROAD_TOP = 0.006; // roadbed top surface, 6 mm above the table (y=0)
const CHAMFER = 0.002; // 45deg bevel on the two outer roadbed edges
export const LANE_OFFSET = TUNING.laneOffset; // 0.01905 — slot centers at +-this, matches the sim lanes
export const SLOT_HALF = 0.0015; // slot 3 mm wide
export const SLOT_DEPTH = 0.004; // slot depth -> floor at y = ROAD_TOP - SLOT_DEPTH = 0.002
const SLOT_FLOOR = ROAD_TOP - SLOT_DEPTH;
export const RAIL_GAUGE = 0.0055; // each rail center is +-this from its slot center
export const RAIL_HALF = 0.00075; // rail 1.5 mm wide
export const RAIL_PROUD = 0.0005; // rails stand this much proud of the roadbed
const RAIL_TOP = ROAD_TOP + RAIL_PROUD;

// ---- Crossing square (criss-cross) dimensions ----
const IN = 0.0254;
export const CROSS_HALF = 4.5 * IN; // half of the 9" square (0.1143 m)
export const RAIL_GAP_HALF = 0.00125; // rails gap +-1.25 mm (a ~2.5 mm break) where they cross a perpendicular slot
// Route-B rails ride a hair above route-A rails so their at-grade crossings
// don't z-fight (one route bridges over the other, as real crossings do).
const CROSS_RAIL_LIFT = 0.0001;

export const SEAM_HALF_LEN = 0.0004; // seam strip 0.8 mm along the path
const SEAM_PROUD = 0.0001; // 0.1 mm above the roadbed to avoid z-fighting

export const GUARD_HEIGHT = 0.008; // guardrail wall height above the roadbed
const GUARD_TOP = ROAD_TOP + GUARD_HEIGHT;
export const GUARD_THICK = 0.002; // 2 mm thick
const GUARD_CHAMFER = 0.0005; // small rounded-top bevel
export const MODULE_LEN = 0.03; // ~30 mm snap-on segments...
export const MODULE_GAP = 0.0015; // ...with ~1.5 mm gaps between them

const STRAIGHT_EPS = 1e-6; // |heading change| below this => a straight piece

// Colors.
const COLOR_ROAD = 0x1a1a1c;
const COLOR_SLOT = 0x0a0a0b;
const COLOR_RAIL = 0xb8b8bd;
const COLOR_SEAM = 0x050506;
const COLOR_GUARD = 0xefece2;

/** The maximum tessellation chord deviation the arc sampler is allowed, in meters. */
export const CHORD_TOL = 0.0002; // 0.2 mm

/**
 * Minimal number of equal segments an arc of `radius` spanning `sweepAbs`
 * radians must be split into so the chord deviation R·(1−cos(Δθ/2)) stays
 * under CHORD_TOL. Derived analytically (not hardcoded): the per-segment half
 * angle may be at most acos(1 − tol/R).
 */
export function arcSegmentCount(radius: number, sweepAbs: number): number {
  const sweep = Math.abs(sweepAbs);
  if (!(sweep > 0) || !(radius > 0)) return 1;
  const ratio = CHORD_TOL / radius;
  if (ratio >= 1) return 1;
  const maxHalfAngle = Math.acos(1 - ratio);
  return Math.max(1, Math.ceil(sweep / (2 * maxHalfAngle)));
}

/**
 * Segment count for tessellating a curve PIECE's swept profile, given the
 * piece's CENTERLINE radius and sweep. The roadbed/rail cross-section
 * extends to +-HALF_WIDTH from the centerline, and chord error scales with
 * radius, so the bound must hold at the widest radius actually swept
 * (centerline + HALF_WIDTH) — the centerline itself under-tessellates the
 * outer edge (e.g. curve9_90's outer edge would see ~0.228 mm of chord
 * error, over the 0.2 mm bound). This is the function createTrackMesh calls
 * to pick its per-piece segment count.
 */
export function curveGeometrySegments(centerlineRadius: number, sweepAbs: number): number {
  return arcSegmentCount(centerlineRadius + HALF_WIDTH, sweepAbs);
}

export interface GuardrailPieceLayout {
  /** The guardrail's own (outer) radius: centerline + HALF_WIDTH. */
  radius: number;
  /** Physical arc length of the guardrail's own path for this piece, in meters. */
  arcLength: number;
  /** Number of ~MODULE_LEN modules that fit this run, ~MODULE_GAP apart. */
  moduleCount: number;
  /** Physical length of the module run (modules + internal gaps), in meters. */
  runLength: number;
  /** Offset from the piece start to the run start, centering the run, in meters. */
  runStart: number;
  /** MODULE_LEN + MODULE_GAP, the per-module pitch, in meters. */
  period: number;
  /** Segment count for tessellating one module's own arc within the chord bound. */
  moduleSegments: number;
}

/**
 * Guardrail module/gap layout for one curve piece, given the piece's
 * CENTERLINE radius/sweep. Modules and gaps must be sized in physical meters
 * at the guardrail's OWN radius (centerline + HALF_WIDTH) — not the
 * centerline — since that's the radius the guardrail is actually swept
 * along. Sizing from the centerline inflates both by the radius ratio (e.g.
 * on curve9_90: ~35 mm modules / ~1.75 mm gaps instead of the intended
 * ~30 mm / ~1.5 mm).
 */
export function guardrailPieceLayout(centerlineRadius: number, sweepAbs: number): GuardrailPieceLayout {
  const radius = centerlineRadius + HALF_WIDTH;
  const arcLength = radius * sweepAbs;
  const period = MODULE_LEN + MODULE_GAP;
  const moduleCount = Math.max(1, Math.floor(arcLength / period));
  const runLength = moduleCount * MODULE_LEN + (moduleCount - 1) * MODULE_GAP;
  const runStart = (arcLength - runLength) / 2;
  const moduleSweep = sweepAbs * (MODULE_LEN / arcLength);
  const moduleSegments = Math.max(1, arcSegmentCount(radius, moduleSweep));
  return { radius, arcLength, moduleCount, runLength, runStart, period, moduleSegments };
}

type MaterialId = 'road' | 'slot' | 'rail' | 'guard';

interface ProfileEdge {
  a0: number; // across, height at the strip's start
  h0: number;
  a1: number; // across, height at the strip's end
  h1: number;
  mat: MaterialId;
}

interface Station {
  x: number; // sim-plane centerline position
  y: number;
  heading: number; // centerline tangent, radians (CCW+)
  u: number; // arc length along the path, for per-meter UV tiling
}

/**
 * The full roadbed cross-section, left outer edge to right outer edge, as an
 * ordered list of material-tagged strips. Traversed so that, when swept, each
 * strip's outward/up face wins the winding (see sweepRibbon). Slots dip to the
 * groove floor; rails step up proud of the surface; the two outer edges carry
 * the chamfer + side wall so the track reads as a solid slab, not a decal.
 */
function buildRoadbedProfile(): ProfileEdge[] {
  const edges: ProfileEdge[] = [];
  const push = (a0: number, h0: number, a1: number, h1: number, mat: MaterialId): void => {
    edges.push({ a0, h0, a1, h1, mat });
  };

  // Left outer wall (up from the table) + chamfer onto the top surface.
  push(-HALF_WIDTH, 0, -HALF_WIDTH, ROAD_TOP - CHAMFER, 'road');
  push(-HALF_WIDTH, ROAD_TOP - CHAMFER, -(HALF_WIDTH - CHAMFER), ROAD_TOP, 'road');

  let cursor = -(HALF_WIDTH - CHAMFER);
  // Lanes in ascending across order: lane 1 (−offset) then lane 0 (+offset).
  for (const center of [-LANE_OFFSET, LANE_OFFSET]) {
    const railLOuter = center - RAIL_GAUGE - RAIL_HALF;
    const railLInner = center - RAIL_GAUGE + RAIL_HALF;
    const slotL = center - SLOT_HALF;
    const slotR = center + SLOT_HALF;
    const railRInner = center + RAIL_GAUGE - RAIL_HALF;
    const railROuter = center + RAIL_GAUGE + RAIL_HALF;

    push(cursor, ROAD_TOP, railLOuter, ROAD_TOP, 'road'); // flat up to the left rail
    push(railLOuter, ROAD_TOP, railLOuter, RAIL_TOP, 'rail'); // left rail: up
    push(railLOuter, RAIL_TOP, railLInner, RAIL_TOP, 'rail'); //            top
    push(railLInner, RAIL_TOP, railLInner, ROAD_TOP, 'rail'); //            down
    push(railLInner, ROAD_TOP, slotL, ROAD_TOP, 'road'); // flat to the slot
    push(slotL, ROAD_TOP, slotL, SLOT_FLOOR, 'slot'); // slot: left wall down
    push(slotL, SLOT_FLOOR, slotR, SLOT_FLOOR, 'slot'); //       floor
    push(slotR, SLOT_FLOOR, slotR, ROAD_TOP, 'slot'); //        right wall up
    push(slotR, ROAD_TOP, railRInner, ROAD_TOP, 'road'); // flat to the right rail
    push(railRInner, ROAD_TOP, railRInner, RAIL_TOP, 'rail'); // right rail: up
    push(railRInner, RAIL_TOP, railROuter, RAIL_TOP, 'rail'); //             top
    push(railROuter, RAIL_TOP, railROuter, ROAD_TOP, 'rail'); //             down
    cursor = railROuter;
  }

  // Flat across the center-to-outer span, then chamfer + right outer wall.
  push(cursor, ROAD_TOP, HALF_WIDTH - CHAMFER, ROAD_TOP, 'road');
  push(HALF_WIDTH - CHAMFER, ROAD_TOP, HALF_WIDTH, ROAD_TOP - CHAMFER, 'road');
  push(HALF_WIDTH, ROAD_TOP - CHAMFER, HALF_WIDTH, 0, 'road');

  return edges;
}

/**
 * A single guardrail module cross-section for the −HALF_WIDTH (left-turn
 * outside) edge: outer wall up, rounded top, inner wall down. Mirrored across
 * for right turns (see createTrackMesh).
 */
function buildGuardrailProfile(): ProfileEdge[] {
  const outer = -HALF_WIDTH;
  const inner = -HALF_WIDTH + GUARD_THICK;
  return [
    { a0: outer, h0: ROAD_TOP, a1: outer, h1: GUARD_TOP - GUARD_CHAMFER, mat: 'guard' },
    {
      a0: outer,
      h0: GUARD_TOP - GUARD_CHAMFER,
      a1: outer + GUARD_CHAMFER,
      h1: GUARD_TOP,
      mat: 'guard',
    },
    { a0: outer + GUARD_CHAMFER, h0: GUARD_TOP, a1: inner - GUARD_CHAMFER, h1: GUARD_TOP, mat: 'guard' },
    {
      a0: inner - GUARD_CHAMFER,
      h0: GUARD_TOP,
      a1: inner,
      h1: GUARD_TOP - GUARD_CHAMFER,
      mat: 'guard',
    },
    { a0: inner, h0: GUARD_TOP - GUARD_CHAMFER, a1: inner, h1: ROAD_TOP, mat: 'guard' },
  ];
}

/** Map a cross-section point (across, height[, along tangent]) into three-space world coords. */
function worldPoint(st: Station, across: number, height: number, along = 0): [number, number, number] {
  const nx = -Math.sin(st.heading); // left-normal in the sim plane (= +across direction)
  const ny = Math.cos(st.heading);
  const tx = Math.cos(st.heading);
  const ty = Math.sin(st.heading);
  const sx = st.x + across * nx + along * tx;
  const sy = st.y + across * ny + along * ty;
  return [sx, height, -sy];
}

/**
 * Sweep one profile strip along the station list into an indexed ribbon
 * (position + uv). Winding is chosen so the un-flipped face normal is
 * cross(tangent, profileDir) — outward/up for a left-to-right, bottom-to-top
 * profile traverse. `flip` reverses it for the mirrored (right-turn) guardrail.
 */
function sweepRibbon(stations: Station[], edge: ProfileEdge, flip = false): BufferGeometry {
  const count = stations.length;
  const positions = new Float32Array(count * 2 * 3);
  const uvs = new Float32Array(count * 2 * 2);

  for (let k = 0; k < count; k++) {
    const st = stations[k]!;
    const a = worldPoint(st, edge.a0, edge.h0);
    const b = worldPoint(st, edge.a1, edge.h1);
    positions.set(a, k * 6);
    positions.set(b, k * 6 + 3);
    uvs[k * 4] = st.u;
    uvs[k * 4 + 1] = edge.a0;
    uvs[k * 4 + 2] = st.u;
    uvs[k * 4 + 3] = edge.a1;
  }

  const indices: number[] = [];
  for (let k = 0; k < count - 1; k++) {
    const i0 = k * 2;
    const i1 = k * 2 + 1;
    const i2 = (k + 1) * 2;
    const i3 = (k + 1) * 2 + 1;
    if (flip) {
      indices.push(i0, i3, i2, i0, i1, i3);
    } else {
      indices.push(i0, i2, i3, i0, i3, i1);
    }
  }

  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new Float32BufferAttribute(positions, 3));
  geometry.setAttribute('uv', new Float32BufferAttribute(uvs, 2));
  geometry.setIndex(indices);
  return geometry;
}

/** A dark cross-track quad at each piece joint, 0.1 mm proud of the roadbed. */
function buildSeams(boundaries: { x: number; y: number; heading: number }[]): BufferGeometry {
  const positions: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];
  const aMin = -(HALF_WIDTH - CHAMFER);
  const aMax = HALF_WIDTH - CHAMFER;
  const h = ROAD_TOP + SEAM_PROUD;

  boundaries.forEach((bnd) => {
    const st: Station = { x: bnd.x, y: bnd.y, heading: bnd.heading, u: 0 };
    const base = positions.length / 3;
    // Two "stations" offset along the tangent; across spans the roadbed width.
    positions.push(...worldPoint(st, aMin, h, -SEAM_HALF_LEN));
    positions.push(...worldPoint(st, aMax, h, -SEAM_HALF_LEN));
    positions.push(...worldPoint(st, aMin, h, SEAM_HALF_LEN));
    positions.push(...worldPoint(st, aMax, h, SEAM_HALF_LEN));
    uvs.push(0, 0, 1, 0, 0, 1, 1, 1);
    indices.push(base, base + 2, base + 3, base, base + 3, base + 1);
  });

  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new Float32BufferAttribute(positions, 3));
  geometry.setAttribute('uv', new Float32BufferAttribute(uvs, 2));
  geometry.setIndex(indices);
  return geometry;
}

/** Low-contrast procedural roughness variation so the plastic isn't dead-flat. Browser-only. */
function makeRoughnessTexture(): Texture | undefined {
  if (typeof document === 'undefined' || typeof document.createElement !== 'function') {
    return undefined;
  }
  const canvas = document.createElement('canvas');
  canvas.width = 256;
  canvas.height = 64;
  const ctx = canvas.getContext('2d');
  if (!ctx) return undefined;

  const image = ctx.createImageData(canvas.width, canvas.height);
  const data = image.data;
  for (let y = 0; y < canvas.height; y++) {
    for (let x = 0; x < canvas.width; x++) {
      // Base ~0.55 with gentle streaks biased along u (x) for an aged-plastic sheen.
      const streak = Math.sin(x * 0.19) * 6 + Math.sin(x * 0.037 + y * 0.11) * 5;
      const grain = (Math.random() - 0.5) * 14;
      const v = Math.max(0, Math.min(255, 140 + streak + grain));
      const i = (y * canvas.width + x) * 4;
      data[i] = v;
      data[i + 1] = v;
      data[i + 2] = v;
      data[i + 3] = 255;
    }
  }
  ctx.putImageData(image, 0, 0);

  const texture = new CanvasTexture(canvas);
  texture.wrapS = RepeatWrapping;
  texture.wrapT = RepeatWrapping;
  texture.repeat.set(8, 3);
  texture.needsUpdate = true;
  return texture;
}

function mergeAndFinalize(geometries: BufferGeometry[]): BufferGeometry | null {
  if (geometries.length === 0) return null;
  const merged = mergeGeometries(geometries, false);
  for (const geometry of geometries) geometry.dispose(); // free the intermediates
  if (!merged) return null;
  merged.computeVertexNormals();
  return merged;
}

// =====================================================================
// Crossing square (criss-cross)
// =====================================================================
// A hand-built 9"×9" roadbed square carrying BOTH perpendicular routes: a 3×3
// grid of roadbed cells around a #-shaped pair of slot routes, with each
// route's rails raised proud and BROKEN (~2.5 mm gaps) where they cross the
// perpendicular route's slots — the authentic detail that lets a guide pin run
// straight through. No guardrails. Geometry is emitted into the same
// road/slot/rail material buckets as the swept track, so the crossing costs no
// extra draw call. Built in a local frame (lx along route A, ly along route B)
// then mapped to world/three coords.

interface QuadSink {
  positions: number[];
  uvs: number[];
  indices: number[];
}

function newSink(): QuadSink {
  return { positions: [], uvs: [], indices: [] };
}

function sinkToGeometry(sink: QuadSink): BufferGeometry | null {
  if (sink.positions.length === 0) return null;
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new Float32BufferAttribute(sink.positions, 3));
  geometry.setAttribute('uv', new Float32BufferAttribute(sink.uvs, 2));
  geometry.setIndex(sink.indices);
  return geometry;
}

/** Local crossing coords (lx along route A, ly along route B, h up) → three-space. */
function crossingPoint(center: Vec2, heading: number, lx: number, ly: number, h: number): [number, number, number] {
  const c = Math.cos(heading);
  const s = Math.sin(heading);
  // ex = (c, s) along route A; ey = (−s, c) along route B (perpendicular).
  const sx = center.x + lx * c - ly * s;
  const sy = center.y + lx * s + ly * c;
  return [sx, h, -sy];
}

/** An axis-aligned (in the local frame) flat quad at height h; wound so its face points up (+y). */
function crossRect(
  sink: QuadSink,
  center: Vec2,
  heading: number,
  lxa: number,
  lxb: number,
  lya: number,
  lyb: number,
  h: number,
): void {
  const base = sink.positions.length / 3;
  const corners: Array<[number, number]> = [
    [lxa, lya],
    [lxb, lya],
    [lxb, lyb],
    [lxa, lyb],
  ];
  for (const [lx, ly] of corners) sink.positions.push(...crossingPoint(center, heading, lx, ly, h));
  sink.uvs.push(0, 0, 1, 0, 1, 1, 0, 1);
  sink.indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
}

/**
 * Split [min, max] into the segments left after cutting a ±gapHalf gap around
 * each center — used to break a rail where it crosses the perpendicular slots.
 */
function segmentsWithGaps(min: number, max: number, centers: number[], gapHalf: number): Array<[number, number]> {
  const cuts: number[] = [];
  for (const c of centers) {
    if (c - gapHalf > min && c - gapHalf < max) cuts.push(c - gapHalf);
    if (c + gapHalf > min && c + gapHalf < max) cuts.push(c + gapHalf);
  }
  cuts.sort((a, b) => a - b);
  const bounds = [min, ...cuts, max];
  const segments: Array<[number, number]> = [];
  for (let i = 0; i + 1 < bounds.length; i += 2) segments.push([bounds[i]!, bounds[i + 1]!]);
  return segments;
}

interface CrossingGeoms {
  road: BufferGeometry | null;
  slot: BufferGeometry | null;
  rail: BufferGeometry | null;
}

export function buildCrossingSquare(center: Vec2, heading: number): CrossingGeoms {
  const road = newSink();
  const slot = newSink();
  const rail = newSink();

  const H = CROSS_HALF;
  const off = LANE_OFFSET; // slot centers, ± on each route
  const sh = SLOT_HALF;
  const slotCenters = [-off, off];

  // --- Roadbed: a 3×3 grid of cells filling the square minus the slot lines. ---
  const xCells: Array<[number, number]> = [
    [-H, -off - sh],
    [-off + sh, off - sh],
    [off + sh, H],
  ];
  const yCells = xCells; // same partition on the perpendicular axis
  for (const [xa, xb] of xCells) {
    for (const [ya, yb] of yCells) crossRect(road, center, heading, xa, xb, ya, yb, ROAD_TOP);
  }

  // --- Slots: route A along lx at ly=±off (full), route B along ly at lx=±off
  //     (broken at the intersections so the two never double-cover). Flush dark
  //     fills tiling the grid gaps. ---
  for (const cy of slotCenters) crossRect(slot, center, heading, -H, H, cy - sh, cy + sh, ROAD_TOP);
  for (const cx of slotCenters) {
    for (const [ya, yb] of segmentsWithGaps(-H, H, slotCenters, sh)) {
      crossRect(slot, center, heading, cx - sh, cx + sh, ya, yb, ROAD_TOP);
    }
  }

  // --- Rails: two per slot (±RAIL_GAUGE), raised, broken where they cross the
  //     perpendicular route's slots. Route B rails ride a hair higher so their
  //     at-grade crossings with route A rails don't z-fight. ---
  for (const cy of slotCenters) {
    for (const railC of [cy - RAIL_GAUGE, cy + RAIL_GAUGE]) {
      for (const [xa, xb] of segmentsWithGaps(-H, H, slotCenters, RAIL_GAP_HALF)) {
        crossRect(rail, center, heading, xa, xb, railC - RAIL_HALF, railC + RAIL_HALF, RAIL_TOP);
      }
    }
  }
  for (const cx of slotCenters) {
    for (const railC of [cx - RAIL_GAUGE, cx + RAIL_GAUGE]) {
      for (const [ya, yb] of segmentsWithGaps(-H, H, slotCenters, RAIL_GAP_HALF)) {
        crossRect(rail, center, heading, railC - RAIL_HALF, railC + RAIL_HALF, ya, yb, RAIL_TOP + CROSS_RAIL_LIFT);
      }
    }
  }

  return { road: sinkToGeometry(road), slot: sinkToGeometry(slot), rail: sinkToGeometry(rail) };
}

/** Dedupe crossing pieces to unique physical squares by quantized world center (1 mm grid). */
export function uniqueCrossings(track: Track): Array<{ center: Vec2; heading: number }> {
  const seen = new Map<string, { center: Vec2; heading: number }>();
  for (const piece of track.pieces) {
    if (!piece.crossing) continue;
    const key = `${Math.round(piece.center.x * 1000)},${Math.round(piece.center.y * 1000)}`;
    if (!seen.has(key)) seen.set(key, { center: piece.center, heading: piece.heading });
  }
  return [...seen.values()];
}

export interface TrackMesh {
  group: Group;
  dispose(): void;
}

export function createTrackMesh(track: Track): TrackMesh {
  const [lane0, lane1] = track.lanes;
  const b0 = track.pieceBoundaries[0];
  const b1 = track.pieceBoundaries[1];
  const pieceCount = b0.length;

  // The roadbed profile is swept along RUNS of contiguous non-crossing pieces.
  // A crossing piece breaks the run (its shared square is built separately, so
  // the two perpendicular traversals aren't each swept as an ordinary strip
  // that would double-render and cross rails without gaps). A crossing-free
  // track (the oval) is one run that wraps closed exactly as before.
  const runs: Station[][] = [];
  let currentRun: Station[] = [];
  const boundaries: { x: number; y: number; heading: number }[] = [];
  const guardGeoms: BufferGeometry[] = [];

  const guardLeft = buildGuardrailProfile();
  const guardRight = guardLeft.map(
    (e): ProfileEdge => ({ a0: -e.a0, h0: e.h0, a1: -e.a1, h1: e.h1, mat: e.mat }),
  );

  let uAccum = 0;
  for (let i = 0; i < pieceCount; i++) {
    const s0Start = i === 0 ? 0 : b0[i - 1]!;
    const s0End = b0[i]!;
    const s1Start = i === 0 ? 0 : b1[i - 1]!;
    const s1End = b1[i]!;

    const hStart = lane0.pointAt(s0Start).heading;
    const hEnd = lane0.pointAt(s0End).heading;
    const sweep = wrapAngle(hEnd - hStart);
    const absSweep = Math.abs(sweep);
    const centerLen = (s0End - s0Start + (s1End - s1Start)) / 2;
    const isStraight = absSweep < STRAIGHT_EPS;
    const segments = isStraight ? 1 : curveGeometrySegments(centerLen / absSweep, absSweep);

    if (track.pieces[i]?.crossing) {
      // End the current run; the crossing square (built below) covers this span.
      if (currentRun.length > 0) {
        runs.push(currentRun);
        currentRun = [];
      }
      uAccum += centerLen;
      continue;
    }

    // Exact centerline sample at piece fraction t: midpoint of the two lanes.
    const sample = (t: number): Station => {
      const p0 = lane0.pointAt(s0Start + t * (s0End - s0Start));
      const p1 = lane1.pointAt(s1Start + t * (s1End - s1Start));
      return {
        x: (p0.pos.x + p1.pos.x) / 2,
        y: (p0.pos.y + p1.pos.y) / 2,
        heading: p0.heading,
        u: uAccum + t * centerLen,
      };
    };

    for (let j = 0; j <= segments; j++) {
      if (currentRun.length > 0 && j === 0) continue; // shared boundary with the previous piece in this run
      currentRun.push(sample(j / segments));
    }

    const end = sample(1);
    boundaries.push({ x: end.x, y: end.y, heading: end.heading });

    if (!isStraight) {
      // Guardrails ride the OUTSIDE edge: −offset for a left turn, +offset for a right.
      const flip = sweep < 0;
      const edges = sweep < 0 ? guardRight : guardLeft;
      const { arcLength: guardLen, moduleCount, runStart, period, moduleSegments } = guardrailPieceLayout(
        centerLen / absSweep,
        absSweep,
      );

      for (let m = 0; m < moduleCount; m++) {
        const sA = runStart + m * period;
        const modStations: Station[] = [];
        for (let j = 0; j <= moduleSegments; j++) {
          const along = (MODULE_LEN * j) / moduleSegments;
          modStations.push(sample((sA + along) / guardLen));
        }
        for (const edge of edges) guardGeoms.push(sweepRibbon(modStations, edge, flip));
      }
    }

    uAccum += centerLen;
  }
  if (currentRun.length > 0) runs.push(currentRun);

  // Sweep the roadbed profile along every run, bucketed by material.
  const roadGeoms: BufferGeometry[] = [];
  const slotGeoms: BufferGeometry[] = [];
  const railGeoms: BufferGeometry[] = [];
  for (const edge of buildRoadbedProfile()) {
    for (const run of runs) {
      if (run.length < 2) continue;
      const ribbon = sweepRibbon(run, edge);
      if (edge.mat === 'road') roadGeoms.push(ribbon);
      else if (edge.mat === 'slot') slotGeoms.push(ribbon);
      else railGeoms.push(ribbon);
    }
  }

  // The shared criss-cross squares (deduped by center) — merged into the same
  // road/slot/rail buckets, so they add no draw call.
  for (const { center, heading } of uniqueCrossings(track)) {
    const sq = buildCrossingSquare(center, heading);
    if (sq.road) roadGeoms.push(sq.road);
    if (sq.slot) slotGeoms.push(sq.slot);
    if (sq.rail) railGeoms.push(sq.rail);
  }

  const roadGeom = mergeAndFinalize(roadGeoms);
  const slotGeom = mergeAndFinalize(slotGeoms);
  const railGeom = mergeAndFinalize(railGeoms);
  const guardGeom = mergeAndFinalize(guardGeoms);
  const seamGeom = boundaries.length > 0 ? buildSeams(boundaries) : null;
  seamGeom?.computeVertexNormals();

  const roughnessMap = makeRoughnessTexture();
  const roadMat = new MeshPhysicalMaterial({
    color: COLOR_ROAD,
    roughness: roughnessMap ? 1.0 : 0.55, // roughnessMap centers effective roughness near 0.55
    metalness: 0,
    roughnessMap: roughnessMap ?? null,
  });
  const slotMat = new MeshPhysicalMaterial({ color: COLOR_SLOT, roughness: 0.7, metalness: 0 });
  const railMat = new MeshPhysicalMaterial({
    color: COLOR_RAIL,
    metalness: 1.0,
    roughness: 0.2,
    // Rails are the brightest thing on the track — bias their environment
    // reflection up so they read as bright streaks against the matte roadbed.
    envMapIntensity: 3.5,
  });
  const seamMat = new MeshStandardMaterial({ color: COLOR_SEAM, roughness: 0.85, metalness: 0 });
  const guardMat = new MeshPhysicalMaterial({
    color: COLOR_GUARD,
    roughness: 0.5,
    metalness: 0,
    clearcoat: 0.15,
    clearcoatRoughness: 0.35,
  });

  const group = new Group();
  group.name = 'trackMesh';
  const geometries: BufferGeometry[] = [];
  const materials: Material[] = [];
  const textures: Texture[] = [];
  if (roughnessMap) textures.push(roughnessMap);

  const addMesh = (
    name: string,
    geometry: BufferGeometry | null,
    material: Material,
    castShadow: boolean,
  ): void => {
    if (!geometry) {
      material.dispose();
      return;
    }
    const mesh = new Mesh(geometry, material);
    mesh.name = name;
    mesh.castShadow = castShadow;
    mesh.receiveShadow = true;
    group.add(mesh);
    geometries.push(geometry);
    materials.push(material);
  };

  addMesh('roadbed', roadGeom, roadMat, false);
  addMesh('slots', slotGeom, slotMat, false);
  addMesh('rails', railGeom, railMat, true);
  addMesh('seams', seamGeom, seamMat, false);
  addMesh('guardrails', guardGeom, guardMat, true);

  let disposed = false;
  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    for (const geometry of geometries) geometry.dispose();
    for (const material of materials) material.dispose();
    for (const texture of textures) texture.dispose();
  };

  return { group, dispose };
}
