import { PerspectiveCamera, Quaternion, Euler, Vector3 } from 'three';
import { describe, expect, it } from 'vitest';
import { TRACKS } from '../config/tracks';
import { TUNING } from '../config/tuning';
import { createLoop } from '../loop';
import { buildTrack } from '../sim/track/builder';
import type { InputFrame } from '../sim/types';
import { createSim } from '../sim/world';
import {
  CHASE_FOV,
  COCKPIT_FOV,
  COCKPIT_NEAR,
  approachVec3,
  cockpitTimeScale,
  computeCameraPlacement,
  createCameraRig,
  effectiveCameraMode,
  nextCameraMode,
  smoothingAlpha,
} from './cameraRig';

describe('nextCameraMode', () => {
  it('cycles table → chase → cockpit → table', () => {
    expect(nextCameraMode('table')).toBe('chase');
    expect(nextCameraMode('chase')).toBe('cockpit');
    expect(nextCameraMode('cockpit')).toBe('table');
  });
});

describe('effectiveCameraMode — deslot snap to table', () => {
  it('chase/cockpit snap to table while the player is airborne', () => {
    expect(effectiveCameraMode('chase', true)).toBe('table');
    expect(effectiveCameraMode('cockpit', true)).toBe('table');
  });
  it('renders the selected view while slotted', () => {
    expect(effectiveCameraMode('chase', false)).toBe('chase');
    expect(effectiveCameraMode('cockpit', false)).toBe('cockpit');
  });
  it('table stays table either way', () => {
    expect(effectiveCameraMode('table', true)).toBe('table');
    expect(effectiveCameraMode('table', false)).toBe('table');
  });
});

describe('cockpitTimeScale', () => {
  it('is ½× only in cockpit at default speed', () => {
    expect(cockpitTimeScale('cockpit', false)).toBe(0.5);
  });
  it('is 1× in cockpit toggled to full speed', () => {
    expect(cockpitTimeScale('cockpit', true)).toBe(1);
  });
  it('is 1× in table and chase regardless of the flag', () => {
    expect(cockpitTimeScale('table', false)).toBe(1);
    expect(cockpitTimeScale('table', true)).toBe(1);
    expect(cockpitTimeScale('chase', false)).toBe(1);
    expect(cockpitTimeScale('chase', true)).toBe(1);
  });
});

describe('smoothingAlpha / approachVec3', () => {
  it('alpha is 0 for a non-positive dt and rises toward 1 as dt grows', () => {
    expect(smoothingAlpha(0, 0.1)).toBe(0);
    expect(smoothingAlpha(-1, 0.1)).toBe(0);
    expect(smoothingAlpha(0.1, 0.1)).toBeCloseTo(1 - Math.exp(-1), 12);
    expect(smoothingAlpha(10, 0.1)).toBeGreaterThan(0.99);
  });

  it('approachVec3 converges monotonically toward the target without overshoot', () => {
    const cur = new Vector3(0, 0, 0);
    const target = new Vector3(1, -2, 3);
    let lastDist = cur.distanceTo(target);
    for (let i = 0; i < 200; i++) {
      approachVec3(cur, target, smoothingAlpha(1 / 60, 0.1));
      const d = cur.distanceTo(target);
      expect(d).toBeLessThanOrEqual(lastDist + 1e-12);
      lastDist = d;
    }
    expect(cur.distanceTo(target)).toBeLessThan(1e-3);
  });
});

