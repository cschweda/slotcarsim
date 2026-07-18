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
import { rumbleOnDeslot, rumbleOnReslot } from './input/gamepad';
import { createInputManager } from './input/inputManager';
import { DEFAULT_DT, createLoop } from './loop';
import type { CarRenderPose, CarsView } from './render/carsView';
import { createCarsView } from './render/carsView';
import type { CarPose, DebugView } from './render/debugView';
import { createDebugView } from './render/debugView';
import type { Environment } from './render/environment';
import { createEnvironment } from './render/environment';
import { addLookDevContent } from './render/lookdev';
import { createQualityLadder, createScene, type Quality } from './render/scene';
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
import type { CalibrationOverlay, CountdownOverlay } from './ui/overlays';
import { createCalibrationOverlay, createCountdownOverlay } from './ui/overlays';

/** Pace/AI motor voices detune +26 cents (~+1.5%) above the player's 0. */
const PACE_DETUNE_CENTS = 26;
const MUTE_RAMP_TAU = 0.05;

/**
 * three-space camera offset (position − lookAt) tuned by eye for the oval at
 * the established ~60° table angle with a slight asymmetric 3/4 twist.
 * reframeCamera scales x/z independently by each track's own bbox half-extent
 * against the oval's (the calibration reference), so the oval reproduces this
 * exact offset (ratio 1:1) while other tracks — e.g. the figure-8, whose bbox
 * is nearly square rather than oval-long — get a properly fitted view instead
 * of a single uniform "radius" scale (which under-covered the figure-8's
 * greater depth extent and clipped its lower lobe off-frame).
 */
const CAM_OFFSET = { x: 0.66, y: 1.76, z: 1.24 };

const DEFAULT_CONFIG: RaceConfig = {
  mode: 'race',
  lapsToWin: 5,
  playerLane: 0,
  aiDifficulty: 0.65,
  trackId: 'oval',
  playerCar: 'p917',
};

// ---- three.js scene handle + ?query flags --------------------------------
// Populated by init() (the very bottom of this file) before any other code
// in this module runs — see init()'s own docblock for why that ordering
// makes a module-eval-time TDZ ReferenceError structurally impossible.
// Declared (rather than kept as init()-local values) because
// teardownSession/buildSession/reframeCamera/addGroundPlane/frame all need
// them too.
let scene!: ReturnType<typeof createScene>['scene'];
let camera!: ReturnType<typeof createScene>['camera'];
let keyLight!: ReturnType<typeof createScene>['keyLight'];
let render!: ReturnType<typeof createScene>['render'];
/** ?debug — reframeCamera and buildSession both branch on it. */
let showDebug = false;

// ---- Persistent (across races) ------------------------------------------
let inputManager: ReturnType<typeof createInputManager> | undefined;
let hud: ReturnType<typeof createHud> | undefined;
let debugPanel: ReturnType<typeof createDebugPanel> | undefined;
let menu: ReturnType<typeof createMenuSystem> | undefined;
let countdown: CountdownOverlay | undefined;
let calibrationOverlay: CalibrationOverlay | undefined;
/** Rolling frame-time monitor that steps DPR/shadow quality down under sustained load and back up under sustained headroom (never above ?quality). */
let qualityLadder: ReturnType<typeof createQualityLadder> | undefined;

// Audio: created only inside the start gate's real user-gesture handler.
let engine: AudioEngine | undefined;
let sfx: Sfx | undefined;
let muted = false;

/** Reference track bbox half-extents (the oval's), so the camera frames every track with the same established margin. */
let refHalfExtent = { x: 0, y: 0 };

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
  /** This track's own bbox centroid/half-width — audio pan reference (was a hardcoded oval-shaped constant). */
  audioCenterX: number;
  audioHalfWidth: number;
}
let session: Session | undefined;
let racingTick = 0;
let resultsShown = false;

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
  const bbox = computeTrackBBox(track);

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
    environment = createEnvironment(scene, keyLight, { center: { x: bbox.cx, y: bbox.cy } });
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
        createMotorVoice(engine!, { detuneCents: carConfigs[i]!.controlled !== 'input' ? PACE_DETUNE_CENTS : 0 }),
      )
    : [];

  session = {
    config,
    track,
    trackMesh,
    environment,
    carsView,
    debugView,
    sim,
    race,
    carConfigs,
    motorVoices,
    audioCenterX: bbox.cx,
    audioHalfWidth: bbox.hx,
  };
  racingTick = 0;
  resultsShown = false;
  reframeCamera(bbox);
}

