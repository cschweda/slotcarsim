// Shared prev/curr sim-state -> render-pose interpolation. Extracted from
// main.ts (mechanical move — behavior unchanged) so BOTH the live per-frame
// render loop and instant replay (game/replay.ts's playback cursor drives
// main.ts's REPLAY wiring) go through the exact same rule for turning two
// recorded ticks + an alpha into a pose: forward-only wrapLerp arc
// interpolation while slotted, a hard snap (no interpolation) across a
// generation change (reslot teleport), and tumblePose for the
// airborne/waiting phases. The two paths can never disagree about this by
// construction — there is only one implementation.
import { TUNING } from '../config/tuning';
import { DEFAULT_DT } from '../loop';
import { tumblePose } from '../sim/car/deslot';
import { lerp, wrapLerp } from '../sim/math';
import type { LanePath } from '../sim/track/path';
import type { CarState } from '../sim/types';
import type { CarRenderPose } from './carsView';
import type { CarPose } from './debugView';

/** Debug-view pose (plan-view x/y/yaw + an elevated flag for the tumble hop) — see render/debugView.ts. */
export function computeCarPose(prevState: CarState, currState: CarState, alpha: number, lane: LanePath): CarPose {
  if (currState.phase !== 'slot') {
    const pose = tumblePose(
      { phase: currState.phase, phaseTicks: currState.phaseTicks, tumble: currState.tumble! },
      TUNING,
      DEFAULT_DT,
    );
    return { x: pose.pos.x, y: pose.pos.y, yaw: pose.yaw, elevated: true };
  }
  if (prevState.generation !== currState.generation) {
    const { pos, heading } = lane.pointAt(currState.s);
    return { x: pos.x, y: pos.y, yaw: heading + currState.slideYaw };
  }
  const s = wrapLerp(prevState.s, currState.s, alpha, lane.totalLength);
  const slideYaw = lerp(prevState.slideYaw, currState.slideYaw, alpha);
  const { pos, heading } = lane.pointAt(s);
  return { x: pos.x, y: pos.y, yaw: heading + slideYaw };
}

/** Full render pose (render/carsView.ts's CarRenderPose) — the pin-guided slot orientation or the tumble theatrics' inputs. */
export function computeCarRenderPose(
  prevState: CarState,
  currState: CarState,
  alpha: number,
  lane: LanePath,
): CarRenderPose {
  if (currState.phase !== 'slot') {
    const pose = tumblePose(
      { phase: currState.phase, phaseTicks: currState.phaseTicks, tumble: currState.tumble! },
      TUNING,
      DEFAULT_DT,
    );
    return {
      mode: 'tumble',
      x: pose.pos.x,
      y: pose.pos.y,
      yaw: pose.yaw,
      yawRate: currState.tumble!.yawRate,
      progress: pose.progress,
      phase: currState.phase,
    };
  }
  if (prevState.generation !== currState.generation) {
    return { mode: 'slot', s: currState.s, slideYaw: currState.slideYaw, lane: currState.lane, generation: currState.generation };
  }
  const s = wrapLerp(prevState.s, currState.s, alpha, lane.totalLength);
  const slideYaw = lerp(prevState.slideYaw, currState.slideYaw, alpha);
  return { mode: 'slot', s, slideYaw, lane: currState.lane, generation: currState.generation };
}
