import { Mesh, MeshBasicMaterial, PlaneGeometry } from 'three';
import type { AudioEngine } from './audio/engine';
import { MASTER_GAIN, createAudioEngine } from './audio/engine';
import { panForX } from './audio/mapping';
import type { MotorVoice } from './audio/motorVoice';
import { createMotorVoice } from './audio/motorVoice';
import type { Sfx } from './audio/sfx';
import { createSfx } from './audio/sfx';
import { TRACKS } from './config/tracks';
import { TUNING } from './config/tuning';
import { createInputManager } from './input/inputManager';
import { DEFAULT_DT, createLoop } from './loop';
import type { CarRenderPose, CarsView } from './render/carsView';
import { createCarsView } from './render/carsView';
import type { CarPose, DebugView } from './render/debugView';
import { createDebugView } from './render/debugView';
import { createEnvironment } from './render/environment';
import { addLookDevContent } from './render/lookdev';
import { createScene, type Quality } from './render/scene';
import { createTrackMesh } from './render/trackMesh';
import { tumblePose } from './sim/car/deslot';
import { lerp, wrapLerp } from './sim/math';
import { buildTrack } from './sim/track/builder';
import type { CarState, InputFrame, SimEvent } from './sim/types';
import type { LanePath } from './sim/track/path';
import type { CarConfig } from './sim/world';
import { createSim } from './sim/world';
import { createDebugPanel } from './ui/debugPanel';
import { createHud } from './ui/hud';
import { createStartGate } from './ui/menus';

// Mirrors render/environment.ts's TABLE_CENTER_X / (TABLE_WIDTH / 2) — kept as
// local consts here rather than a new cross-module export, same call as
// carsView.ts's ROADBED_TOP (a local mirror of trackMesh's internal ROAD_TOP)
// rather than reaching into environment.ts's internals for one number.
const TABLE_CENTER_X = 0.381;
const TABLE_HALF_WIDTH = 0.85; // TABLE_WIDTH (1.7 m) / 2

/**
 * Pace/AI motor voices detune +26 cents (~+1.5%) above the player's 0 — see
 * audio/mapping.ts's motorF0.
 */
const PACE_DETUNE_CENTS = 26;

/** setTargetAtTime time constant for the M-key mute ramp — short, just enough to avoid a click. */
const MUTE_RAMP_TAU = 0.05;

const container = document.getElementById('app');
if (!container) {
  throw new Error('Missing #app container element');
}

const params = new URLSearchParams(window.location.search);
const showLookDev = params.has('lookdev');
const showDebug = params.has('debug');
const quality = readQuality(params.get('quality'));

const sceneHandle = createScene(container, { quality });
const { scene, camera, keyLight, render } = sceneHandle;

let sim: ReturnType<typeof createSim> | undefined;
let carConfigs: CarConfig[] = [];
let carsView: CarsView | undefined; // photoreal AFX bodies (default view)
let debugView: DebugView | undefined; // flat neon boxes (?debug)
let inputManager: ReturnType<typeof createInputManager> | undefined;
let hud: ReturnType<typeof createHud> | undefined;
let debugPanel: ReturnType<typeof createDebugPanel> | undefined;

// Audio (M6): created only once the start gate's onStart fires (see below) —
// never eagerly, so the AudioContext is never constructed before a real
// user gesture unlocks it.
let engine: AudioEngine | undefined;
let motorVoices: MotorVoice[] = [];
let sfx: Sfx | undefined;
let muted = false;

// Player (car 0) lap-timing readout, updated as 'lap' SimEvents arrive.
let lapCount = 0;
let lastLapSec: number | null = null;
let bestLapSec: number | null = null;

if (showLookDev) {
  // M0 material-reference scene — reused when tuning paint/chrome/canopy.
  addLookDevContent(scene);
  camera.position.set(0, 1.05, 0.72);
  camera.lookAt(0, 0, 0);
} else {
  const track = buildTrack(TRACKS.oval.refs);

  if (showDebug) {
    // Geometry-correctness view: flat ground + neon lane ribbons + neon boxes.
    addGroundPlane();
    debugView = createDebugView(scene, track);
  } else {
    // Photoreal view: wood table + dark room + the real extruded track mesh,
    // with the M5 procedural AFX cars (player Porsche 917, pace Ferrari 512).
    createEnvironment(scene, keyLight);
    const trackMesh = createTrackMesh(track);
    scene.add(trackMesh.group);
    carsView = createCarsView(scene, track, ['p917', 'f512']);
  }

  carConfigs = [
    { lane: 0, controlled: 'input' }, // the player
    { lane: 1, controlled: 'constant', constantV: 1.5 }, // M2 pace-car placeholder
  ];
  sim = createSim({ track, cars: carConfigs, cfg: TUNING });
  inputManager = createInputManager();
  hud = createHud(document.body);
  debugPanel = createDebugPanel(TUNING);

  applyCameraFraming();

  // Sim/render start immediately (attract mode — the pace car circulating
  // silently is fine); audio is created/unlocked only from inside this real
  // click/keydown handler, never before.
  createStartGate(document.body, onStart);
}

/**
 * Fires exactly once, synchronously inside the start gate's click/keydown
 * handler. Creates the ONE AudioEngine, resumes it (ctx.resume() runs inside
 * that same real-gesture call stack — never from a gamepad callback), then
 * builds one persistent MotorVoice per car (player detune 0; every other car
 * +PACE_DETUNE_CENTS) and the one-shot Sfx bank.
 */
