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
import type { CarStyleId } from './render/carMesh';
import type { RaceConfig, RaceMachine, TrackId } from './game/race';
import { AI_CAR_INDEX, PLAYER_CAR_INDEX, createRace } from './game/race';
import { createInputManager } from './input/inputManager';
import { DEFAULT_DT, createLoop } from './loop';
import type { CarRenderPose, CarsView } from './render/carsView';
import { createCarsView } from './render/carsView';
import type { CarPose, DebugView } from './render/debugView';
import { createDebugView } from './render/debugView';
import type { Environment } from './render/environment';
import { createEnvironment } from './render/environment';
import { addLookDevContent } from './render/lookdev';
import { createScene, type Quality } from './render/scene';
import type { TrackMesh } from './render/trackMesh';
import { createTrackMesh } from './render/trackMesh';
import { tumblePose } from './sim/car/deslot';
import { lerp, wrapLerp } from './sim/math';
import type { Track } from './sim/track/builder';
import { buildTrack } from './sim/track/builder';
import type { LanePath } from './sim/track/path';
import type { CarState, InputFrame, SimEvent } from './sim/types';
import type { CarConfig, Sim } from './sim/world';
import { createSim } from './sim/world';
import { createDebugPanel } from './ui/debugPanel';
import { createHud } from './ui/hud';
import { createMenuSystem, createStartGate } from './ui/menus';

const TABLE_CENTER_X = 0.381;
const TABLE_HALF_WIDTH = 0.85; // TABLE_WIDTH (1.7 m) / 2 — audio pan reference (kept per-oval; fine for both)

/** Pace/AI motor voices detune +26 cents (~+1.5%) above the player's 0. */
const PACE_DETUNE_CENTS = 26;
const MUTE_RAMP_TAU = 0.05;

/** three-space camera offset (position − lookAt) of the tuned oval view; scaled by track size for others. */
const CAM_OFFSET = { x: 0.66, y: 1.76, z: 1.24 };

const DEFAULT_CONFIG: RaceConfig = {
  mode: 'race',
  lapsToWin: 5,
  playerLane: 0,
  aiDifficulty: 0.65,
  trackId: 'oval',
  playerCar: 'p917',
};

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

// ---- Persistent (across races) ------------------------------------------
let inputManager: ReturnType<typeof createInputManager> | undefined;
let hud: ReturnType<typeof createHud> | undefined;
let debugPanel: ReturnType<typeof createDebugPanel> | undefined;
let menu: ReturnType<typeof createMenuSystem> | undefined;
let countdown: CountdownOverlay | undefined;

// Audio: created only inside the start gate's real user-gesture handler.
let engine: AudioEngine | undefined;
let sfx: Sfx | undefined;
let muted = false;

/** Reference track radius (the oval's), so the camera frames every track the same. */
let refRadius = 0;

/** A live race: track + its render objects + sim + race machine. Rebuilt per race. */
interface Session {
  config: RaceConfig;
  track: Track;
  trackMesh: TrackMesh;
  environment: Environment | undefined;
  carsView: CarsView | undefined;
  debugView: DebugView | undefined;
  sim: Sim;
  race: RaceMachine;
  carConfigs: CarConfig[];
  motorVoices: MotorVoice[];
}
let session: Session | undefined;
let racingTick = 0;
let resultsShown = false;

if (showLookDev) {
  addLookDevContent(scene);
  camera.position.set(0, 1.05, 0.72);
  camera.lookAt(0, 0, 0);
} else {
  refRadius = computeCentroid(buildTrack(TRACKS.oval.refs)).radius;
  if (showDebug) addGroundPlane();

  inputManager = createInputManager();
  hud = createHud(document.body);
  debugPanel = createDebugPanel(TUNING);
  menu = createMenuSystem(document.body);
  countdown = createCountdownOverlay(document.body);

  // A static default session sits behind the gate/menu so the table isn't empty.
  buildSession(DEFAULT_CONFIG);

  // The one valid place to unlock WebAudio — then straight into the menu.
  createStartGate(document.body, () => {
    const newEngine = createAudioEngine();
    newEngine.ensureRunning();
    engine = newEngine;
    sfx = createSfx(newEngine);
    attachVoices(); // the default session predates audio; give it voices now
    openMenu();
  });
}

