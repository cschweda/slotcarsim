import {
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
// lane, plus two dots the caller drives per-frame via setDotPositions.
// Deliberately not photoreal — this is a geometry-correctness view, replaced
// by the real extruded track mesh in M4.

const RIBBON_HEIGHT = 0.001; // 1mm above the ground plane
const MARKER_HEIGHT = 0.001;
const DOT_HEIGHT = 0.01;
const SAMPLE_SPACING = 0.005; // ~5mm of arc length per ribbon vertex
const DOT_RADIUS = 0.008;
const MARKER_RADIUS = 0.004;

const LANE_COLORS = ['#00e5ff', '#ff9100'] as const; // lane 0 cyan, lane 1 orange
const MARKER_COLOR = '#888888';

export interface DebugView {
  /** positions[i] is lane i's dot, in sim (x, y) plan-view coordinates. */
  setDotPositions(positions: { x: number; y: number }[]): void;
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

  const dotGeometry = new SphereGeometry(DOT_RADIUS, 16, 12);
  geometries.push(dotGeometry);
  const dots = LANE_COLORS.map((color) => {
    const material = new MeshBasicMaterial({ color });
    materials.push(material);
    const dot = new Mesh(dotGeometry, material);
    scene.add(dot);
    added.push(dot);
    return dot;
  });

  function setDotPositions(positions: { x: number; y: number }[]): void {
    positions.forEach((p, i) => {
      const dot = dots[i];
      if (dot) {
        dot.position.set(p.x, DOT_HEIGHT, -p.y);
      }
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

  return { setDotPositions, dispose };
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
