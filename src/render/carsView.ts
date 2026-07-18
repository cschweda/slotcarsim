import {
  CanvasTexture,
  Mesh,
  MeshBasicMaterial,
  PlaneGeometry,
  type Quaternion,
  type Scene,
  type Texture,
  type Vector3,
} from 'three';
import { TUNING } from '../config/tuning';
import type { Track } from '../sim/track/builder';
import type { LanePath, PathPoint } from '../sim/track/path';
import { WHEEL_R_FRONT, WHEEL_R_REAR, WHEELBASE, buildCarBody, type CarBody, type CarStyleId } from './carMesh';

// Renders the sim's cars with real AFX bodies: pin-guided chord orientation +
// tail-out slide while slotted, a theatrical tumble while off-slot, and wheels
// that spin with the distance travelled. Replaces the debug boxes in main.ts.
//
// Sim (x, y) → three (x, 0, −y); "up" is +y (matches trackMesh/debugView). The
// car body is authored with its origin at the guide pin and +x forward, so the
// whole group rotates about the pin — the tail swings, exactly like a slot car.

// Roadbed top surface the wheels rest on (trackMesh ROAD_TOP = 6 mm above the
// table); the guide pin then dips into the slot below. Kept as a local const so
// carsView doesn't reach into trackMesh internals.
const ROADBED_TOP = 0.006;

// ---- M8: auto-quality-ladder blob shadows ---------------------------------
// A cheap dark-radial-gradient quad under each car, tracking its ground (x,
// z) every frame regardless of slot/tumble mode. Hidden by default; the auto
// quality ladder (render/scene.ts) turns these on exactly when it disables
// real shadows entirely (its rock-bottom tier), so the cars don't go from
// grounded to floating-looking once shadows are gone.
const BLOB_SHADOW_RADIUS = 0.05; // metres — a little larger than the ~80x32mm car body footprint
const BLOB_SHADOW_PROUD = 0.0003; // metres above ROADBED_TOP, avoiding z-fighting with the roadbed surface

let cachedBlobShadowTexture: Texture | null | undefined; // undefined = not yet attempted; null = attempted, unavailable (no document)

/** Shared, lazily-built, module-cached texture — one canvas for the whole app's lifetime, reused by every car/session. */
function getBlobShadowTexture(): Texture | null {
  if (cachedBlobShadowTexture !== undefined) return cachedBlobShadowTexture;
  if (typeof document === 'undefined' || typeof document.createElement !== 'function') {
    cachedBlobShadowTexture = null;
    return null;
  }
  const canvas = document.createElement('canvas');
  canvas.width = 64;
  canvas.height = 64;
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    cachedBlobShadowTexture = null;
    return null;
  }
  const g = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
  g.addColorStop(0, 'rgba(0, 0, 0, 0.55)');
  g.addColorStop(0.7, 'rgba(0, 0, 0, 0.28)');
  g.addColorStop(1, 'rgba(0, 0, 0, 0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  const texture = new CanvasTexture(canvas);
  texture.needsUpdate = true;
  cachedBlobShadowTexture = texture;
  return texture;
}

/**
 * A car's per-frame render pose, computed in main.ts from sim state. `slot`
 * carries the (sub-tick-interpolated) lane position + slide; `tumble` carries
 * the deslot state machine's plan-view pose plus the constants the render-side
 * theatrics need.
 */
export type CarRenderPose =
  // `v` was carried here but never read — wheel spin uses the actual Δs
  // between consecutive frames (see `update()` below), a more accurate
  // per-frame distance than v·dt would give across an interpolated alpha.
  | { mode: 'slot'; s: number; slideYaw: number; lane: number; generation: number }
  | {
      mode: 'tumble';
      x: number;
      y: number;
      yaw: number;
      yawRate: number;
      progress: number;
      phase: 'tumbling' | 'waiting';
      // M12: the lane elevation the car flew off from — the render height decays
      // this to table level over the first 40% of the tumble (theatrics only;
      // the sim's plan-view tumble kinematics are unchanged). 0 on flat tracks.
      exitZ: number;
    };

/** How far into the tumble the exit-elevation fall completes (then the normal bounce curve applies at table level). */
export const TUMBLE_FALL_END = 0.4;

// =====================================================================
// Pure helpers (unit-tested in carsView.test.ts)
// =====================================================================

export interface SlotOrientation {
  /** three-space pin position. */
  pinX: number;
  pinZ: number;
  /** group.rotation.y orienting local +x forward along the chord + slide. */
  rotationY: number;
  /** chord heading (rear→pin) in sim space, radians. */
  chordYaw: number;
}