function otherCar(style: CarStyleId): CarStyleId {
  return style === 'p917' ? 'f512' : 'p917';
}

/** Tear down the current session's scene objects + audio voices. */
function teardownSession(): void {
  if (!session) return;
  scene.remove(session.trackMesh.group);
  session.trackMesh.dispose();
  session.environment?.dispose();
  session.carsView?.dispose();
  session.debugView?.dispose();
  for (const voice of session.motorVoices) voice.dispose();
  session = undefined;
}

/** Build a fresh session for `config` (track mesh, cars, sim, race machine) and frame the camera. */
function buildSession(config: RaceConfig): void {
  teardownSession();

  const track = buildTrack(TRACKS[config.trackId].refs);
  const centroid = computeCentroid(track);

  const trackMesh = createTrackMesh(track);
  scene.add(trackMesh.group);

  let environment: Environment | undefined;
  let carsView: CarsView | undefined;
  let debugView: DebugView | undefined;
  const playerStyle = config.playerCar;
  const styles: CarStyleId[] =
    config.mode === 'race' ? [playerStyle, otherCar(playerStyle)] : [playerStyle];
  if (showDebug) {
    debugView = createDebugView(scene, track);
  } else {
    environment = createEnvironment(scene, keyLight, { center: centroid });
    carsView = createCarsView(scene, track, styles);
  }

  const otherLane: 0 | 1 = config.playerLane === 0 ? 1 : 0;
  const carConfigs: CarConfig[] =
    config.mode === 'race'
      ? [
          { lane: config.playerLane, controlled: 'input' },
          { lane: otherLane, controlled: 'ai', difficulty: config.aiDifficulty },
        ]
      : [{ lane: config.playerLane, controlled: 'input' }];

  // Fresh seed per race. Date.now() is fine HERE (main.ts is outside the sim);
  // the sim itself derives everything from this seed. Logged for reproducibility.
  const seed = Date.now() % 2147483647;
  // eslint-disable-next-line no-console
  console.log(
    `[race] seed=${seed} track=${config.trackId} mode=${config.mode} difficulty=${config.aiDifficulty} playerLane=${config.playerLane} car=${config.playerCar}`,
  );
  const sim = createSim({ track, cars: carConfigs, cfg: TUNING, seed });
  const race = createRace(config);

  const motorVoices = engine
    ? styles.map((_style, i) =>
        createMotorVoice(engine!, { detuneCents: i === PLAYER_CAR_INDEX ? 0 : PACE_DETUNE_CENTS }),
      )
    : [];

  session = { config, track, trackMesh, environment, carsView, debugView, sim, race, carConfigs, motorVoices };
  racingTick = 0;
  resultsShown = false;
  reframeCamera(centroid);
}

/** Give the current session motor voices (used when audio unlocks after the session was built). */
function attachVoices(): void {
  if (!session || !engine || session.motorVoices.length > 0) return;
  session.motorVoices = session.carConfigs.map((_c, i) =>
    createMotorVoice(engine!, { detuneCents: i === PLAYER_CAR_INDEX ? 0 : PACE_DETUNE_CENTS }),
  );
}

function openMenu(): void {
  menu?.openSetup(startRace); // shows over whatever session is currently on the table
}

function startRace(config: RaceConfig): void {
  buildSession(config);
  session!.race.start(); // → countdown
}

function showResults(): void {
  if (!session || !menu) return;
  const results = session.race.results();
  if (!results) return;
  const config = session.config;
  menu.openResults(results, config, {
    onRestart: () => startRace(config),
    onMenu: () => openMenu(),
  });
}

// ---- Camera framing ------------------------------------------------------