describe('computeCameraPlacement — anchor offset math over stub poses', () => {
  it('chase sits behind and above the pin, looking ahead (flat, +x heading)', () => {
    const P = new Vector3(0, 0, 0);
    const F = new Vector3(1, 0, 0);
    const U = new Vector3(0, 1, 0);
    const { eye, target, up } = computeCameraPlacement('chase', P, F, U);
    expect(eye.x).toBeLessThan(0); // behind the pin
    expect(eye.y).toBeGreaterThan(0); // above it
    expect(target.x).toBeGreaterThan(eye.x); // looking forward
    expect(up.x).toBeCloseTo(0, 12);
    expect(up.y).toBeCloseTo(1, 12);
  });

  it('cockpit sits ~at eye height just behind the pin, looking straight ahead', () => {
    const P = new Vector3(0, 0, 0);
    const F = new Vector3(1, 0, 0);
    const U = new Vector3(0, 1, 0);
    const { eye, target } = computeCameraPlacement('cockpit', P, F, U);
    // Low and close — an in-cockpit eye, not a chase pullback.
    expect(eye.y).toBeGreaterThan(0);
    expect(eye.y).toBeLessThan(0.02);
    expect(Math.abs(eye.x)).toBeLessThan(0.03);
    // Looks forward along the heading.
    const dir = target.clone().sub(eye).normalize();
    expect(dir.x).toBeCloseTo(1, 6);
  });

  it('a banked up-vector carries into the camera up AND lifts the eye laterally (rolls into the bank)', () => {
    // Up tilted 30° toward +z (a banked corner); forward still +x.
    const theta = 0.5236;
    const P = new Vector3(0, 0, 0);
    const F = new Vector3(1, 0, 0);
    const U = new Vector3(0, Math.cos(theta), Math.sin(theta));
    const { eye, up } = computeCameraPlacement('cockpit', P, F, U);
    // The returned up equals the (normalized) car up — the horizon rolls.
    expect(up.z).toBeCloseTo(Math.sin(theta), 6);
    expect(up.y).toBeCloseTo(Math.cos(theta), 6);
    // Because the "up" offset is along the tilted up, the eye gains a +z lean.
    expect(eye.z).toBeGreaterThan(0);
  });
});

/** A quaternion for yaw about world-up then a roll — the shape carsView's group carries. */
function poseQuat(yaw: number, bankRoll: number, gradePitch: number): Quaternion {
  return new Quaternion().setFromEuler(new Euler(bankRoll, yaw, gradePitch, 'YXZ'));
}

describe('createCameraRig — mode/speed state machine', () => {
  it('cycles views and resets cockpit to ½× on every entry; T toggles to full', () => {
    const rig = createCameraRig(new PerspectiveCamera());
    expect(rig.mode()).toBe('table');
    expect(rig.cycle()).toBe('chase');
    expect(rig.timeScale()).toBe(1);
    expect(rig.cycle()).toBe('cockpit');
    expect(rig.cockpitFullSpeed()).toBe(false); // ½× default
    expect(rig.timeScale()).toBe(0.5);
    rig.toggleCockpitSpeed();
    expect(rig.timeScale()).toBe(1);
    // Leave and re-enter cockpit → back to the ½× default.
    rig.cycle(); // table
    rig.cycle(); // chase
    rig.cycle(); // cockpit
    expect(rig.cockpitFullSpeed()).toBe(false);
    expect(rig.timeScale()).toBe(0.5);
  });

  it('effectiveMode snaps a selected cockpit to table while airborne but keeps ½× pacing', () => {
    const rig = createCameraRig(new PerspectiveCamera());
    rig.setMode('cockpit');
    expect(rig.effectiveMode(true)).toBe('table'); // snapped for the tumble
    expect(rig.effectiveMode(false)).toBe('cockpit'); // restored at reslot
    expect(rig.timeScale()).toBe(0.5); // slow-mo tumble stays slow-mo
  });
});