function onStart(): void {
  const newEngine = createAudioEngine();
  newEngine.ensureRunning();
  engine = newEngine;
  motorVoices = sim
    ? sim.carStates().map((_state, i) =>
        createMotorVoice(newEngine, { detuneCents: i === 0 ? 0 : PACE_DETUNE_CENTS }),
      )
    : [];
  sfx = createSfx(newEngine);
}

/**
 * Final "standing at the table" framing for the oval: a generous, slightly
 * asymmetric ~57deg down-angle that fills the frame and leaves the HUD's
 * top-left corner clear. Sim centroid is (0.381, 0.229) -> three (0.381, 0,
 * -0.229); the camera sits off the near-right corner and looks back across.
 */
function applyCameraFraming(): void {
  camera.fov = showDebug ? 45 : 38;
  camera.near = 0.05;
  camera.far = 20;
  camera.position.set(1.06, 1.74, 1.02);
  camera.lookAt(0.4, -0.02, -0.22);
  camera.updateProjectionMatrix();
}

function readQuality(value: string | null): Quality {
  return value === 'medium' || value === 'low' ? value : 'high';
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
 * Reacts to sim events with sound: deslot clatter for ANY car (panned to
 * where it left the track — the event's own `atS`, not the render-interpolated
 * pose, so the pan is exact regardless of frame timing), lap beep for the
 * player only. No-ops before the start gate fires (sfx is undefined).
 */
function handleAudioEvents(events: SimEvent[]): void {
  if (!sim || !sfx) return;
  for (const event of events) {
    if (event.type === 'deslot') {
      const lane = sim.laneFor(event.carIndex);
      const x = lane.pointAt(event.atS).pos.x;
      sfx.deslotClatter(panForX(x, TABLE_CENTER_X, TABLE_HALF_WIDTH));
    } else if (event.type === 'lap' && event.carIndex === 0) {
      sfx.lapBeep();
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

/**
 * A car's render pose for the real AFX bodies (carsView). Same sub-tick
 * interpolation + GENERATION GUARD as computeCarPose, but it hands carsView the
 * raw (interpolated) lane s + slide so carsView can do the pin-guided chord
 * orientation itself; a tumble hands over the sim's plan-view pose plus the
 * yawRate the render-side theatrics spin from.
 */
function computeCarRenderPose(
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
    return {
      mode: 'slot',
      s: currState.s,
      slideYaw: currState.slideYaw,
      v: currState.v,
      lane: currState.lane,
      generation: currState.generation,
    };
  }

  const s = wrapLerp(prevState.s, currState.s, alpha, lane.totalLength);
  const slideYaw = lerp(prevState.slideYaw, currState.slideYaw, alpha);
  return {
    mode: 'slot',
    s,
    slideYaw,
    v: currState.v,
    lane: currState.lane,
    generation: currState.generation,
  };
}

let lastTimestamp: number | undefined;

function frame(timestamp: number): void {
  if (lastTimestamp !== undefined) {
    const dtFrame = (timestamp - lastTimestamp) / 1000;

    pendingInput = { throttle: inputManager ? inputManager.readPlayerThrottle(dtFrame) : 0 };
    frameEvents = [];

    const alpha = loop.advance(dtFrame);

    handlePlayerLapEvents(frameEvents);
    handleAudioEvents(frameEvents);

    if (sim) {
      const currentSim = sim; // narrowed const so the closures below are safe
      const prevStates = currentSim.prevCarStates();
      const currStates = currentSim.carStates();

      // Every car's interpolated plan-view pose — computed once regardless of
      // which render view is active, since audio panning needs each car's x
      // position too, not just debugView.
      const carPoses = currStates.map((curr, i) =>
        computeCarPose(prevStates[i]!, curr, alpha, currentSim.laneFor(i)),
      );

      if (carsView) {
        carsView.update(
          currStates.map((curr, i) =>
            computeCarRenderPose(prevStates[i]!, curr, alpha, currentSim.laneFor(i)),
          ),
        );
      } else if (debugView) {
        debugView.setCarPoses(carPoses);
      }

      // Drive each car's persistent motor voice (no-op until the start gate's
      // onStart has populated motorVoices). Constant-controlled cars have no
      // real trigger, so they pass throttle = v/vmax for gain purposes (a
      // circulating pace car should still sound "driven," not silent).
      currStates.forEach((state, i) => {
        const voice = motorVoices[i];
        const config = carConfigs[i];
        const pose = carPoses[i];
        if (!voice || !config || !pose) return;
        const throttleForVoice =
          config.controlled === 'input' ? pendingInput.throttle : state.v / TUNING.vmax;
        voice.update({
          v: state.v,
          throttle: throttleForVoice,
          x: pose.x,
          vmax: TUNING.vmax,
          tableHalfWidth: TABLE_HALF_WIDTH,
          centerX: TABLE_CENTER_X,
        });
      });
    }

    if (hud) {
      hud.update({
        lap: lapCount,
        lastLapSec,
        bestLapSec,
        throttle: pendingInput.throttle,
        sourceLabel: inputManager ? inputManager.activeSourceLabel() : '',
        muted,
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

// 'M': dev/courtesy mute — toggles master gain 0 <-> MASTER_GAIN. A no-op
// before the start gate fires (engine is undefined until then). Ramped (not
// a direct .value= jump) to avoid an audible click on toggle; HUD shows a
// small "MUTED" indicator while active.
window.addEventListener('keydown', (event) => {
  if (event.code !== 'KeyM' || !engine) return;
  muted = !muted;
  engine.master.gain.setTargetAtTime(muted ? 0 : MASTER_GAIN, engine.ctx.currentTime, MUTE_RAMP_TAU);
});
