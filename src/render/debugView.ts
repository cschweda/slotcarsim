import {
  BoxGeometry,
  BufferGeometry,
  Float32BufferAttribute,
  LineBasicMaterial,
  LineLoop,
  Mesh,
  MeshBasicMaterial,
  Scene,
  SphereGeometry,
} from 'three';
import type { Track } from '../sim/track/builder';

// Flat, unlit debug rendering of a Track: one ribbon + joint markers per
// lane, plus a small flat box per car the caller poses per-frame via
// setCarPoses. Deliberately not photoreal — this is a geometry-correctness
// view, replaced by the real extruded track mesh (M4) and real car art (M5).

const RIBBON_HEIGHT = 0.001; // 1mm above the ground plane
const MARKER_HEIGHT = 0.001;
const SAMPLE_SPACING = 0.005; // ~5mm of arc length per ribbon vertex
const MARKER_RADIUS = 0.004;

// Car box: a crude plan-view footprint, just big enough for slideYaw/tumble
// yaw to read visually (M3's whole point — M5 replaces this with real art).
// Built with its 30mm (long) dimension along local +X and 12mm (short) along
// local +Z, so `mesh.rotation.y = yaw` (see setCarPoses) lines the long axis
// up with the sim heading directly — no sign flip needed despite the plan
// (x, y) -> three.js (X, Z=-y) mirroring used for position below (verified
// against three.js's Matrix4.makeRotationY convention: X'=X·cosθ+Z·sinθ,
// Z'=−X·sinθ+Z·cosθ maps sim-heading θ's (cosθ,sinθ) forward vector, through
// the (x,-y) position mirror, onto a box whose local +X axis needed exactly
// rotation.y = θ to match — algebra, not a guess; also eyeballed live in
// Chrome per the M3 verification pass).
const BOX_LENGTH = 0.03; // 30mm, local X
const BOX_HEIGHT = 0.006; // 6mm, local Y (arbitrary — just needs to read as a box)
const BOX_WIDTH = 0.012; // 12mm, local Z
const BOX_GROUND_HEIGHT = 0.01; // on-track resting height, matches the old dot height
const BOX_ELEVATED_LIFT = 0.01; // +10mm while tumbling, per the brief

const LANE_COLORS = ['#00e5ff', '#ff9100'] as const; // lane 0 cyan, lane 1 orange
const MARKER_COLOR = '#888888';

/** One car's plan-view pose for the debug box. yaw is radians, CCW positive, matching sim heading. */
export interface CarPose {
  x: number;
  y: number;
  yaw: number;
  /** True while tumbling/waiting off-slot: lifts the box and signals it's not tracking the lane. */
  elevated?: boolean;
}

export interface DebugView {
  /** poses[i] is car i's box pose, in sim (x, y, yaw) plan-view coordinates. */
  setCarPoses(poses: CarPose[]): void;
  dispose(): void;
}

// Iterated as a literal-typed tuple index (not a generic `number`) so
// `track.lanes[laneIndex]` / `track.pieceBoundaries[laneIndex]` narrow to a
// definite element under noUncheckedIndexedAccess, rather than `T | undefined`.
const LANE_INDICES = [0, 1] as const;

export function createDebugView(scene: Scene, track: Track): DebugView {
  const geometries: BufferGeometry[] = [];
  const materials: (LineBasicMaterial | MeshBasicMaterial)[] = [];
  const added: (Mesh | LineLoop)[] = [];

  for (const laneIndex of LANE_INDICES) {
    const lane = track.lanes[laneIndex];
    const geometry = buildRibbonGeometry(lane.totalLength, (s) => lane.pointAt(s).pos);
    const material = new LineBasicMaterial({ color: LANE_COLORS[laneIndex] });
    const ribbon = new LineLoop(geometry, material);
    scene.add(ribbon);
    added.push(ribbon);
    geometries.push(geometry);
    materials.push(material);
  }

  const markerGeometry = new SphereGeometry(MARKER_RADIUS, 8, 6);
  const markerMaterial = new MeshBasicMaterial({ color: MARKER_COLOR });
  geometries.push(markerGeometry);
  materials.push(markerMaterial);

  for (const laneIndex of LANE_INDICES) {
    const lane = track.lanes[laneIndex];
    for (const s of track.pieceBoundaries[laneIndex]) {
      const { pos } = lane.pointAt(s);
      const marker = new Mesh(markerGeometry, markerMaterial);
      marker.position.set(pos.x, MARKER_HEIGHT, -pos.y);
      scene.add(marker);
      added.push(marker);
    }
  }

  const boxGeometry = new BoxGeometry(BOX_LENGTH, BOX_HEIGHT, BOX_WIDTH);
  geometries.push(boxGeometry);
  const carBoxes = LANE_COLORS.map((color) => {
    const material = new MeshBasicMaterial({ color });
    materials.push(material);
    const box = new Mesh(boxGeometry, material);
    scene.add(box);
    added.push(box);
    return box;
  });

  function setCarPoses(poses: CarPose[]): void {
    poses.forEach((pose, i) => {
      const box = carBoxes[i];
      if (!box) return;
      const height = BOX_GROUND_HEIGHT + (pose.elevated ? BOX_ELEVATED_LIFT : 0);
      box.position.set(pose.x, height, -pose.y);
      box.rotation.y = pose.yaw;
    });
  }

  function dispose(): void {
    for (const object of added) {
      scene.remove(object);
    }
    for (const geometry of geometries) {
      geometry.dispose();
    }
    for (const material of materials) {
      material.dispose();
    }
  }

  return { setCarPoses, dispose };
}

/** Samples a closed lane every ~5mm of arc length into a LineLoop-ready geometry. */
function buildRibbonGeometry(
  totalLength: number,
  posAt: (s: number) => { x: number; y: number },
): BufferGeometry {
  const sampleCount = Math.max(3, Math.ceil(totalLength / SAMPLE_SPACING));
  const positions = new Float32Array(sampleCount * 3);

  for (let i = 0; i < sampleCount; i++) {
    const s = (totalLength * i) / sampleCount;
    const pos = posAt(s);
    positions[i * 3] = pos.x;
    positions[i * 3 + 1] = RIBBON_HEIGHT;
    positions[i * 3 + 2] = -pos.y;
  }

  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new Float32BufferAttribute(positions, 3));
  return geometry;
}