describe('createCameraRig — follow drives the real camera from the shared pose', () => {
  const anchor = { position: new Vector3(0.1, 0.2, -0.3), quaternion: poseQuat(0.7, 0, 0) };

  it('cockpit sets the tight near plane + wide fov and puts the eye near the pin', () => {
    const camera = new PerspectiveCamera(38, 1.5, 0.05, 20);
    const rig = createCameraRig(camera);
    rig.setMode('cockpit');
    rig.follow('cockpit', anchor, 1 / 60);
    expect(camera.near).toBe(COCKPIT_NEAR);
    expect(camera.fov).toBe(COCKPIT_FOV);
    expect(camera.position.distanceTo(anchor.position)).toBeLessThan(0.05);
  });

  it('a banked pose rolls the camera up-vector toward the bank; releaseToTable restores world up + table projection', () => {
    const camera = new PerspectiveCamera(38, 1.5, 0.05, 20);
    const rig = createCameraRig(camera);
    // A right-ish heading with a 30° bank roll in the Euler.X slot.
    const banked = { position: new Vector3(0, 0.02, 0), quaternion: poseQuat(0.3, 0.5236, 0) };
    rig.setMode('cockpit');
    rig.follow('cockpit', banked, 1 / 60);
    // Camera up left vertical — it has rolled with the bank.
    expect(Math.hypot(camera.up.x, camera.up.z)).toBeGreaterThan(0.1);

    rig.releaseToTable();
    expect(camera.up.x).toBe(0);
    expect(camera.up.y).toBe(1);
    expect(camera.up.z).toBe(0);
    expect(camera.fov).toBe(38); // table fov restored
    expect(camera.near).toBe(0.05); // table near restored
  });

  it('chase uses the chase fov and a farther pullback than cockpit', () => {
    const camera = new PerspectiveCamera(38, 1.5, 0.05, 20);
    const rig = createCameraRig(camera);
    rig.setMode('chase');
    rig.follow('chase', anchor, 1 / 60);
    expect(camera.fov).toBe(CHASE_FOV);
    const chaseDist = camera.position.distanceTo(anchor.position);
    rig.releaseToTable();

    const cockpitCam = new PerspectiveCamera(38, 1.5, 0.05, 20);
    const cockpitRig = createCameraRig(cockpitCam);
    cockpitRig.setMode('cockpit');
    cockpitRig.follow('cockpit', anchor, 1 / 60);
    const cockpitDist = cockpitCam.position.distanceTo(anchor.position);
    expect(chaseDist).toBeGreaterThan(cockpitDist);
  });

  it('re-seeds (snaps, no swoop) when re-entering a followed view after a table release', () => {
    const camera = new PerspectiveCamera(38, 1.5, 0.05, 20);
    const rig = createCameraRig(camera);
    rig.setMode('chase');
    // First follow snaps onto the car.
    rig.follow('chase', anchor, 1 / 60);
    const firstEye = camera.position.clone();
    // Release (a deslot snap to table), then move the car far away.
    rig.releaseToTable();
    const movedAnchor = { position: new Vector3(5, 0.02, -5), quaternion: anchor.quaternion };
    rig.follow('chase', movedAnchor, 1 / 60);
    // The eye jumped straight to the new car pose rather than easing across the
    // table from the old position (which would leave it ~7m behind for a frame).
    expect(camera.position.distanceTo(movedAnchor.position)).toBeLessThan(0.2);
    expect(camera.position.distanceTo(firstEye)).toBeGreaterThan(1);
  });
});

// =====================================================================
// Half-time SIM-TIME honesty: scaling the frameDelta fed to loop.advance
// changes only how much wall time maps to each fixed tick — the sim ticks the
// IDENTICAL deterministic sequence, so lap counts / states at a given tick are
// bit-identical at ½× and 1×. This drives a REAL sim through a real loop with
// the exact cockpitTimeScale wrapper main.ts applies.
// =====================================================================

const DT = 1 / 120;

/**
 * Runs `wallSeconds` of wall time through a fresh sim+loop at the given wall
 * pacing `scale` (0.5 = cockpit ½×), feeding a fixed 60fps frame cadence and a
 * scripted per-tick throttle. Returns the player's final CarState + tick count.
 */
function runScaled(scale: number, wallSeconds: number) {
  const sim = createSim({
    track: buildTrack(TRACKS.oval.refs),
    cars: [{ lane: 0, controlled: 'input' }],
    cfg: TUNING,
    seed: 7,
  });
  let ticks = 0;
  const loop = createLoop({
    step: (dt, tick) => {
      const input: InputFrame = { throttle: tick % 240 < 120 ? 1 : 0.2 };
      sim.step(dt, tick, [input]);
      ticks = tick;
    },
  });
  const frameDt = 1 / 60;
  const frames = Math.round(wallSeconds / frameDt);
  for (let i = 0; i < frames; i++) loop.advance(frameDt * scale);
  return { state: sim.carStates()[0]!, ticks };
}

describe('half-time is sim-time honest', () => {
  it('½× wall pacing over 2× the wall time reaches the same tick and the bit-identical CarState as 1×', () => {
    const full = runScaled(1, 4); // 4 wall-seconds at 1×
    const half = runScaled(0.5, 8); // 8 wall-seconds at ½× → the same sim ticks

    expect(half.ticks).toBe(full.ticks);
    // Same tick ⇒ same sim time ⇒ identical deterministic state, field by field.
    expect(Object.is(half.state.s, full.state.s)).toBe(true);
    expect(Object.is(half.state.v, full.state.v)).toBe(true);
    expect(Object.is(half.state.lapCount, full.state.lapCount)).toBe(true);
    expect(Object.is(half.state.slideYaw, full.state.slideYaw)).toBe(true);
    expect(half.state.phase).toBe(full.state.phase);
  });

  it('half as much wall time at ½× yields exactly half the ticks of 1× (slow motion, not fewer physics)', () => {
    const full = runScaled(1, 6);
    const half = runScaled(0.5, 6); // same wall time, half the pacing
    expect(half.ticks).toBe(Math.floor(full.ticks / 2));
  });
});