/** Give the current session motor voices (used when audio unlocks after the session was built). */
function attachVoices(): void {
  if (!session || !engine || session.motorVoices.length > 0) return;
  session.motorVoices = session.carConfigs.map((c) =>
    createMotorVoice(engine!, { detuneCents: c.controlled !== 'input' ? PACE_DETUNE_CENTS : 0 }),
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
  menu.openResults(results, {
    onRestart: () => startRace(config),
    onMenu: () => openMenu(),
  });
}

// ---- Camera framing ------------------------------------------------------

interface TrackBBox {
  /** Sim-plane bbox center. */
  cx: number;
  cy: number;
  /** Sim-plane bbox half-extents (x and y axes independently — NOT blended into one radius). */
  hx: number;
  hy: number;
}

/** Sim-plane bounding box of a track's lane 0, sampled densely enough to catch every lobe/curve. */
function computeTrackBBox(track: Track): TrackBBox {
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
  return { cx: (minx + maxx) / 2, cy: (miny + maxy) / 2, hx: (maxx - minx) / 2, hy: (maxy - miny) / 2 };
}

/**
 * Frame the camera on `bbox` by scaling CAM_OFFSET's x/z components
 * INDEPENDENTLY against the oval reference's own half-extents, rather than
 * one blended "radius" ratio. The oval is x-dominant (long straights, narrow
 * width) — a single combined scale calibrated to its x extent under-covered
 * the figure-8's much greater y/depth extent (a near-square bbox) and clipped
 * its lower lobe off-frame. Scaling each axis by its own ratio reproduces the
 * exact tuned oval offset when bbox === the oval (both ratios are 1) and
 * fits every other track's true footprint with the same established margin.
 * Height (offset.y) scales by the larger of the two ratios, so the camera
 * pulls back enough to cover whichever axis grew the most.
 */
function reframeCamera(bbox: TrackBBox): void {
  const scaleX = refHalfExtent.x > 0 ? bbox.hx / refHalfExtent.x : 1;
  const scaleY = refHalfExtent.y > 0 ? bbox.hy / refHalfExtent.y : 1;
  const scaleUp = Math.max(scaleX, scaleY);
  const tx = bbox.cx;
  const ty = -0.02;
  const tz = -bbox.cy; // sim (x, y) → three (x, ·, −y)
  camera.fov = showDebug ? 45 : 38;
  camera.near = 0.05;
  camera.far = 20;
  camera.position.set(tx + CAM_OFFSET.x * scaleX, ty + CAM_OFFSET.y * scaleUp, tz + CAM_OFFSET.z * scaleY);
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

// ---- Frame loop ----------------------------------------------------------

let pendingInput: InputFrame = { throttle: 0 };
let frameEvents: SimEvent[] = [];
let frameBeeps: { number: number; final: boolean }[] = [];

/** Fixed-step accumulator driving sim.step(); populated by init(). */
let loop!: ReturnType<typeof createLoop>;

function handleAudioEvents(events: SimEvent[]): void {
  if (!session || !sfx) return;
  for (const event of events) {
    if (event.type === 'deslot') {
      const x = session.sim.laneFor(event.carIndex).pointAt(event.atS).pos.x;
      sfx.deslotClatter(panForX(x, session.audioCenterX, session.audioHalfWidth));
    } else if (event.type === 'lap' && event.carIndex === PLAYER_CAR_INDEX) {
      sfx.lapBeep();
    }
  }
}

/** Haptic feedback for the player's own car only — independent of the audio-unlock gate (works even before the start gate is clicked). */
function handleRumbleEvents(events: SimEvent[]): void {
  for (const event of events) {
    if (event.carIndex !== PLAYER_CAR_INDEX) continue;
    if (event.type === 'deslot') rumbleOnDeslot();
    else if (event.type === 'reslot') rumbleOnReslot();
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
    return { mode: 'slot', s: currState.s, slideYaw: currState.slideYaw, lane: currState.lane, generation: currState.generation };
  }
  const s = wrapLerp(prevState.s, currState.s, alpha, lane.totalLength);
  const slideYaw = lerp(prevState.slideYaw, currState.slideYaw, alpha);
  return { mode: 'slot', s, slideYaw, lane: currState.lane, generation: currState.generation };
}

let lastTimestamp: number | undefined;

function frame(timestamp: number): void {
  if (lastTimestamp !== undefined && session) {
    const dtFrame = (timestamp - lastTimestamp) / 1000;
    qualityLadder?.sample(dtFrame * 1000);
    const phase = session.race.phase();

    // Outside a race (menu, countdown), poll the gamepad directly (never the
    // keyboard, whose read() would otherwise ramp up its throttle while a
    // key is merely being held at the menu) so connection detection and the
    // calibration wizard can progress before the player ever starts racing —
    // gamepads are invisible until a button press, and the wizard is meant
    // to greet a new controller right away, not wait for a race to begin.
    if (phase === 'racing' && inputManager) {
      pendingInput = { throttle: inputManager.readPlayerThrottle(dtFrame) };
    } else {
      inputManager?.pollGamepad(dtFrame);
      pendingInput = { throttle: 0 };
    }
    frameEvents = [];
    frameBeeps = [];

    const alpha = loop.advance(dtFrame);

    for (const beep of frameBeeps) sfx?.countdownBeep(beep.final);
    handleAudioEvents(frameEvents);
    handleRumbleEvents(frameEvents);

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
      session.carsView.setBlobShadows(qualityLadder?.blobShadowsActive() ?? false);
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
        tableHalfWidth: session!.audioHalfWidth,
        centerX: session!.audioCenterX,
      });
    });

    // Countdown overlay.
    countdown?.set(phase === 'countdown' ? countdownText(session.race.countdownNumber()) : null);

    // Gamepad calibration overlay.
    calibrationOverlay?.set(
      inputManager?.gamepadCalibrating() ?? false,
      inputManager?.gamepadCalibrationSecondsLeft() ?? 0,
    );

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
        position: isRace
          ? racePosition(
              race.laps(PLAYER_CAR_INDEX),
              currStates[PLAYER_CAR_INDEX]!.s,
              race.laps(AI_CAR_INDEX),
              currStates[AI_CAR_INDEX]!.s,
            )
          : undefined,
        showGamepadHint: inputManager ? !inputManager.everSeenGamepad() : false,
      });
    }

    if (debugPanel) {
      const playerState = currStates[PLAYER_CAR_INDEX];
      if (playerState) {
        debugPanel.sample({
          v: playerState.v,
          throttle: pendingInput.throttle,
          frameMs: qualityLadder?.avgFrameMs() ?? dtFrame * 1000,
          qualityTier: qualityLadder?.tierLabel(),
        });
      }
    }
  }
  lastTimestamp = timestamp;
  render();
  requestAnimationFrame(frame);
}