/** Sim-plane bbox centroid + radius (half the larger extent) of a track's lane 0. */
function computeCentroid(track: Track): { x: number; y: number; radius: number } {
  const lane = track.lanes[0];
  let minx = Infinity;
  let maxx = -Infinity;
  let miny = Infinity;
  let maxy = -Infinity;
  const N = 240;
  for (let i = 0; i < N; i++) {
    const p = lane.pointAt((i / N) * lane.totalLength).pos;
    minx = Math.min(minx, p.x);
    maxx = Math.max(maxx, p.x);
    miny = Math.min(miny, p.y);
    maxy = Math.max(maxy, p.y);
  }
  return { x: (minx + maxx) / 2, y: (miny + maxy) / 2, radius: Math.max(maxx - minx, maxy - miny) / 2 };
}

function reframeCamera(centroid: { x: number; y: number; radius: number }): void {
  const scale = refRadius > 0 ? centroid.radius / refRadius : 1;
  const tx = centroid.x;
  const ty = -0.02;
  const tz = -centroid.y; // sim (x, y) → three (x, ·, −y)
  camera.fov = showDebug ? 45 : 38;
  camera.near = 0.05;
  camera.far = 20;
  camera.position.set(tx + CAM_OFFSET.x * scale, ty + CAM_OFFSET.y * scale, tz + CAM_OFFSET.z * scale);
  camera.lookAt(tx, ty, tz);
  camera.updateProjectionMatrix();
}

function readQuality(value: string | null): Quality {
  return value === 'medium' || value === 'low' ? value : 'high';
}

function addGroundPlane(): void {
  const ground = new Mesh(new PlaneGeometry(3, 3), new MeshBasicMaterial({ color: '#3a3a3a' }));
  ground.rotation.x = -Math.PI / 2;
  scene.add(ground);
}

// ---- Countdown overlay ---------------------------------------------------

interface CountdownOverlay {
  set(text: string | null): void;
}
function createCountdownOverlay(host: HTMLElement): CountdownOverlay {
  const el = document.createElement('div');
  el.style.cssText = [
    'position:fixed',
    'inset:0',
    'z-index:50',
    'display:none',
    'align-items:center',
    'justify-content:center',
    'font-family:SFMono-Regular,Menlo,Consolas,monospace',
    'font-size:120px',
    'font-weight:700',
    'color:#9fd3ff',
    'text-shadow:0 4px 24px rgba(0,0,0,0.8)',
    'pointer-events:none',
    'user-select:none',
  ].join(';');
  host.appendChild(el);
  let last: string | null = null;
  return {
    set(text) {
      if (text === last) return;
      last = text;
      if (text === null) {
        el.style.display = 'none';
      } else {
        el.textContent = text;
        el.style.display = 'flex';
      }
    },
  };
}

// ---- Frame loop ----------------------------------------------------------

let pendingInput: InputFrame = { throttle: 0 };
let frameEvents: SimEvent[] = [];
let frameBeeps: { number: number; final: boolean }[] = [];

const loop = createLoop({
  step: (dt, _tick) => {
    if (!session) return;
    const phase = session.race.phase();
    if (phase === 'countdown') {
      frameBeeps.push(...session.race.tick(dt));
    } else if (phase === 'racing') {
      racingTick += 1;
      const events = session.sim.step(dt, racingTick, [pendingInput]);
      for (const e of events) session.race.handleSimEvent(e);
      frameEvents.push(...events);
    }
  },
});

function handleAudioEvents(events: SimEvent[]): void {
  if (!session || !sfx) return;
  for (const event of events) {
    if (event.type === 'deslot') {
      const x = session.sim.laneFor(event.carIndex).pointAt(event.atS).pos.x;
      sfx.deslotClatter(panForX(x, TABLE_CENTER_X, TABLE_HALF_WIDTH));
    } else if (event.type === 'lap' && event.carIndex === PLAYER_CAR_INDEX) {
      sfx.lapBeep();
    }
  }
}

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
    return { mode: 'slot', s: currState.s, slideYaw: currState.slideYaw, v: currState.v, lane: currState.lane, generation: currState.generation };
  }
  const s = wrapLerp(prevState.s, currState.s, alpha, lane.totalLength);
  const slideYaw = lerp(prevState.slideYaw, currState.slideYaw, alpha);
  return { mode: 'slot', s, slideYaw, v: currState.v, lane: currState.lane, generation: currState.generation };
}

