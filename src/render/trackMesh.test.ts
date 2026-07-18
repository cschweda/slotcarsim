import { BufferGeometry, Group, Mesh } from 'three';
import { describe, expect, it } from 'vitest';
import { TRACKS } from '../config/tracks';
import { buildTrack } from '../sim/track/builder';
import { PIECES } from '../sim/track/pieces';
import type { PieceDef } from '../sim/track/pieces';
import {
  CHORD_TOL,
  GUARD_HEIGHT,
  GUARD_THICK,
  HALF_WIDTH,
  LANE_OFFSET,
  MODULE_GAP,
  MODULE_LEN,
  RAIL_GAUGE,
  RAIL_HALF,
  RAIL_PROUD,
  SEAM_HALF_LEN,
  SLOT_DEPTH,
  SLOT_HALF,
  arcSegmentCount,
  createTrackMesh,
  curveGeometrySegments,
  guardrailPieceLayout,
} from './trackMesh';

// The exact sagitta of one tessellated arc segment: for an arc of radius R
// split into n equal segments spanning `sweep` total radians, the max chord
// deviation is R·(1 − cos(sweep / 2n)). This is the bound createTrackMesh's
// segment count must keep under CHORD_TOL.
function chordError(radius: number, sweep: number, segments: number): number {
  return radius * (1 - Math.cos(sweep / (2 * segments)));
}

// Catalog radii in meters (6/9/12 inch), tightest first.
const IN = 0.0254;
const CATALOG_RADII = [6 * IN, 9 * IN, 12 * IN];
const CATALOG_SWEEPS = [Math.PI / 2, Math.PI / 4];

// The full catalog-curve set (centerline radius + sweep), pulled from the
// actual piece catalog (not re-derived) so this tracks the catalog itself.
const CATALOG_CURVES = Object.values(PIECES).filter(
  (p): p is Extract<PieceDef, { kind: 'curve' }> => p.kind === 'curve',
);

describe('arcSegmentCount', () => {
  it('keeps the chord error under 0.2 mm on the tightest catalog radius (6")', () => {
    const r = 6 * IN;
    const sweep = Math.PI / 2;
    const n = arcSegmentCount(r, sweep);
    expect(chordError(r, sweep, n)).toBeLessThan(CHORD_TOL);
  });

  it('returns the MINIMAL segment count satisfying the bound (n−1 would violate it)', () => {
    for (const r of CATALOG_RADII) {
      for (const sweep of CATALOG_SWEEPS) {
        const n = arcSegmentCount(r, sweep);
        expect(chordError(r, sweep, n)).toBeLessThan(CHORD_TOL);
        if (n > 1) {
          expect(chordError(r, sweep, n - 1)).toBeGreaterThanOrEqual(CHORD_TOL);
        }
      }
    }
  });

  it('holds the bound for every catalog radius/sweep combination', () => {
    for (const r of CATALOG_RADII) {
      for (const sweep of CATALOG_SWEEPS) {
        expect(chordError(r, sweep, arcSegmentCount(r, sweep))).toBeLessThan(CHORD_TOL);
      }
    }
  });

  it('never returns fewer than one segment for a degenerate/near-zero sweep', () => {
    expect(arcSegmentCount(0.2286, 1e-9)).toBeGreaterThanOrEqual(1);
    expect(arcSegmentCount(0.2286, 0)).toBeGreaterThanOrEqual(1);
  });
});

// The cross-section is swept out to +-HALF_WIDTH from the centerline, so the
// chord-tolerance bound must hold at the widest radius actually reached
// (centerline + HALF_WIDTH) -- not the centerline arcSegmentCount is handed.
// curveGeometrySegments is the function createTrackMesh actually calls to
// pick its per-piece segment count, so this exercises the real decision.
describe('curveGeometrySegments (tessellation at the swept OUTER radius)', () => {
  it('keeps the chord error under 0.2 mm at the outer radius (centerline + HALF_WIDTH) for every catalog curve', () => {
    for (const { radius, sweep } of CATALOG_CURVES) {
      const outerRadius = radius + HALF_WIDTH;
      const segments = curveGeometrySegments(radius, sweep);
      expect(chordError(outerRadius, sweep, segments)).toBeLessThan(CHORD_TOL);
    }
  });
});

// Guardrail modules/gaps must be physically ~MODULE_LEN / ~MODULE_GAP on the
// guardrail's OWN radius (centerline + HALF_WIDTH), since that's the radius
// the guardrail is actually swept along -- not the (smaller) centerline,
// which inflates both by the radius ratio (e.g. curve9_90 would render ~35mm
// modules / ~1.75mm gaps instead of the intended ~30mm / ~1.5mm). Expected
// counts below are computed from the guardrail radius: floor(((R +
// HALF_WIDTH) * sweep) / (MODULE_LEN + MODULE_GAP)).
describe('guardrailPieceLayout (module/gap sizing on the guardrail radius, not the centerline)', () => {
  const expected: Array<{ id: keyof typeof PIECES; moduleCount: number }> = [
    { id: 'curve6_90', moduleCount: 9 },
    { id: 'curve9_90', moduleCount: 13 },
    { id: 'curve12_90', moduleCount: 17 },
    { id: 'curve6_45', moduleCount: 4 },
    { id: 'curve9_45', moduleCount: 6 },
    { id: 'curve12_45', moduleCount: 8 },
  ];

  expected.forEach(({ id, moduleCount }) => {
    it(`${id}: layout radius is centerline + HALF_WIDTH and module count is ${moduleCount}`, () => {
      const piece = PIECES[id];
      if (piece.kind !== 'curve') throw new Error(`${id} is not a curve`);
      const layout = guardrailPieceLayout(piece.radius, piece.sweep);
      expect(layout.radius).toBeCloseTo(piece.radius + HALF_WIDTH, 15);
      expect(layout.moduleCount).toBe(moduleCount);
    });
  });
});