/**
 * The pin-guided "chord" orientation: the body points from the rear reference
 * point (a wheelbase back along the lane) to the pin, NOT along the exact
 * tangent — so it lags the tangent slightly through a curve, the authentic
 * look of a car whose nose is dragged around by the front guide pin. Slide yaw
 * is then added, pivoting about the pin (the group's origin).
 *
 * Sign: local +x is forward and the sim→three map is (x, y) → (x, −y). A
 * heading θ's forward vector (cos θ, sin θ) maps to three (cos θ, −sin θ),
 * which is exactly where three's Y-rotation by θ sends local +x — so
 * rotation.y = chordYaw + slideYaw (NOT negated; matches the verified M3 debug
 * box and the tail-out assertion in the test).
 */
export function slotOrientation(lane: LanePath, s: number, slideYaw: number): SlotOrientation {
  const pin = lane.pointAt(s).pos;
  const rear = lane.pointAt(s - WHEELBASE).pos;
  const chordYaw = Math.atan2(pin.y - rear.y, pin.x - rear.x);
  return { pinX: pin.x, pinZ: -pin.y, rotationY: chordYaw + slideYaw, chordYaw };
}

export interface SlotElevation {
  /** three-space ride height at the car's own lane offset, on the (possibly banked/elevated) surface. */
  y: number;
  /** Euler pitch term (nose tips up/down on a grade), radians — the Euler.Z slot, see below. */
  gradePitch: number;
  /** Euler roll term (car banks into the turn), radians — the Euler.X slot, see below. */
  bankRoll: number;
}

/**
 * M12: lifts the plan-view slot pose into 3D — the lane sample's bank/grade/z
 * plus the car's own ride height at its lane offset on the surface. bank 0 /
 * grade 0 / z 0 ⇒ gradePitch 0, bankRoll 0, y === ROADBED_TOP exactly
 * (pre-M12 behavior, byte-identical).
 *
 * The ride height mirrors trackMesh.ts's worldPoint cross-section roll
 * exactly (across = laneOffset, height = ROADBED_TOP, rolled by bankRoll) so
 * the car sits ON the banked surface rather than floating or sinking.
 *
 * Axis note — the actual sign-sensitive part, see the pose-pipeline tests in
 * carsView.test.ts: the car body's local +x is forward, +y is up, so +z is
 * the lateral axis (module docblock above). This pose is applied as
 * `group.rotation.set(bankRoll, yaw, gradePitch, 'YXZ')` (see update()
 * below) — bankRoll in the Euler.X slot and gradePitch in the Euler.Z slot is
 * what makes each term move the axis it is named for: bankRoll tilts the
 * car's up vector toward the turn center without displacing the nose;
 * gradePitch tips the nose vertically without perturbing the lateral tilt.
 * Swapped (as this originally shipped), gradePitch loses its effect
 * completely on every flat-bank graded piece — bank 0 ⇒ sin(0) = 0 cancels
 * it outright — and bankRoll's tilt lands in the wrong plane (along the
 * direction of travel rather than lateral to it). Caught by transforming
 * actual nose/up vectors through this exact Euler construction, not by
 * checking the formula against itself.
 */
export function slotElevation(pt: PathPoint, laneOffset: number): SlotElevation {
  const bankRoll = -Math.sign(pt.curvature) * (pt.bank ?? 0);
  const gradePitch = Math.atan(pt.grade ?? 0);
  const y = (pt.z ?? 0) + laneOffset * Math.sin(bankRoll) + ROADBED_TOP * Math.cos(bankRoll);
  return { y, gradePitch, bankRoll };
}

export interface TumbleTheatrics {
  /** Metres above the resting plane. */
  height: number;
  /** End-over-end pitch, radians. */
  pitch: number;
  /** Barrel roll, radians. */
  roll: number;
}

/** Fraction of the tumbling phase spent airborne before settling flat. */
const AIR_END = 0.86;

/** Double-bounce launch height: a big hop, a smaller hop, then flat. */
function tumbleHeight(progress: number): number {
  if (progress >= AIR_END) return 0;
  const H1 = 0.05;
  const H2 = 0.022;
  const T1 = 0.52;
  if (progress < T1) return H1 * Math.sin((Math.PI * progress) / T1);
  return H2 * Math.sin((Math.PI * (progress - T1)) / (AIR_END - T1));
}