function countdownText(n: number): string {
  return n <= 0 ? 'GO' : String(n);
}

/**
 * HUD race-position badge (P1/P2): more laps wins; tied laps break by
 * whoever's further along the current lap's arc length. A simple proxy for
 * "who's ahead" — not photo-finish precise across lanes of slightly
 * different length, which is plenty for a vintage-scoreboard indicator.
 */
function racePosition(playerLaps: number, playerS: number, aiLaps: number, aiS: number): 1 | 2 {
  if (playerLaps !== aiLaps) return playerLaps > aiLaps ? 1 : 2;
  return playerS >= aiS ? 1 : 2;
}

/**
 * Module entry point. Every statement that performs a real side effect
 * (DOM lookups, `new URLSearchParams`, `createScene`, `createLoop`, event
 * listener registration, `requestAnimationFrame`) used to run directly at
 * module-evaluation time, top to bottom, interleaved with this file's
 * const/let declarations — which is exactly how this file's one
 * ReferenceError crash happened (a value read before its own module-level
 * declaration had executed) and was only fixable by luck-of-ordering, not
 * structurally. Collecting every such call here, invoked once as the very
 * last statement in the file, means every module-level const/let above is
 * already initialized before ANY of this runs: a TDZ ReferenceError at
 * module-eval time becomes structurally impossible rather than something the
 * next edit could reintroduce.
 */
function init(): void {
  const container = document.getElementById('app');
  if (!container) {
    throw new Error('Missing #app container element');
  }

  const params = new URLSearchParams(window.location.search);
  const showLookDev = params.has('lookdev');
  showDebug = params.has('debug');
  const quality = readQuality(params.get('quality'));

  const sceneHandle = createScene(container, { quality });
  scene = sceneHandle.scene;
  camera = sceneHandle.camera;
  keyLight = sceneHandle.keyLight;
  render = sceneHandle.render;

  if (showLookDev) {
    addLookDevContent(scene);
    camera.position.set(0, 1.05, 0.72);
    camera.lookAt(0, 0, 0);
  } else {
    const ovalBBox = computeTrackBBox(buildTrack(TRACKS.oval.refs));
    refHalfExtent = { x: ovalBBox.hx, y: ovalBBox.hy };
    if (showDebug) addGroundPlane();

    inputManager = createInputManager();
    hud = createHud(document.body);
    debugPanel = createDebugPanel(TUNING);
    menu = createMenuSystem(document.body);
    countdown = createCountdownOverlay(document.body);
    calibrationOverlay = createCalibrationOverlay(document.body);
    qualityLadder = createQualityLadder(sceneHandle, quality);

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

  loop = createLoop({
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
        countdown?.hide();
        openMenu();
      }
      return;
    }
    if (event.code === 'KeyM' && engine) {
      muted = !muted;
      engine.master.gain.setTargetAtTime(muted ? 0 : MASTER_GAIN, engine.ctx.currentTime, MUTE_RAMP_TAU);
    }
  });
}

init();
