// M13: switchable camera views — the existing fitted TABLE view, a CHASE cam
// just above/behind the car, and a first-person COCKPIT view — plus the
// half-speed-in-cockpit time scaling. The `C` key (and the on-screen VIEW
// button) cycle the mode; `T` toggles cockpit back to full speed.
//
// The chase/cockpit anchors are derived from the SAME group transform
// render/carsView.ts already computed for the player's car this frame (its
// world position = the guide pin, and its world quaternion = the full 3D
// pin-guided pose, including M12 bank roll / grade pitch / elevation). We
// never recompute the pose here — carsView.playerAnchor() hands us the live
// group.position/quaternion, and this module only offsets/looks along them,
// so a banked end genuinely rolls the cockpit horizon and a climb pitches the
// view up, for free, by construction.
//
// The pure pieces (mode cycle, deslot snap, time scale, smoothing, anchor
// offset math) are split out and unit-tested in cameraRig.test.ts over stub
// poses; createCameraRig is the thin wiring onto a real PerspectiveCamera.
import { PerspectiveCamera, Quaternion, Vector3 } from 'three';

export type CameraViewMode = 'table' | 'chase' | 'cockpit';

/** Cycle order for the `C` key / VIEW button: table → chase → cockpit → table. */
export const CAMERA_VIEW_MODES: readonly CameraViewMode[] = ['table', 'chase', 'cockpit'];

/** Human label shown on the on-screen VIEW button / HUD badge. */
export const CAMERA_VIEW_LABELS: Record<CameraViewMode, string> = {
  table: 'TABLE',
  chase: 'CHASE',
  cockpit: 'COCKPIT',
};

/** The next mode in the cycle. */
export function nextCameraMode(mode: CameraViewMode): CameraViewMode {
  const i = CAMERA_VIEW_MODES.indexOf(mode);
  return CAMERA_VIEW_MODES[(i + 1) % CAMERA_VIEW_MODES.length]!;
}

/**
 * The mode the camera actually renders this frame. While the player's car is
 * off-slot (deslot tumble/waiting — `airborne`), chase/cockpit SNAP to the
 * table view so the whole theatrical tumble is watchable from the fitted
 * overhead framing; the selected view returns at reslot. Table stays table.
 */
export function effectiveCameraMode(selected: CameraViewMode, airborne: boolean): CameraViewMode {
  return airborne && selected !== 'table' ? 'table' : selected;
}

/**
 * The sim wall-pacing multiplier for the frameDelta fed to loop.advance: ½×
 * while the SELECTED view is cockpit and not toggled to full speed, otherwise
 * 1×. Keyed on the SELECTED mode (not the effective one) so a mid-cockpit
 * deslot still plays its snapped-to-table tumble in slow motion. The sim ticks
 * the identical deterministic sequence either way — only how much wall time
 * maps to each fixed tick changes, so lap times (sim-time) stay honest.
 */
export function cockpitTimeScale(selected: CameraViewMode, cockpitFullSpeed: boolean): number {
  return selected === 'cockpit' && !cockpitFullSpeed ? 0.5 : 1;
}

/**
 * Frame-rate-independent exponential-approach fraction over `dt` seconds with
 * time constant `tau` — the same 1 − e^(−dt/τ) shape as cameraZoom's
 * approachZoom and the WebAudio setTargetAtTime glides. dt ≤ 0 ⇒ 0 (no move).
 */
export function smoothingAlpha(dt: number, tau: number): number {
  return 1 - Math.exp(-Math.max(0, dt) / tau);
}

/** Ease `current` toward `target` in place by `alpha` (per component); returns `current`. */
export function approachVec3(current: Vector3, target: Vector3, alpha: number): Vector3 {
  current.x += (target.x - current.x) * alpha;
  current.y += (target.y - current.y) * alpha;
  current.z += (target.z - current.z) * alpha;
  return current;
}