/**
 * Render-only tumble theatrics, a pure function of the sim-derived
 * (progress, phase, yawRate) — no Math.random, fully deterministic from the
 * seed. Pitch/roll spin up while airborne and ease back to flat by the time
 * the car lands, so the hand-off into the frozen 'waiting' rest (flat on the
 * ground) doesn't snap. Magnitude scales with |yawRate|, so a violent seed
 * tumbles harder.
 */
export function tumbleTheatrics(
  progress: number,
  phase: 'tumbling' | 'waiting',
  yawRate: number,
): TumbleTheatrics {
  if (phase === 'waiting') return { height: 0, pitch: 0, roll: 0 };
  const air = Math.sin(Math.PI * Math.min(progress / AIR_END, 1)); // 0 at 0 and ≥AIR_END
  const spin = Math.abs(yawRate);
  return {
    height: tumbleHeight(progress),
    pitch: 0.64 * spin * air,
    roll: 0.4 * spin * air * Math.sign(yawRate || 1),
  };
}

/**
 * M12: a car that flew off an elevated section starts at that height (exitZ)
 * and falls to the table over the first TUMBLE_FALL_END of tumble progress,
 * decaying linearly and monotonically; from TUMBLE_FALL_END on it is exactly
 * 0 and the ordinary tumbleHeight bounce curve (table-relative) takes over.
 * exitZ 0 ⇒ identically 0 for every progress (pre-M12 flat-track behavior).
 */
export function tumbleFallZ(exitZ: number, progress: number): number {
  return exitZ * Math.max(0, 1 - progress / TUMBLE_FALL_END);
}

/** Forward arc-length hop a→b on a closed loop of length L, in [0, L). */
function forwardDelta(a: number, b: number, L: number): number {
  return (((b - a) % L) + L) % L;
}

// =====================================================================
// View
// =====================================================================

/** A car's live render transform, for the M13 camera rig to anchor chase/cockpit to the SAME pose update() applied. */
export interface CarAnchor {
  /** World position of the car's group origin — the guide pin (world = local; the group is a direct scene child). */
  position: Vector3;
  /** World orientation — the full pin-guided 3D pose (bank roll / grade pitch / slide yaw baked in). */
  quaternion: Quaternion;
}

export interface CarsView {
  update(poses: CarRenderPose[]): void;
  /** M8 auto quality ladder: show/hide the cheap blob-shadow fallback (its rock-bottom, shadows-off tier). */
  setBlobShadows(enabled: boolean): void;
  /** M13: the car's live group transform (call AFTER update()), for the camera rig — null if that car index doesn't exist. Returns the group's own live position/quaternion refs (read-only; valid until the next update()). */
  carAnchor(index: number): CarAnchor | null;
  /**
   * M13: fully hide (true) or restore (false) a car's entire mesh — for
   * TRUE first-person cockpit, the player must see ZERO of their own car
   * (no body, canopy, chassis, wheels, chrome, pin, or cast shadow) at any
   * angle on flat OR banked/graded track. Toggles the group's visibility
   * flag; update() keeps writing the group transform regardless, so
   * carAnchor() stays live while hidden and the car reappears completely the
   * instant this is called with false (mode change / deslot snap-to-table).
   */
  setBodyHidden(index: number, hidden: boolean): void;
  dispose(): void;
}

