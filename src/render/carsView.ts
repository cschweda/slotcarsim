import type { Scene } from 'three';
import type { Track } from '../sim/track/builder';
import type { LanePath } from '../sim/track/path';
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
    };

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

/** Forward arc-length hop a→b on a closed loop of length L, in [0, L). */
function forwardDelta(a: number, b: number, L: number): number {
  return (((b - a) % L) + L) % L;
}

// =====================================================================
// View
// =====================================================================

export interface CarsView {
  update(poses: CarRenderPose[]): void;
  dispose(): void;
}

export function createCarsView(scene: Scene, track: Track, styles: CarStyleId[]): CarsView {
  const cars: CarBody[] = styles.map((style) => buildCarBody(style));
  for (const car of cars) scene.add(car.group);

  // Per-car wheel-spin bookkeeping: last lane-s and last generation. A
  // generation change (reslot teleport) or a tumble resets tracking so the
  // wheels don't spin across the jump.
  const lastS: (number | null)[] = styles.map(() => null);
  const lastGen: (number | null)[] = styles.map(() => null);

  function update(poses: CarRenderPose[]): void {
    poses.forEach((pose, i) => {
      const car = cars[i];
      if (!car) return;

      if (pose.mode === 'tumble') {
        const th = tumbleTheatrics(pose.progress, pose.phase, pose.yawRate);
        car.group.position.set(pose.x, ROADBED_TOP + th.height, -pose.y);
        // yaw (flat spin) about world up, then pitch/roll in the car's frame.
        car.group.rotation.set(th.pitch, pose.yaw, th.roll, 'YXZ');
        lastS[i] = null; // wheels stop; drop spin tracking across the tumble
        lastGen[i] = null;
        return;
      }

      const lane: LanePath | undefined = track.lanes[pose.lane];
      if (!lane) return;
      const ori = slotOrientation(lane, pose.s, pose.slideYaw);
      car.group.position.set(ori.pinX, ROADBED_TOP, ori.pinZ);
      car.group.rotation.set(0, ori.rotationY, 0, 'XYZ');

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

  function dispose(): void {
    for (const car of cars) {
      scene.remove(car.group);
      car.dispose();
    }
  }

  return { update, dispose };
}