// ---- Anchor offset geometry (metres, car-local) ---------------------------
// Offsets are applied along the car's own forward (F) and up (U) unit vectors,
// so every one inherits the full banked/graded/sliding pose. "Up" here is the
// CAR's up, which is exactly why the cockpit/chase horizon rolls into a bank.
const CHASE = {
  /** Behind the pin along the heading. */ back: 0.06,
  /** Above the pin along car-up. */ up: 0.035,
  /** Look this far ahead of the pin. */ lookAhead: 0.17,
  /** Nudge the look point up so the car sits low in frame, not dead-center. */ lookUp: 0.008,
};
const COCKPIT = {
  /** Behind the pin, at the cockpit station. */ back: 0.013,
  /** Above the chassis — eye height, rails end up ~at eye level. */ up: 0.0095,
  /** Look straight down the heading (distance is irrelevant to lookAt). */ lookAhead: 0.4,
};

/** Per-mode projection: cockpit pulls the near plane right in and widens the FOV for an immersive rush. */
export const CHASE_FOV = 60;
export const COCKPIT_FOV = 74;
export const CHASE_NEAR = 0.02;
export const COCKPIT_NEAR = 0.002;

export interface CameraPlacement {
  eye: Vector3;
  target: Vector3;
  up: Vector3;
}

/**
 * Where the camera eye sits, what it looks at, and its up vector for a
 * chase/cockpit view, given the pin world position `P` and the car's forward
 * `F` / up `U` unit vectors (all already the smoothed frame — see the rig).
 * Pure and allocation-returning so it's unit-testable over stub poses,
 * including a tilted `U` (a banked corner) that must carry into `up`.
 */
export function computeCameraPlacement(
  mode: 'chase' | 'cockpit',
  P: Vector3,
  F: Vector3,
  U: Vector3,
): CameraPlacement {
  const f = F.clone().normalize();
  const u = U.clone().normalize();
  if (mode === 'cockpit') {
    const eye = P.clone().addScaledVector(f, -COCKPIT.back).addScaledVector(u, COCKPIT.up);
    const target = eye.clone().addScaledVector(f, COCKPIT.lookAhead);
    return { eye, target, up: u };
  }
  const eye = P.clone().addScaledVector(f, -CHASE.back).addScaledVector(u, CHASE.up);
  const target = P.clone().addScaledVector(f, CHASE.lookAhead).addScaledVector(u, CHASE.lookUp);
  return { eye, target, up: u };
}

// ---- Smoothing time constants ---------------------------------------------
// Position eases quickly (the eye is essentially rigid to the car, but a
// little smoothing removes sub-tick jitter); orientation eases more slowly so
// the fast tail-out slide-yaw wobble is damped and the view never whips.
const POS_TAU = 0.07;
const ROT_TAU = 0.13;

/** The player car's live render transform (world = local; it's a direct scene child). */
export interface CameraAnchor {
  position: Vector3;
  quaternion: Quaternion;
}

export interface CameraRig {
  /** The player-selected view (persists across deslot snaps and session rebuilds). */
  mode(): CameraViewMode;
  /** Advance to the next view; returns the new mode. Entering cockpit resets it to ½× (the default). */
  cycle(): CameraViewMode;
  /** Jump straight to a specific view (e.g. a menu pick); resets cockpit to ½× when landing on cockpit. */
  setMode(mode: CameraViewMode): void;
  /** True when cockpit is currently running at full speed (T pressed); false = ½× default. */
  cockpitFullSpeed(): boolean;
  /** Toggle cockpit full-speed ↔ ½×; returns the new full-speed flag. Only meaningful while cockpit is selected. */
  toggleCockpitSpeed(): boolean;
  /** The view rendered this frame given whether the player is off-slot (deslot snap to table). */
  effectiveMode(airborne: boolean): CameraViewMode;
  /** ½× or 1× wall pacing for the sim this frame (see cockpitTimeScale). */
  timeScale(): number;
  /** Drive the camera for a chase/cockpit frame from the shared anchor. */
  follow(mode: 'chase' | 'cockpit', anchor: CameraAnchor, dt: number): void;
  /** Hand the camera back to the table framing: restore world-up + the table projection. */
  releaseToTable(): void;
}

