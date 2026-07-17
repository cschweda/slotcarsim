import { Mesh, MeshBasicMaterial, PlaneGeometry } from 'three';
import { TRACKS } from './config/tracks';
import { TUNING } from './config/tuning';
import { createInputManager } from './input/inputManager';
import { DEFAULT_DT, createLoop } from './loop';
import type { CarPose } from './render/debugView';
import { createDebugView } from './render/debugView';
import { addLookDevContent } from './render/lookdev';
import { createScene } from './render/scene';
import { tumblePose } from './sim/car/deslot';
import { lerp, wrapLerp } from './sim/math';
import { buildTrack } from './sim/track/builder';
import type { CarState, InputFrame, SimEvent } from './sim/types';
import type { LanePath } from './sim/track/path';
import { createSim } from './sim/world';
import { createDebugPanel } from './ui/debugPanel';
import { createHud } from './ui/hud';

const container = document.getElementById('app');
if (!container) {
  throw new Error('Missing #app container element');
}

const { scene, camera, render } = createScene(container);

const showLookDev = new URLSearchParams(window.location.search).has('lookdev');

let track: ReturnType<typeof buildTrack> | undefined;
let debugView: ReturnType<typeof createDebugView> | undefined;
let sim: ReturnType<typeof createSim> | undefined;
let inputManager: ReturnType<typeof createInputManager> | undefined;
let hud: ReturnType<typeof createHud> | undefined;
let debugPanel: ReturnType<typeof createDebugPanel> | undefined;

// Player (car 0) lap-timing readout, updated as 'lap' SimEvents arrive.
let lapCount = 0;
let lastLapSec: number | null = null;
let bestLapSec: number | null = null;

if (showLookDev) {
  // M0 material-reference scene — reused later when tuning M4/M5 paint,
  // chrome, and canopy materials against known-good spheres.
  addLookDevContent(scene);
} else {
  addGroundPlane();
  track = buildTrack(TRACKS.oval.refs);
  debugView = createDebugView(scene, track);
  sim = createSim({
    track,
    cars: [
      { lane: 0, controlled: 'input' }, // the player
      { lane: 1, controlled: 'constant', constantV: 1.5 }, // M2 pace-car placeholder
    ],
    cfg: TUNING,
  });
  inputManager = createInputManager();
  hud = createHud(document.body);
  debugPanel = createDebugPanel(TUNING);

  // M0's table rig framed the small look-dev spheres (~0.6m across); the
  // oval's bounding box is centered around sim (0.38, 0.23) and ~1.22m wide,
  // so re-target the same rig at that centroid and pull it back to fit.
  // Placeholder framing either way — scene.ts's own comment already notes
  // exact camera framing is tuned for real once M4 has real track geometry.
  camera.position.set(0.38, 1.7, 0.95);
  camera.lookAt(0.38, 0, -0.23);
}

function addGroundPlane(): void {
  const ground = new Mesh(new PlaneGeometry(2, 2), new MeshBasicMaterial({ color: '#3a3a3a' }));
  ground.rotation.x = -Math.PI / 2;
  scene.add(ground);
}

// Read once per rAF (not per sim tick) and held constant across however many
// fixed ticks that frame's loop.advance() ends up running — an authentic
// controller poll rate, and what keeps one throttle sample from silently
// smearing across ticks it wasn't actually read for.
let pendingInput: InputFrame = { throttle: 0 };
let frameEvents: SimEvent[] = [];

const loop = createLoop({
  step: (dt, tick) => {
    if (!sim) return;
    frameEvents.push(...sim.step(dt, tick, [pendingInput]));
  },
});

function handlePlayerLapEvents(events: SimEvent[]): void {
  for (const event of events) {
    if (event.type !== 'lap' || event.carIndex !== 0) continue; // HUD tracks the player's laps only
    lapCount = event.lapNumber;
    lastLapSec = event.lapTimeSec;
    if (bestLapSec === null || event.lapTimeSec < bestLapSec) {
      bestLapSec = event.lapTimeSec;
    }
  }
}

/**
 * A car's render pose for this frame: sub-tick-interpolated lane position +
 * heading + slideYaw while slotted, or the deslot state machine's tumblePose
 * while tumbling/waiting (elevated, per the brief's crude M3 debug box).
 *
 * GENERATION GUARD: a reslot snaps CarState.s back to the exit point in the
 * very same tick it bumps `generation`. Interpolating between that tick's
 * prev (still off in the infield, mid-wait) and curr (back on the lane)
 * would sweep the box across the table for one frame, so a generation
 * change instead snaps straight to curr with no blending at all.
 */
function computeCarPose(prevState: CarState, currState: CarState, alpha: number, lane: LanePath): CarPose {
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

let lastTimestamp: number | undefined;

function frame(timestamp: number): void {
  if (lastTimestamp !== undefined) {
    const dtFrame = (timestamp - lastTimestamp) / 1000;

    pendingInput = { throttle: inputManager ? inputManager.readPlayerThrottle(dtFrame) : 0 };
    frameEvents = [];

    const alpha = loop.advance(dtFrame);

    handlePlayerLapEvents(frameEvents);

    if (sim && debugView) {
      const currentSim = sim; // narrowed const so the closure below is safe
      const prevStates = currentSim.prevCarStates();
      const currStates = currentSim.carStates();
      const poses = currStates.map((curr, i) => {
        const prevState = prevStates[i]!;
        const lane = currentSim.laneFor(i);
        return computeCarPose(prevState, curr, alpha, lane);
      });
      debugView.setCarPoses(poses);
    }

    if (hud) {
      hud.update({
        lap: lapCount,
        lastLapSec,
        bestLapSec,
        throttle: pendingInput.throttle,
        sourceLabel: inputManager ? inputManager.activeSourceLabel() : '',
      });
    }

    if (debugPanel && sim) {
      const playerState = sim.carStates()[0];
      if (playerState) {
        debugPanel.sample({ v: playerState.v, throttle: pendingInput.throttle });
      }
    }
  }
  lastTimestamp = timestamp;

  render();
  requestAnimationFrame(frame);
}

requestAnimationFrame(frame);

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') {
    // Drop the stale timestamp so the next frame doesn't compute a huge
    // delta from time spent hidden, and clear any pending accumulator
    // remainder so a backgrounded tab doesn't fast-forward the sim on resume.
    lastTimestamp = undefined;
    loop.reset();
  }
});
