import { describe, expect, it } from 'vitest';
import { TRACKS } from '../config/tracks';
import { wrapAngle } from '../sim/math';
import { buildTrack } from '../sim/track/builder';
import { WHEELBASE } from './carMesh';
import { slotOrientation, tumbleTheatrics } from './carsView';

const track = buildTrack(TRACKS.oval.refs);
const lane = track.lanes[0];

// The oval's first left corner spans pieceBoundaries[0][1]..[2] on lane 0
// (two straights, then the curve). Pick a fixed s mid-corner.
const CURVE_START = track.pieceBoundaries[0][1]!;
const CURVE_END = track.pieceBoundaries[0][2]!;
const S_MID = (CURVE_START + CURVE_END) / 2;

/**
 * Local +x tail point (a wheelbase behind the pin) in three-space, given the
 * pin position and group rotation.y. three's Y-rotation sends local (x,0,z) to
 * (x·cosθ + z·sinθ, ·, −x·sinθ + z·cosθ); the tail is local (−WHEELBASE,0,0).
 */
function tailWorld(pinX: number, pinZ: number, rotationY: number): { x: number; z: number } {
  const x = -WHEELBASE;
  return {
    x: pinX + x * Math.cos(rotationY),
    z: pinZ + -x * Math.sin(rotationY),
  };
}

describe('slotOrientation chord math', () => {
  it('the chosen sample s really is on a left (CCW) curve', () => {
    expect(lane.pointAt(S_MID).curvature).toBeGreaterThan(0);
  });

  it('body yaw ≈ path tangent but lags it (chord trails the tangent on a left curve)', () => {
    const tangent = lane.pointAt(S_MID).heading;
    const { chordYaw } = slotOrientation(lane, S_MID, 0);
    const lag = wrapAngle(tangent - chordYaw);
    // Close to the tangent…
    expect(Math.abs(lag)).toBeLessThan(0.2);
    // …but strictly lagging: on a CCW curve heading increases with s, so the
    // rear→pin chord points at a smaller angle than the tangent at the pin.
    expect(lag).toBeGreaterThan(0);
  });

  it('positive slideYaw swings the TAIL outward (away from the turn center) on a left turn', () => {
    // Turn center of lane 0's first curve, in three-space (x, −y).
    const seg = firstArcSegment();
    const centerX = seg.center.x;
    const centerZ = -seg.center.y;

    const straight = slotOrientation(lane, S_MID, 0);
    const slid = slotOrientation(lane, S_MID, 0.3);

    const tailStraight = tailWorld(straight.pinX, straight.pinZ, straight.rotationY);
    const tailSlid = tailWorld(slid.pinX, slid.pinZ, slid.rotationY);

    const dStraight = Math.hypot(tailStraight.x - centerX, tailStraight.z - centerZ);
    const dSlid = Math.hypot(tailSlid.x - centerX, tailSlid.z - centerZ);

    // Tail-out: the slid tail is farther from the turn center than the neutral tail.
    expect(dSlid).toBeGreaterThan(dStraight);
  });
});

describe('tumbleTheatrics', () => {
  it('starts flat on the ground and freezes flat while waiting', () => {
    const start = tumbleTheatrics(0, 'tumbling', 10);
    expect(start.height).toBeCloseTo(0, 6);
    expect(start.pitch).toBeCloseTo(0, 6);
    expect(start.roll).toBeCloseTo(0, 6);

    const waiting = tumbleTheatrics(0.5, 'waiting', 10);
    expect(waiting.height).toBe(0);
    expect(waiting.pitch).toBe(0);
    expect(waiting.roll).toBe(0);
  });

  it('hops off the ground mid-tumble and lands flat before waiting', () => {
    expect(tumbleTheatrics(0.25, 'tumbling', 10).height).toBeGreaterThan(0.02);
    // Airborne spin is present at mid-tumble…
    expect(Math.abs(tumbleTheatrics(0.25, 'tumbling', 10).pitch)).toBeGreaterThan(0.5);
    // …and has eased back to a flat landing by the end of the tumbling phase,
    // so nothing snaps when it freezes into 'waiting'.
    const landing = tumbleTheatrics(0.999, 'tumbling', 10);
    expect(landing.height).toBe(0);
    expect(landing.pitch).toBeCloseTo(0, 3);
    expect(landing.roll).toBeCloseTo(0, 3);
  });

  it('tumbles harder for a more violent (higher |yawRate|) seed', () => {
    const gentle = tumbleTheatrics(0.25, 'tumbling', 6);
    const violent = tumbleTheatrics(0.25, 'tumbling', 14);
    expect(Math.abs(violent.pitch)).toBeGreaterThan(Math.abs(gentle.pitch));
  });

  it('never returns a NaN', () => {
    for (let p = 0; p <= 1.0001; p += 0.05) {
      const t = tumbleTheatrics(p, 'tumbling', 9);
      expect(Number.isFinite(t.height)).toBe(true);
      expect(Number.isFinite(t.pitch)).toBe(true);
      expect(Number.isFinite(t.roll)).toBe(true);
    }
  });
});

/** The exact center of lane 0's first arc segment, for the turn-center check. */
function firstArcSegment(): { center: { x: number; y: number } } {
  // Reconstruct the same segment list buildTrack made for lane 0 by walking to
  // the first arc: two straights then the curve → segment index 2.
  // path.ts keeps segments private, so re-derive the center geometrically from
  // three sampled points on the curve (circumcenter).
  const a = lane.pointAt(CURVE_START + 0.001).pos;
  const b = lane.pointAt(S_MID).pos;
  const c = lane.pointAt(CURVE_END - 0.001).pos;
  return { center: circumcenter(a, b, c) };
}

function circumcenter(
  a: { x: number; y: number },
  b: { x: number; y: number },
  c: { x: number; y: number },
): { x: number; y: number } {
  const d = 2 * (a.x * (b.y - c.y) + b.x * (c.y - a.y) + c.x * (a.y - b.y));
  const ux =
    ((a.x * a.x + a.y * a.y) * (b.y - c.y) +
      (b.x * b.x + b.y * b.y) * (c.y - a.y) +
      (c.x * c.x + c.y * c.y) * (a.y - b.y)) /
    d;
  const uy =
    ((a.x * a.x + a.y * a.y) * (c.x - b.x) +
      (b.x * b.x + b.y * b.y) * (a.x - c.x) +
      (c.x * c.x + c.y * c.y) * (b.x - a.x)) /
    d;
  return { x: ux, y: uy };
}