/**
 * Wires the pure pieces above onto a real PerspectiveCamera. Owns the camera's
 * position/lookAt/up/near/fov ONLY while a chase/cockpit frame is active;
 * releaseToTable() restores exactly what the table framing needs (world up and
 * the captured table near/fov) so main.ts's applyCameraFraming keeps working
 * unchanged for the table view, zoom, and pan.
 */
export function createCameraRig(camera: PerspectiveCamera): CameraRig {
  let selected: CameraViewMode = 'table';
  let fullSpeed = false;

  // The smoothed follow frame (pin position + forward/up unit vectors).
  const smoothPos = new Vector3();
  const smoothFwd = new Vector3();
  const smoothUp = new Vector3();
  // Scratch for the per-frame target frame (no per-frame allocation).
  const tmpFwd = new Vector3();
  const tmpUp = new Vector3();
  let following = false;

  // The table view's projection, captured the first time we take the camera
  // over so releaseToTable can restore it exactly (table fov/near are constant
  // in practice, but capturing avoids hardcoding them here).
  let tableFov: number | null = null;
  let tableNear: number | null = null;

  function mode(): CameraViewMode {
    return selected;
  }

  function landOn(next: CameraViewMode): void {
    // ½× is the cockpit default on every fresh entry (the whole point — "so
    // things don't go by so quickly"); T re-enables full speed from there.
    if (next === 'cockpit') fullSpeed = false;
    selected = next;
  }

  function cycle(): CameraViewMode {
    landOn(nextCameraMode(selected));
    return selected;
  }

  function setMode(next: CameraViewMode): void {
    landOn(next);
  }

  function toggleCockpitSpeed(): boolean {
    fullSpeed = !fullSpeed;
    return fullSpeed;
  }

  function follow(followMode: 'chase' | 'cockpit', anchor: CameraAnchor, dt: number): void {
    if (tableFov === null) {
      tableFov = camera.fov;
      tableNear = camera.near;
    }

    tmpFwd.set(1, 0, 0).applyQuaternion(anchor.quaternion);
    tmpUp.set(0, 1, 0).applyQuaternion(anchor.quaternion);

    if (!following) {
      // (Re-)entering a followed view: snap the smoothed frame onto the car so
      // there's no swoop from a stale eye position (e.g. after a deslot snap).
      smoothPos.copy(anchor.position);
      smoothFwd.copy(tmpFwd);
      smoothUp.copy(tmpUp);
      following = true;
    } else {
      approachVec3(smoothPos, anchor.position, smoothingAlpha(dt, POS_TAU));
      approachVec3(smoothFwd, tmpFwd, smoothingAlpha(dt, ROT_TAU));
      approachVec3(smoothUp, tmpUp, smoothingAlpha(dt, ROT_TAU));
    }

    const placement = computeCameraPlacement(followMode, smoothPos, smoothFwd, smoothUp);
    camera.position.copy(placement.eye);
    camera.up.copy(placement.up);
    camera.lookAt(placement.target);

    const near = followMode === 'cockpit' ? COCKPIT_NEAR : CHASE_NEAR;
    const fov = followMode === 'cockpit' ? COCKPIT_FOV : CHASE_FOV;
    if (camera.near !== near || camera.fov !== fov) {
      camera.near = near;
      camera.fov = fov;
      camera.updateProjectionMatrix();
    }
  }

  function releaseToTable(): void {
    if (!following) return;
    following = false;
    // The table framing (applyCameraFraming) assumes world up; a banked
    // chase/cockpit frame left it rolled, so reset it here.
    camera.up.set(0, 1, 0);
    if (tableFov !== null && tableNear !== null && (camera.fov !== tableFov || camera.near !== tableNear)) {
      camera.fov = tableFov;
      camera.near = tableNear;
      camera.updateProjectionMatrix();
    }
  }

  return {
    mode,
    cycle,
    setMode,
    cockpitFullSpeed: () => fullSpeed,
    toggleCockpitSpeed,
    effectiveMode: (airborne: boolean) => effectiveCameraMode(selected, airborne),
    timeScale: () => cockpitTimeScale(selected, fullSpeed),
    follow,
    releaseToTable,
  };
}
