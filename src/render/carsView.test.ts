import { Euler, Scene, Vector3 } from 'three';
import { describe, expect, it } from 'vitest';
import { TRACKS } from '../config/tracks';
import { wrapAngle } from '../sim/math';
import { buildTrack } from '../sim/track/builder';
import { createLanePath } from '../sim/track/path';
import type { Track } from '../sim/track/builder';
import { WHEELBASE } from './carMesh';
import { createCarsView, slotElevation, slotOrientation, TUMBLE_FALL_END, tumbleFallZ, tumbleTheatrics, type CarRenderPose } from './carsView';

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

// =====================================================================
// M12 review follow-up: pose-math sign verification through the REAL
// rotation pipeline (an actual three.js Euler in the exact 'YXZ' order
// update() applies), derived from first principles about what the car
// should visually do — NOT by re-checking slotElevation's own formula
// against itself. See slotElevation's docblock in carsView.ts for the axis
// bug this caught (gradePitch/bankRoll were assigned to the wrong Euler
// slots, silently zeroing the climb pitch and misdirecting the bank tilt).
// =====================================================================

describe('slotElevation — grade pitch, verified by transforming the actual nose vector', () => {
  // A straight, non-axis-aligned stub lane (heading = atan2(8,6) ≈ 0.9273 rad
  // — deliberately not 0 or a right angle, so a yaw/pitch axis mix-up would
  // still show up) climbing/descending at grade ±0.4.
  function gradedStraightMidpoint(rise: number) {
    const lane = createLanePath([
      { type: 'line', p0: { x: 0, y: 0 }, p1: { x: 6, y: 8 }, length: 10, z0: 0, z1: rise },
    ]);
    return lane.pointAt(5); // midpoint; grade = rise/10 exactly; curvature 0 (straight, unbanked)
  }

  it('a climb (grade > 0) tips the nose UP: the transformed nose world-Y is positive', () => {
    const pt = gradedStraightMidpoint(4); // grade = +0.4
    expect(pt.grade).toBeCloseTo(0.4, 12);

    const { gradePitch, bankRoll } = slotElevation(pt, 0);
    const euler = new Euler(bankRoll, pt.heading, gradePitch, 'YXZ');
    const nose = new Vector3(1, 0, 0).applyEuler(euler);

    expect(nose.y).toBeGreaterThan(0);
  });

  it('a descent (grade < 0) tips the nose DOWN: the transformed nose world-Y is negative', () => {
    const pt = gradedStraightMidpoint(-4); // grade = -0.4
    expect(pt.grade).toBeCloseTo(-0.4, 12);

    const { gradePitch, bankRoll } = slotElevation(pt, 0);
    const euler = new Euler(bankRoll, pt.heading, gradePitch, 'YXZ');
    const nose = new Vector3(1, 0, 0).applyEuler(euler);

    expect(nose.y).toBeLessThan(0);
  });

  it('flat (grade 0) leaves the nose exactly horizontal', () => {
    const pt = gradedStraightMidpoint(0);
    const { gradePitch, bankRoll } = slotElevation(pt, 0);
    const euler = new Euler(bankRoll, pt.heading, gradePitch, 'YXZ');
    const nose = new Vector3(1, 0, 0).applyEuler(euler);
    expect(nose.y).toBeCloseTo(0, 12);
  });
});