let lastTimestamp: number | undefined;

function frame(timestamp: number): void {
  if (lastTimestamp !== undefined && session) {
    const dtFrame = (timestamp - lastTimestamp) / 1000;
    const phase = session.race.phase();

    pendingInput = {
      throttle: phase === 'racing' && inputManager ? inputManager.readPlayerThrottle(dtFrame) : 0,
    };
    frameEvents = [];
    frameBeeps = [];

    const alpha = loop.advance(dtFrame);

    for (const beep of frameBeeps) sfx?.countdownBeep(beep.final);
    handleAudioEvents(frameEvents);

    // Race finished this frame → show results once (session stays on the table).
    if (session.race.phase() === 'finished' && !resultsShown) {
      resultsShown = true;
      showResults();
    }

    const currentSim = session.sim;
    const prevStates = currentSim.prevCarStates();
    const currStates = currentSim.carStates();
    const carPoses = currStates.map((curr, i) =>
      computeCarPose(prevStates[i]!, curr, alpha, currentSim.laneFor(i)),
    );

    if (session.carsView) {
      session.carsView.update(
        currStates.map((curr, i) => computeCarRenderPose(prevStates[i]!, curr, alpha, currentSim.laneFor(i))),
      );
    } else if (session.debugView) {
      session.debugView.setCarPoses(carPoses);
    }

    currStates.forEach((state, i) => {
      const voice = session!.motorVoices[i];
      const config = session!.carConfigs[i];
      const pose = carPoses[i];
      if (!voice || !config || !pose) return;
      const throttleForVoice = config.controlled === 'input' ? pendingInput.throttle : state.v / TUNING.vmax;
      voice.update({
        v: state.v,
        throttle: throttleForVoice,
        x: pose.x,
        vmax: TUNING.vmax,
        tableHalfWidth: TABLE_HALF_WIDTH,
        centerX: TABLE_CENTER_X,
      });
    });

    // Countdown overlay.
    countdown?.set(phase === 'countdown' ? countdownText(session.race.countdownNumber()) : null);

    // HUD.
    if (hud) {
      const race = session.race;
      const isRace = session.config.mode === 'race';
      hud.update({
        lap: race.laps(PLAYER_CAR_INDEX),
        lastLapSec: race.playerLastLapSec(),
        bestLapSec: race.playerBestLapSec(),
        throttle: pendingInput.throttle,
        sourceLabel: inputManager ? inputManager.activeSourceLabel() : '',
        muted,
        lapTarget: isRace ? session.config.lapsToWin : undefined,
        opponentLap: isRace ? race.laps(AI_CAR_INDEX) : undefined,
      });
    }

    if (debugPanel) {
      const playerState = currStates[PLAYER_CAR_INDEX];
      if (playerState) debugPanel.sample({ v: playerState.v, throttle: pendingInput.throttle });
    }
  }
  lastTimestamp = timestamp;
  render();
  requestAnimationFrame(frame);
}

function countdownText(n: number): string {
  return n <= 0 ? 'GO' : String(n);
}

requestAnimationFrame(frame);

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') {
    lastTimestamp = undefined;
    loop.reset();
  }
});

// Esc during a race aborts back to the menu; 'M' toggles mute.
window.addEventListener('keydown', (event) => {
  if (event.code === 'Escape' && session) {
    const phase = session.race.phase();
    if (phase === 'countdown' || phase === 'racing') {
      session.race.abort();
      countdown?.set(null);
      openMenu();
    }
    return;
  }
  if (event.code === 'KeyM' && engine) {
    muted = !muted;
    engine.master.gain.setTargetAtTime(muted ? 0 : MASTER_GAIN, engine.ctx.currentTime, MUTE_RAMP_TAU);
  }
});
