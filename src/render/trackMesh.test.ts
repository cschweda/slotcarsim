import { BufferGeometry, Group, Mesh } from 'three';
import { describe, expect, it } from 'vitest';
import { TRACKS } from '../config/tracks';
import { buildTrack } from '../sim/track/builder';
import { CHORD_TOL, arcSegmentCount, createTrackMesh } from './trackMesh';

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