describe('slotElevation — bank roll, verified by transforming the actual up vector toward the real turn center', () => {
  const R = 0.2;
  const THETA = 0.5236; // 30 degrees, the Daytona Sweep's banked-end angle

  /** A synthetic banked arc, center at the sim origin, entered at angle 0 (pos = (R, 0) sim either way). */
  function bankedArc(dir: 'left' | 'right') {
    const sweep = dir === 'left' ? Math.PI / 2 : -Math.PI / 2;
    const lane = createLanePath([
      { type: 'arc', center: { x: 0, y: 0 }, radius: R, a0: 0, sweep, length: R * (Math.PI / 2), bank: THETA },
    ]);
    return lane.pointAt(0);
  }

  /** Unit vector, in the world XZ plane, from a sim position toward a sim center (sim (x,y) -> three (x,-y)). */
  function towardCenterXZ(pos: { x: number; y: number }, center: { x: number; y: number }): { x: number; z: number } {
    const dx = center.x - pos.x;
    const dz = -(center.y - pos.y);
    const len = Math.hypot(dx, dz) || 1;
    return { x: dx / len, z: dz / len };
  }

  it('left turn (κ>0): the up-vector tilts toward the REAL turn center by exactly θ', () => {
    const pt = bankedArc('left');
    expect(pt.curvature).toBeGreaterThan(0); // confirms the stub really is a left turn

    const { gradePitch, bankRoll } = slotElevation(pt, 0);
    const euler = new Euler(bankRoll, pt.heading, gradePitch, 'YXZ');
    const up = new Vector3(0, 1, 0).applyEuler(euler);

    // Tilt magnitude: a pure rotation about an axis perpendicular to "up"
    // (which roll always is) sweeps it away from vertical by exactly the
    // rotation angle — so acos(up.y) recovers θ independent of any formula.
    const tiltAngle = Math.acos(Math.min(1, Math.max(-1, up.y)));
    expect(tiltAngle).toBeCloseTo(THETA, 9);

    // Tilt direction: the horizontal component must point at the
    // independently-computed geometric center (0,0) — not the mesh's
    // -sign(curvature)*bank formula echoed back.
    const dir = towardCenterXZ(pt.pos, { x: 0, y: 0 });
    const horizLen = Math.hypot(up.x, up.z) || 1;
    const dot = (up.x / horizLen) * dir.x + (up.z / horizLen) * dir.z;
    expect(dot).toBeCloseTo(1, 9); // same direction, not merely nonzero
  });

  it('right turn (κ<0): tilts toward the SAME physical center (sign(sweep)==sign(κ) stays consistent)', () => {
    const pt = bankedArc('right');
    expect(pt.curvature).toBeLessThan(0); // confirms the stub really is a right turn

    const { gradePitch, bankRoll } = slotElevation(pt, 0);
    const euler = new Euler(bankRoll, pt.heading, gradePitch, 'YXZ');
    const up = new Vector3(0, 1, 0).applyEuler(euler);

    const tiltAngle = Math.acos(Math.min(1, Math.max(-1, up.y)));
    expect(tiltAngle).toBeCloseTo(THETA, 9);

    const dir = towardCenterXZ(pt.pos, { x: 0, y: 0 });
    const horizLen = Math.hypot(up.x, up.z) || 1;
    const dot = (up.x / horizLen) * dir.x + (up.z / horizLen) * dir.z;
    expect(dot).toBeCloseTo(1, 9);
  });

  it('flat/unbanked (bank 0) leaves the up-vector exactly vertical', () => {
    const lane = createLanePath([
      { type: 'arc', center: { x: 0, y: 0 }, radius: R, a0: 0, sweep: Math.PI / 2, length: R * (Math.PI / 2) },
    ]);
    const pt = lane.pointAt(0);
    const { gradePitch, bankRoll } = slotElevation(pt, 0);
    const euler = new Euler(bankRoll, pt.heading, gradePitch, 'YXZ');
    const up = new Vector3(0, 1, 0).applyEuler(euler);
    expect(up.y).toBeCloseTo(1, 12);
    expect(Math.hypot(up.x, up.z)).toBeCloseTo(0, 12);
  });
});