export function createCarsView(scene: Scene, track: Track, styles: CarStyleId[]): CarsView {
  const cars: CarBody[] = styles.map((style) => buildCarBody(style));
  for (const car of cars) scene.add(car.group);

  // M13: which cars are fully hidden (cockpit self-hiding). A hidden car shows
  // neither its group (below) NOR its blob-shadow fallback (setBlobShadows),
  // so first-person is truly free of the player's own car AND its ground decal.
  const hiddenBody: boolean[] = styles.map(() => false);

  // Per-car wheel-spin bookkeeping: last lane-s and last generation. A
  // generation change (reslot teleport) or a tumble resets tracking so the
  // wheels don't spin across the jump.
  const lastS: (number | null)[] = styles.map(() => null);
  const lastGen: (number | null)[] = styles.map(() => null);

  // One shared geometry + material (one shared texture) for every car's blob
  // shadow — only the Mesh wrapper (for independent positioning) is per-car.
  // Hidden until setBlobShadows(true).
  const blobGeometry = new PlaneGeometry(BLOB_SHADOW_RADIUS * 2, BLOB_SHADOW_RADIUS * 2);
  const blobMaterial = new MeshBasicMaterial({
    map: getBlobShadowTexture(),
    transparent: true,
    depthWrite: false,
  });
  const blobShadows: Mesh[] = styles.map(() => {
    const mesh = new Mesh(blobGeometry, blobMaterial);
    mesh.rotation.x = -Math.PI / 2;
    mesh.visible = false;
    scene.add(mesh);
    return mesh;
  });

  function update(poses: CarRenderPose[]): void {
    poses.forEach((pose, i) => {
      const car = cars[i];
      const blob = blobShadows[i];
      if (!car) return;

      if (pose.mode === 'tumble') {
        const th = tumbleTheatrics(pose.progress, pose.phase, pose.yawRate);
        const fallZ = tumbleFallZ(pose.exitZ, pose.progress);
        car.group.position.set(pose.x, ROADBED_TOP + th.height + fallZ, -pose.y);
        // yaw (flat spin) about world up, then pitch/roll in the car's frame.
        car.group.rotation.set(th.pitch, pose.yaw, th.roll, 'YXZ');
        // The shadow stays grounded (ignores tumble/fall height), tracking the
        // car's plan-view position directly beneath it.
        blob?.position.set(pose.x, ROADBED_TOP + BLOB_SHADOW_PROUD, -pose.y);
        lastS[i] = null; // wheels stop; drop spin tracking across the tumble
        lastGen[i] = null;
        return;
      }

      const lane: LanePath | undefined = track.lanes[pose.lane];
      if (!lane) return;
      const ori = slotOrientation(lane, pose.s, pose.slideYaw);
      // M12: lift the plan-view pose into 3D — centerline elevation z, a body
      // roll into the bank, and a grade pitch. On a flat, unbanked lane every
      // term is 0 and this is exactly the pre-M12 pose (ROADBED_TOP, yaw only).
      const pt = lane.pointAt(pose.s);
      const laneOffset = pose.lane === 0 ? TUNING.laneOffset : -TUNING.laneOffset;
      const { y, gradePitch, bankRoll } = slotElevation(pt, laneOffset);
      car.group.position.set(ori.pinX, y, ori.pinZ);
      car.group.rotation.set(bankRoll, ori.rotationY, gradePitch, 'YXZ');
      blob?.position.set(ori.pinX, y + BLOB_SHADOW_PROUD, ori.pinZ);

      // Spin the wheels by the distance actually travelled this frame, but only
      // when we're continuous with the previous frame (same generation).
      if (lastGen[i] === pose.generation && lastS[i] !== null) {
        let ds = forwardDelta(lastS[i]!, pose.s, lane.totalLength);
        if (ds > lane.totalLength * 0.5) ds = 0; // guard against a wrap/teleport
        car.wheels.front.rotation.z -= ds / WHEEL_R_FRONT;
        car.wheels.rear.rotation.z -= ds / WHEEL_R_REAR;
      }
      lastS[i] = pose.s;
      lastGen[i] = pose.generation;
    });
  }

  function setBlobShadows(enabled: boolean): void {
    // A fully-hidden car (cockpit) keeps its blob shadow off too, regardless of
    // the global quality-ladder toggle.
    blobShadows.forEach((blob, i) => {
      blob.visible = enabled && !hiddenBody[i];
    });
  }

  function carAnchor(index: number): CarAnchor | null {
    const car = cars[index];
    if (!car) return null;
    // The group is added directly to the scene (identity parent), so its local
    // position/quaternion ARE world-space — exactly the transform update() just
    // wrote. No recomputation, no matrixWorld walk.
    return { position: car.group.position, quaternion: car.group.quaternion };
  }

  function setBodyHidden(index: number, hidden: boolean): void {
    const car = cars[index];
    if (!car) return;
    // Hide the ENTIRE car group (three skips an invisible subtree, cast shadow
    // included) — TRUE first person shows none of the player's own car. The
    // group transform still updates each frame (update() ignores visibility),
    // so carAnchor() stays live and the car reappears in full the moment this
    // is set back to visible. hiddenBody also suppresses the blob-shadow decal.
    hiddenBody[index] = hidden;
    car.group.visible = !hidden;
    if (hidden) {
      const blob = blobShadows[index];
      if (blob) blob.visible = false;
    }
  }

  function dispose(): void {
    for (const car of cars) {
      scene.remove(car.group);
      car.dispose();
    }
    for (const blob of blobShadows) scene.remove(blob);
    blobGeometry.dispose();
    blobMaterial.dispose();
    // The shared blob-shadow texture is cached at module scope for the
    // whole app's lifetime (reused across sessions) and is intentionally
    // NOT disposed here.
  }

  return { update, setBlobShadows, carAnchor, setBodyHidden, dispose };
}