// Pins the cross-section literal dimensions to the AFX-derived design spec so
// a future edit can't silently drift them (e.g. while refactoring nearby
// code). Values are in meters; some constants store a half-dimension (the
// centerline-symmetric ones), so their design "full" value is asserted via
// *2 to match the spec as reviewed.
describe('cross-section literal dimensions (regression pin)', () => {
  it('pins every design constant to its spec value, in meters', () => {
    expect(HALF_WIDTH).toBeCloseTo(0.0381, 15); // half the 3in molded piece width
    expect(LANE_OFFSET).toBeCloseTo(0.01905, 15); // slot centers, +-, from centerline
    expect(SLOT_HALF).toBeCloseTo(0.0015, 15); // slot half-width (3 mm slot)
    expect(SLOT_DEPTH).toBeCloseTo(0.004, 15); // slot depth
    expect(RAIL_GAUGE).toBeCloseTo(0.0055, 15); // rail center offset, +-, from slot center
    expect(RAIL_HALF * 2).toBeCloseTo(0.0015, 15); // rail width (full)
    expect(RAIL_PROUD).toBeCloseTo(0.0005, 15); // rail height above the roadbed
    expect(SEAM_HALF_LEN * 2).toBeCloseTo(0.0008, 15); // seam width (full)
    expect(GUARD_HEIGHT).toBeCloseTo(0.008, 15); // guardrail wall height
    expect(GUARD_THICK).toBeCloseTo(0.002, 15); // guardrail wall thickness
    expect(MODULE_LEN).toBeCloseTo(0.03, 15); // guardrail snap-on module length
    expect(MODULE_GAP).toBeCloseTo(0.0015, 15); // guardrail inter-module gap
  });
});

describe('createTrackMesh (oval)', () => {
  const track = buildTrack(TRACKS.oval.refs);

  it('returns a Group whose static geometry is at most 5 meshes (draw-call budget)', () => {
    const { group, dispose } = createTrackMesh(track);
    try {
      expect(group).toBeInstanceOf(Group);
      const meshes = group.children.filter((c): c is Mesh => (c as Mesh).isMesh);
      expect(meshes.length).toBe(group.children.length); // nothing but meshes
      expect(meshes.length).toBeLessThanOrEqual(5);
      // The oval has straights, curves, joints -> all five material groups present.
      expect(meshes.length).toBe(5);
    } finally {
      dispose();
    }
  });

  it('uses exactly one material per mesh (one draw call each)', () => {
    const { group, dispose } = createTrackMesh(track);
    try {
      for (const child of group.children) {
        const mesh = child as Mesh;
        expect(Array.isArray(mesh.material)).toBe(false);
      }
    } finally {
      dispose();
    }
  });

  it('produces only non-empty geometry with finite (no-NaN) positions', () => {
    const { group, dispose } = createTrackMesh(track);
    try {
      for (const child of group.children) {
        const geometry = (child as Mesh).geometry as BufferGeometry;
        const position = geometry.getAttribute('position');
        expect(position).toBeDefined();
        expect(position.count).toBeGreaterThan(0);
        const array = position.array;
        for (let i = 0; i < array.length; i++) {
          expect(Number.isFinite(array[i])).toBe(true);
        }
      }
    } finally {
      dispose();
    }
  });

  it('carries UVs and normals on every static mesh', () => {
    const { group, dispose } = createTrackMesh(track);
    try {
      for (const child of group.children) {
        const geometry = (child as Mesh).geometry as BufferGeometry;
        expect(geometry.getAttribute('uv')).toBeDefined();
        expect(geometry.getAttribute('normal')).toBeDefined();
      }
    } finally {
      dispose();
    }
  });

  it('marks rails and guardrails as shadow casters and everything as a shadow receiver', () => {
    const { group, dispose } = createTrackMesh(track);
    try {
      const byName = new Map(group.children.map((c) => [c.name, c as Mesh]));
      expect(byName.get('rails')?.castShadow).toBe(true);
      expect(byName.get('guardrails')?.castShadow).toBe(true);
      for (const child of group.children) {
        expect((child as Mesh).receiveShadow).toBe(true);
      }
    } finally {
      dispose();
    }
  });

  it('disposes without throwing and is idempotent', () => {
    const { dispose } = createTrackMesh(track);
    expect(() => dispose()).not.toThrow();
    expect(() => dispose()).not.toThrow();
  });
});