describe('tumbleFallZ — elevated exit-height decay theatrics', () => {
  it('a positive exitZ decays linearly to 0 by TUMBLE_FALL_END and stays exactly 0 beyond it', () => {
    const exitZ = 0.019; // the Daytona Sweep's plateau height
    expect(tumbleFallZ(exitZ, 0)).toBeCloseTo(exitZ, 12);
    expect(tumbleFallZ(exitZ, TUMBLE_FALL_END / 2)).toBeCloseTo(exitZ / 2, 12);
    expect(tumbleFallZ(exitZ, TUMBLE_FALL_END)).toBe(0);
    expect(tumbleFallZ(exitZ, TUMBLE_FALL_END + 0.2)).toBe(0);
    expect(tumbleFallZ(exitZ, 1)).toBe(0);
  });

  it('is monotone non-increasing across the whole tumble', () => {
    const exitZ = 0.05;
    let prev = tumbleFallZ(exitZ, 0);
    for (let p = 0.01; p <= 1.0001; p += 0.01) {
      const cur = tumbleFallZ(exitZ, p);
      expect(cur).toBeLessThanOrEqual(prev + 1e-12);
      prev = cur;
    }
  });

  it('exitZ = 0 yields identically 0 at every progress — the pre-M12 flat-track behavior, unchanged', () => {
    for (let p = 0; p <= 1; p += 0.1) {
      expect(tumbleFallZ(0, p)).toBe(0);
    }
  });
});

// =====================================================================
// M13: the camera-rig accessors — the SHARED anchor + cockpit self-hiding
// =====================================================================

describe('carAnchor — the shared pose the camera rig reads', () => {
  it('returns the player group\'s own live position/quaternion after update(), and null for a missing car', () => {
    const scene = new Scene();
    const view = createCarsView(scene, track, ['p917']);
    const pose: CarRenderPose = { mode: 'slot', s: S_MID, slideYaw: 0.2, lane: 0, generation: 0 };
    view.update([pose]);

    const group = scene.children.find((o) => o.name === 'car-p917')!;
    const anchor = view.carAnchor(0);
    expect(anchor).not.toBeNull();
    // Same refs the group carries — no recomputation, no copy that could drift.
    expect(anchor!.position).toBe(group.position);
    expect(anchor!.quaternion).toBe(group.quaternion);

    expect(view.carAnchor(5)).toBeNull();
    view.dispose();
  });
});

describe('setBodyHidden — TRUE first-person cockpit hides the WHOLE player car', () => {
  it('hides the entire player group (nothing of their own car renders) and restores it fully — the AI car is never touched', () => {
    const scene = new Scene();
    const view = createCarsView(scene, track, ['p917', 'f512']);
    const player = scene.children.find((o) => o.name === 'car-p917')!;
    const ai = scene.children.find((o) => o.name === 'car-f512')!;

    // Cockpit: the whole player group goes invisible → three skips the entire
    // subtree (body, canopy, chassis, wheels, chrome, pin, cast shadow).
    view.setBodyHidden(0, true);
    expect(player.visible).toBe(false);
    expect(ai.visible).toBe(true); // opponent stays fully visible

    // Restore (cycle to chase/table, or the deslot snap): reappears in full.
    view.setBodyHidden(0, false);
    expect(player.visible).toBe(true);
    expect(ai.visible).toBe(true);
    view.dispose();
  });

  it('keeps the anchor LIVE while hidden — update() still writes the transform, so the follow camera does not freeze', () => {
    const scene = new Scene();
    const view = createCarsView(scene, track, ['p917']);
    view.setBodyHidden(0, true); // cockpit: player group invisible

    view.update([{ mode: 'slot', s: S_MID, slideYaw: 0, lane: 0, generation: 0 }]);
    const a1 = view.carAnchor(0)!;
    const p1 = a1.position.clone();
    // A later frame at a different s must move the (still-invisible) anchor.
    view.update([{ mode: 'slot', s: S_MID + 0.1, slideYaw: 0, lane: 0, generation: 0 }]);
    const p2 = view.carAnchor(0)!.position;

    const group = scene.children.find((o) => o.name === 'car-p917')!;
    expect(group.visible).toBe(false); // still hidden…
    expect(p1.distanceTo(p2)).toBeGreaterThan(1e-4); // …but the anchor tracked the car
    view.dispose();
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

// =====================================================================
// carsView.update() integration test — drives the real rotation.set() line
// =====================================================================

describe('carsView.update() — real rotation.set(bankRoll, yaw, gradePitch, YXZ) with banked+graded pose', () => {
  /**
   * A stub track with one lane that is both banked (θ=0.5236) and graded
   * (grade=0.08) on a non-axis-aligned arc. This guards against a
   * rotation.set() slot swap (gradePitch ↔ bankRoll) that would evade
   * tests checking the formula locally. The real nose/up vectors after
   * update() is the only reliable detector.
   */
  function createBankedGradedTrack(): { track: Track; laneIndex: number } {
    const THETA = 0.5236; // 30 degrees
    const GRADE = 0.08;
    const R = 0.2;

    // A left arc (κ > 0), non-axis-aligned (heading at s=0 is not 0 or π/2).
    // Center at (-R, 0) sim → (−R, 0) three, arc from angle 0 to π/2.
    const bankedGradedLane = createLanePath([
      {
        type: 'arc',
        center: { x: -R, y: 0 },
        radius: R,
        a0: 0,
        sweep: Math.PI / 2,
        length: R * (Math.PI / 2),
        bank: THETA,
        z0: 0,
        z1: GRADE * R * (Math.PI / 2), // grade = rise/run
      },
    ]);

    // Wrap into a Track-shaped object. Track requires a 2-lane tuple; both
    // lanes share the same banked+graded path here (only lane 0 is driven).
    const laneLen = R * (Math.PI / 2);
    const stubTrack: Track = {
      lanes: [bankedGradedLane, bankedGradedLane],
      pieceBoundaries: [
        [0, laneLen],
        [0, laneLen],
      ],
      pieces: [],
    };

    return { track: stubTrack, laneIndex: 0 };
  }

  it('nose climbs (world-Y > 0) on an uphill grade, and up-vector tilts toward the turn center with the correct magnitude', () => {
    const { track, laneIndex } = createBankedGradedTrack();
    const scene = new Scene();
    const view = createCarsView(scene, track, ['p917']);

    // Sample mid-lane, where heading is non-axis-aligned and both bank/grade are nonzero.
    const laneLength = track.lanes[laneIndex]!.totalLength;
    const s = laneLength / 2;
    const pt = track.lanes[laneIndex]!.pointAt(s);

    // Confirm the test setup: banked and graded.
    expect(Math.abs(pt.curvature)).toBeGreaterThan(0); // κ ≠ 0 (has bank)
    expect(Math.abs(pt.grade ?? 0)).toBeGreaterThan(0.07); // grade ≠ 0

    // Feed a slot-mode pose through the real update().
    const pose: CarRenderPose = {
      mode: 'slot',
      s,
      slideYaw: 0,
      lane: laneIndex,
      generation: 0,
    };
    view.update([pose]);

    // Read back the car's actual rotation from the group.
    const carGroup = scene.children[0]!; // First added child is car 0's group.
    expect(carGroup).toBeDefined();

    // Transform nose and up through the applied rotation.
    const nose = new Vector3(1, 0, 0).applyQuaternion(carGroup.quaternion);
    const up = new Vector3(0, 1, 0).applyQuaternion(carGroup.quaternion);

    // Assertion 1: nose climbs (uphill grade tips the nose up).
    expect(nose.y).toBeGreaterThan(0);

    // Assertion 2: up-vector tilts toward the turn center.
    const centerSim = { x: -0.2, y: 0 }; // center of the stub arc in sim coords
    const pinSim = pt.pos;

    // Unit vector toward the center in three-space (sim (x,y) → three (x,-y)).
    const dx = centerSim.x - pinSim.x;
    const dz = -(centerSim.y - pinSim.y);
    const len = Math.hypot(dx, dz) || 1;
    const toward = { x: dx / len, z: dz / len };

    // Horizontal component of up must point toward the center.
    const horizLen = Math.hypot(up.x, up.z) || 1;
    const dot = (up.x / horizLen) * toward.x + (up.z / horizLen) * toward.z;
    expect(dot).toBeGreaterThan(0.9); // must be nearly aligned with center direction

    // Assertion 3: tilt magnitude ≈ θ (0.5236 rad).
    const THETA = 0.5236;
    const tiltAngle = Math.acos(Math.min(1, Math.max(-1, up.y)));
    expect(tiltAngle).toBeCloseTo(THETA, 1);

    view.dispose();
  });
});
