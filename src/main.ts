import { Mesh, MeshBasicMaterial, PlaneGeometry } from 'three';
import type { AudioEngine } from './audio/engine';
import { MASTER_GAIN, createAudioEngine } from './audio/engine';
import { panForX } from './audio/mapping';
import type { MotorVoice } from './audio/motorVoice';
import { createMotorVoice } from './audio/motorVoice';
import type { Sfx } from './audio/sfx';
import { createSfx } from './audio/sfx';
import { TRACKS } from './config/tracks';
import type { StickinessId } from './config/tuning';
import { STICKINESS_LEVELS, TUNING, applyStickiness, stepStickiness, stickinessIndex } from './config/tuning';
import type { CarStyleId } from './render/carMesh';
import type { RaceConfig, RaceMachine, TrackId } from './game/race';
import { AI_CAR_INDEX, PLAYER_CAR_INDEX, createRace, raceHasAiCar } from './game/race';
import type { Coach } from './game/coach';
import { createCoach } from './game/coach';
import { readGamepadCameraInput, rumbleOnDeslot, rumbleOnReslot } from './input/gamepad';
import { createInputManager } from './input/inputManager';
import { DEFAULT_DT, createLoop } from './loop';
import type { CarRenderPose, CarsView } from './render/carsView';
import { createCarsView } from './render/carsView';
import { ZOOM_DEFAULT, approachZoom, stepZoom, stepZoomFromStick } from './render/cameraZoom';
import { panBoundsFromBBox, stepPan, stepPanFromStick, type PanBounds } from './render/cameraPan';
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
import { createCoachWidget } from './ui/coach';
import type { CoachWidget } from './ui/coach';
import { createDebugPanel } from './ui/debugPanel';
import { createHud } from './ui/hud';
import { createMenuSystem, createStartGate } from './ui/menus';
import type { CalibrationOverlay, CountdownOverlay, MenuButton, SoundToggle } from './ui/overlays';
import { createCalibrationOverlay, createCountdownOverlay, createMenuButton, createSoundToggle } from './ui/overlays';
import { loadSoundPref, saveSoundPref } from './ui/soundPref';
import { createStatsBar } from './ui/statsBar';
import type { StatsBar, StatsBarMeasurement } from './ui/statsBar';

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
  practiceCompanion: 'alone',
  stickiness: 'authentic',
  coach: false,
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
/** The renderer's own canvas element — used only to gate click-drag panning to a pointerdown that actually landed on the canvas itself (never a DOM button/menu overlay also living inside canvasHost). */
let renderer!: ReturnType<typeof createScene>['renderer'];
/**
 * The flex:1 child both the renderer and every DOM overlay (HUD, sound/menu
 * buttons, the stats bar, menus, countdown/calibration) mount into — see
 * init()'s own docblock for the full layout rationale. Module-level (not an
 * init()-local const, unlike M9) because the click-drag pan wiring and the
 * per-frame visibleWorldWidthAtCurrentZoom() helper below both need it, and
 * the latter is called from frame(), a sibling top-level function, not a
 * nested closure of init().
 */
let canvasHost!: HTMLElement;
/** ?debug — reframeCamera and buildSession both branch on it. */
let showDebug = false;

/**
 * The current track's "unzoomed" camera framing: the lookAt point and the
 * already-per-track-scaled CAM_OFFSET (see reframeCamera). Stored (rather
 * than applied once) so the per-frame zoom multiplier can be re-applied every
 * frame without redoing the bbox/scale math — see applyCameraFraming().
 */
interface CameraFraming {
  offset: { x: number; y: number; z: number };
}
let cameraFraming: CameraFraming | undefined;
/** Mouse-wheel/pinch zoom (render/cameraZoom.ts): the wheel-driven goal and the smoothed live value applied to the camera each frame. Both reset to ZOOM_DEFAULT on every session/track rebuild — see reframeCamera(). */
let zoomTarget = ZOOM_DEFAULT;
let zoomCurrent = ZOOM_DEFAULT;
/**
 * Click-and-drag / gamepad-left-stick camera panning (render/cameraPan.ts):
 * the sim-plane (x, y) point applyCameraFraming() re-centers BOTH the
 * camera's lookAt and its position on every frame — the live, drag/stick-
 * updated replacement for what used to be CameraFraming's own fixed
 * `lookAt`. Reset to the current track's bbox center, and re-bounded, on
 * every reframeCamera() (session/track rebuild) — exactly like the zoom
 * multiplier above, so pan and zoom both reset together and independently
 * compose the rest of the time (each is just a number folded into the same
 * per-frame framing call).
 */
let panTarget = { x: 0, y: 0 };
/** This session's pan clamp range: the current track's bbox ± cameraPan.ts's PAN_MARGIN_M. Recomputed alongside panTarget in reframeCamera(). */
let panBounds: PanBounds = { minX: 0, maxX: 0, minY: 0, maxY: 0 };
/** Active click-drag pointer, or undefined when not panning — see handlePointerDown/handlePointerMove/endPan. */
let panPointerId: number | undefined;
let lastPointerX = 0;
let lastPointerY = 0;

// ---- Persistent (across races) ------------------------------------------
let inputManager: ReturnType<typeof createInputManager> | undefined;
let hud: ReturnType<typeof createHud> | undefined;
let debugPanel: ReturnType<typeof createDebugPanel> | undefined;
let menu: ReturnType<typeof createMenuSystem> | undefined;
let countdown: CountdownOverlay | undefined;
let calibrationOverlay: CalibrationOverlay | undefined;
/** Persistent top-right SOUND: ON/OFF button — created once the start gate is dismissed (see init()'s createStartGate callback), then kept for the rest of the session. */
let soundToggle: SoundToggle | undefined;
/** M10: persistent top-right MENU button, stacked below the sound toggle — created alongside it; visible only during countdown/racing (see frame()). */
let menuButton: MenuButton | undefined;
/** M10: persistent throttle-coach HUD widget — created once; visible only for a session with RaceConfig.coach on (see buildSession()). */
let coachWidget: CoachWidget | undefined;
/** M11: persistent top-center stats bar — created once; visible only during countdown/racing (see frame()). */
let statsBar: StatsBar | undefined;
/** Rolling frame-time monitor that steps DPR/shadow quality down under sustained load and back up under sustained headroom (never above ?quality). */
let qualityLadder: ReturnType<typeof createQualityLadder> | undefined;
/** M11: this session's own deslot tallies (player / AI), fed to the stats bar — reset in buildSession(), incremented on 'deslot' sim events (handleCrashEvents). */
let playerCrashes = 0;
let aiCrashes = 0;
/** M11: exponentially-smoothed render fps (independent of any session — a rendering-loop property, not sim state, so it is NOT reset on rebuild). */
let fpsEma = 60;
/** M11: smoothing factor for fpsEma's per-frame exponential update — small enough to stay readable, responsive enough to reflect a real quality-tier step within a second or so. */
const FPS_SMOOTHING = 0.1;

// Audio: created only inside the start gate's real user-gesture handler.
let engine: AudioEngine | undefined;
let sfx: Sfx | undefined;
/**
 * Sound defaults OFF (this placeholder is overwritten from the persisted
 * preference early in init() — see `muted = !loadSoundPref()` — before the
 * start gate can ever be dismissed, so this literal is never actually
 * observed; it's set to the spec'd default here purely so this declaration
 * doesn't itself lie about that default if anything ever reads it earlier).
 */
let muted = true;

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
  /** M10: undefined unless this session's RaceConfig.coach is on — built for the player's own lane only. */
  coach: Coach | undefined;
}
let session: Session | undefined;
let racingTick = 0;
let resultsShown = false;
/** M10: this session's CURRENT stickiness level — starts at config.stickiness, then tracks every practice-mode [ ]/[ ] live-adjust (see the keydown handler). */
let currentStickiness: StickinessId = 'authentic';

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

  // M10: stickiness is applied to the SHARED TUNING singleton — the exact
  // ?tune live-mutation pattern (config/tuning.ts's applyStickiness mutates
  // gripSoft/gripHard in place) — so it's already in effect before createSim
  // and createCoach below ever read cfg, and a later dev ?tune slider drag
  // still works normally against whatever level this session applied.
  applyStickiness(TUNING, config.stickiness);
  currentStickiness = config.stickiness;

  const track = buildTrack(TRACKS[config.trackId].refs);
  const bbox = computeTrackBBox(track);

  const trackMesh = createTrackMesh(track);
  scene.add(trackMesh.group);

  let environment: Environment | undefined;
  let carsView: CarsView | undefined;
  let debugView: DebugView | undefined;
  const playerStyle = config.playerCar;
  const hasAi = raceHasAiCar(config);
  const styles: CarStyleId[] = hasAi ? [playerStyle, otherCar(playerStyle)] : [playerStyle];
  if (showDebug) {
    debugView = createDebugView(scene, track);
  } else {
    environment = createEnvironment(scene, keyLight, { center: { x: bbox.cx, y: bbox.cy } });
    carsView = createCarsView(scene, track, styles);
  }

  const otherLane: 0 | 1 = config.playerLane === 0 ? 1 : 0;
  const carConfigs: CarConfig[] = hasAi
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
    `[race] seed=${seed} track=${config.trackId} mode=${config.mode} difficulty=${config.aiDifficulty} playerLane=${config.playerLane} car=${config.playerCar} stickiness=${config.stickiness} coach=${config.coach}`,
  );
  const sim = createSim({ track, cars: carConfigs, cfg: TUNING, seed });
  const race = createRace(config);
  const coach = config.coach ? createCoach(track.lanes[config.playerLane], TUNING) : undefined;
  coachWidget?.setVisible(config.coach);
  // Fix round 1: COACH's own presence (hence the stats bar's left-neighbor
  // width) varies by mode/session — re-measure now that setVisible() above
  // has taken effect, rather than trusting whatever layout was true before
  // this rebuild.
  statsBar?.reposition();

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
    coach,
  };
  racingTick = 0;
  resultsShown = false;
  playerCrashes = 0;
  aiCrashes = 0;
  reframeCamera(bbox);
}

/** Give the current session motor voices (used when audio unlocks after the session was built). */
function attachVoices(): void {
  if (!session || !engine || session.motorVoices.length > 0) return;
  session.motorVoices = session.carConfigs.map((c) =>
    createMotorVoice(engine!, { detuneCents: c.controlled !== 'input' ? PACE_DETUNE_CENTS : 0 }),
  );
}

/** Applies the current `muted` flag to the live engine's master gain via the existing glide (never a raw `.value=` jump, to avoid a click). Called once right after the engine is constructed — which always starts unmuted (`master.gain.value = MASTER_GAIN` in audio/engine.ts) regardless of the loaded preference — and again on every toggleSound(). */
function applyMuted(): void {
  if (!engine) return;
  engine.master.gain.setTargetAtTime(muted ? 0 : MASTER_GAIN, engine.ctx.currentTime, MUTE_RAMP_TAU);
}

/** Flips `muted`, applies it, and persists the choice. The single path both the 'M' key and the corner button's click funnel through, so the two can never disagree about the current state — each call ends by pushing the new state back to the button via soundToggle.set(). */
function toggleSound(): void {
  muted = !muted;
  applyMuted();
  saveSoundPref(!muted);
  soundToggle?.set(!muted);
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

/**
 * Abandon a live race and return to the menu — the ONE path both Esc and the
 * M10 on-screen MENU button funnel through, so the two can never disagree
 * about what "abort" does. A no-op outside countdown/racing (e.g. a stray
 * click while idle or on the results screen, both of which have their own
 * way back already).
 */
function abortToMenu(): void {
  if (!session) return;
  const phase = session.race.phase();
  if (phase !== 'countdown' && phase !== 'racing') return;
  session.race.abort();
  countdown?.hide();
  openMenu();
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
 *
 * Stores the result as `cameraFraming` (just the scaled offset — the lookAt
 * itself now lives in `panTarget`, below) rather than setting
 * `camera.position` directly — `applyCameraFraming()` does that, scaled by
 * the live mouse-wheel zoom multiplier, every frame. Also resets the zoom to
 * ZOOM_DEFAULT and the pan target to this bbox's own center (with a freshly
 * computed clamp range): a session/track rebuild is exactly the brief's
 * "reset zoom/pan on every session/track rebuild" trigger (this is the only
 * place buildSession calls into camera framing).
 */
function reframeCamera(bbox: TrackBBox): void {
  const scaleX = refHalfExtent.x > 0 ? bbox.hx / refHalfExtent.x : 1;
  const scaleY = refHalfExtent.y > 0 ? bbox.hy / refHalfExtent.y : 1;
  const scaleUp = Math.max(scaleX, scaleY);
  camera.fov = showDebug ? 45 : 38;
  camera.near = 0.05;
  camera.far = 20;
  camera.updateProjectionMatrix();
  cameraFraming = {
    offset: { x: CAM_OFFSET.x * scaleX, y: CAM_OFFSET.y * scaleUp, z: CAM_OFFSET.z * scaleY },
  };
  zoomTarget = ZOOM_DEFAULT;
  zoomCurrent = ZOOM_DEFAULT;
  panTarget = { x: bbox.cx, y: bbox.cy };
  panBounds = panBoundsFromBBox(bbox);
  applyCameraFraming();
}

/**
 * How many world meters span canvasHost's full CSS-pixel width at the
 * CURRENT zoomed camera distance — render/cameraPan.ts's screenDeltaToWorld()
 * / stepPanFromStick() input for a 1:1 drag feel at any zoom. Standard
 * perspective-camera geometry: the visible height at a given distance is
 * `2 · distance · tan(vFov/2)`; width follows from the canvas aspect. Not
 * cached — it depends on the live `zoomCurrent`, which eases every frame
 * independent of any drag/stick input.
 */
function visibleWorldWidthAtCurrentZoom(): number {
  if (!cameraFraming) return 0;
  const { offset } = cameraFraming;
  const distance = Math.hypot(offset.x, offset.y, offset.z) * zoomCurrent;
  const vFovRad = (camera.fov * Math.PI) / 180;
  const visibleHeight = 2 * distance * Math.tan(vFovRad / 2);
  const aspect = canvasHost.clientWidth / canvasHost.clientHeight;
  return visibleHeight * aspect;
}

/**
 * Sets `camera.position`/`lookAt` from `cameraFraming`'s offset and the live
 * `panTarget` (sim (x, y) → three (x, ·, −y), the same convention
 * reframeCamera's old fixed lookAt used), scaling the offset's length by
 * `zoomCurrent` (1.0 = the fitted framing reframeCamera computed; smaller =
 * zoomed in/closer, larger = zoomed out). Called once by reframeCamera() and
 * again every frame thereafter as `zoomCurrent` eases toward `zoomTarget`
 * and/or `panTarget` moves via drag or the gamepad stick (see frame()) —
 * cheap (position/lookAt only, no updateProjectionMatrix — neither zoom nor
 * pan ever changes fov/aspect/clipping).
 */
function applyCameraFraming(): void {
  if (!cameraFraming) return;
  const { offset } = cameraFraming;
  const lookAtX = panTarget.x;
  const lookAtY = -0.02;
  const lookAtZ = -panTarget.y;
  camera.position.set(
    lookAtX + offset.x * zoomCurrent,
    lookAtY + offset.y * zoomCurrent,
    lookAtZ + offset.z * zoomCurrent,
  );
  camera.lookAt(lookAtX, lookAtY, lookAtZ);
}

/** Ends an active click-drag pan (pointerup/pointercancel) — releases capture and restores the grab cursor. */
function endPan(event: PointerEvent): void {
  if (panPointerId === undefined || event.pointerId !== panPointerId) return;
  panPointerId = undefined;
  if (canvasHost.hasPointerCapture(event.pointerId)) canvasHost.releasePointerCapture(event.pointerId);
  canvasHost.style.cursor = 'grab';
}

/**
 * Starts a click-drag pan — but ONLY when the pointerdown's own target is
 * the renderer's canvas element itself, never any DOM overlay also living
 * inside canvasHost (the SOUND/MENU buttons, an open setup/results menu —
 * see init()'s docblock on why those are siblings-in-the-DOM-tree but
 * visually "above" the canvas). The HUD/countdown/calibration overlays set
 * `pointer-events: none`, so a drag starting over them naturally falls
 * through to the canvas underneath and IS captured, same as everywhere else
 * on the table. Ignores a second pointer while already panning (e.g. a
 * second touch) and any non-primary button/contact.
 */
function handlePointerDown(event: PointerEvent): void {
  if (panPointerId !== undefined) return;
  if (event.target !== renderer.domElement || event.button !== 0) return;
  event.preventDefault();
  panPointerId = event.pointerId;
  lastPointerX = event.clientX;
  lastPointerY = event.clientY;
  canvasHost.setPointerCapture(event.pointerId);
  canvasHost.style.cursor = 'grabbing';
}

function handlePointerMove(event: PointerEvent): void {
  if (panPointerId === undefined || event.pointerId !== panPointerId) return;
  const dx = event.clientX - lastPointerX;
  const dy = event.clientY - lastPointerY;
  lastPointerX = event.clientX;
  lastPointerY = event.clientY;
  panTarget = stepPan(panTarget, dx, dy, visibleWorldWidthAtCurrentZoom(), canvasHost.clientWidth, panBounds);
}

/**
 * Fix round 1 (post-M11a review): the stats bar's own left/right reserve is
 * now measured from the REAL current layout instead of hand-tuned constants
 * — see statsBar.ts's `computeStatsBarBounds` for the derivation. This is
 * the one function that knows WHICH real elements count as "the left-stack
 * neighbor" (COACH's own edge when the session has it on, else HUD's — via
 * Math.max, so a hidden COACH's zero rect naturally loses) and "the
 * SOUND/MENU button column" (SOUND's own element, since it — unlike MENU —
 * is always visible once created, so it's a reliable thing to measure even
 * outside a live session). Passed to createStatsBar once; invoked by the
 * bar itself on mount, and by this file on window resize and on every
 * session rebuild (see those call sites).
 */
function measureStatsBarBounds(): StatsBarMeasurement {
  const hostRect = canvasHost.getBoundingClientRect();
  const hudRight = hud?.root.getBoundingClientRect().right ?? 0;
  const coachRight = coachWidget?.root.getBoundingClientRect().right ?? 0;
  return {
    hostLeft: hostRect.left,
    hostRight: hostRect.right,
    leftNeighborRight: Math.max(hudRight, coachRight),
    rightNeighborLeft: soundToggle?.root.getBoundingClientRect().left ?? 0,
  };
}

/** Tallies deslot sim events into the stats bar's session counters — the player's own and (if this session has a second car) the AI's. */
function handleCrashEvents(events: SimEvent[]): void {
  for (const event of events) {
    if (event.type !== 'deslot') continue;
    if (event.carIndex === PLAYER_CAR_INDEX) playerCrashes += 1;
    else aiCrashes += 1;
  }
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

    // M11: rolling (exponentially-smoothed) render fps for the stats bar —
    // independent of session/race state, so it's never reset on a rebuild.
    if (dtFrame > 0) {
      const instantFps = 1 / dtFrame;
      fpsEma = fpsEma + (instantFps - fpsEma) * FPS_SMOOTHING;
    }

    // Ease the live zoom toward the wheel-driven target every frame,
    // independent of race phase — zoom works in the menu/countdown too, not
    // just mid-race.
    zoomCurrent = approachZoom(zoomCurrent, zoomTarget, dtFrame);
    applyCameraFraming();

    const phase = session.race.phase();
    const liveSession = phase === 'countdown' || phase === 'racing';

    // M11: gamepad camera sticks — standard-mapping pads only (see
    // input/gamepad.ts's readGamepadCameraInput), left stick pans, right
    // stick vertical zooms. Gated to a live session only, same as the stats
    // bar below — sticks stay quiet at the menu/results screens (which have
    // no gamepad navigation of their own to fight anyway, but drifting the
    // camera behind a modal that already covers the whole canvas would just
    // be pointless). Composes with wheel zoom / click-drag pan for free —
    // it's folded into the exact same zoomTarget/panTarget this frame's
    // easing above already reads.
    if (liveSession) {
      const stick = readGamepadCameraInput();
      if (stick) {
        panTarget = stepPanFromStick(panTarget, stick.panX, stick.panY, dtFrame, visibleWorldWidthAtCurrentZoom(), panBounds);
        zoomTarget = stepZoomFromStick(zoomTarget, stick.zoom, dtFrame);
      }
    }

    // M10: the on-screen MENU button is only useful (and only shown) while a
    // race is actually live — the menu/results screens already have their
    // own way back.
    menuButton?.setVisible(liveSession);

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
    handleCrashEvents(frameEvents);

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

    // Contract: voices are silenced outside the racing phase. During
    // countdown the cars are parked at v=0 anyway (zeros are harmless and
    // consistent), but once a race ends (finished) or is Esc-aborted (idle)
    // the sim stops advancing while this render loop keeps calling
    // voice.update() every frame — feeding it the now-frozen state.v would
    // leave the motors humming at a constant pitch forever behind the
    // results/abort overlay. Zeroing v/throttle instead lets each voice's
    // τ=0.03 setTargetAtTime glide fade them out naturally. This re-reads
    // phase() fresh (rather than reusing this frame's `phase` local, read
    // before loop.advance() above) so a race that finishes mid-frame goes
    // silent that same frame instead of one frame late.
    const racing = session.race.phase() === 'racing';
    currStates.forEach((state, i) => {
      const voice = session!.motorVoices[i];
      const config = session!.carConfigs[i];
      const pose = carPoses[i];
      if (!voice || !config || !pose) return;
      const throttleForVoice = config.controlled === 'input' ? pendingInput.throttle : state.v / TUNING.vmax;
      voice.update({
        v: racing ? state.v : 0,
        throttle: racing ? throttleForVoice : 0,
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

    // M10: throttle coach — fed the player's own INTERPOLATED (s, v), same
    // smoothing as the render pose, so the gauge doesn't step at 120Hz.
    if (session.coach && coachWidget) {
      const playerLane = currentSim.laneFor(PLAYER_CAR_INDEX);
      const playerPrev = prevStates[PLAYER_CAR_INDEX]!;
      const playerCurr = currStates[PLAYER_CAR_INDEX]!;
      const s = wrapLerp(playerPrev.s, playerCurr.s, alpha, playerLane.totalLength);
      const v = lerp(playerPrev.v, playerCurr.v, alpha);
      coachWidget.update(session.coach.advise({ s, v }, dtFrame));
    }

    // HUD.
    if (hud) {
      const race = session.race;
      const isRace = session.config.mode === 'race';
      const hasAi = raceHasAiCar(session.config);
      hud.update({
        lap: race.laps(PLAYER_CAR_INDEX),
        lastLapSec: race.playerLastLapSec(),
        bestLapSec: race.playerBestLapSec(),
        throttle: pendingInput.throttle,
        sourceLabel: inputManager ? inputManager.activeSourceLabel() : '',
        practice: session.config.mode === 'practice',
        lapTarget: isRace ? session.config.lapsToWin : undefined,
        opponentLap: hasAi ? race.laps(AI_CAR_INDEX) : undefined,
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

    // M11: top-center stats bar — speed updates every frame, counters track
    // this session's own tallies (laps from the race machine, crashes from
    // handleCrashEvents above), visible only during countdown/racing (any
    // mode) same as the on-screen MENU button.
    if (statsBar) {
      const playerState = currStates[PLAYER_CAR_INDEX];
      const hasAi = raceHasAiCar(session.config);
      statsBar.update({
        speedMs: playerState ? playerState.v : 0,
        laps: session.race.laps(PLAYER_CAR_INDEX),
        crashes: playerCrashes,
        aiCrashes: hasAi ? aiCrashes : undefined,
        fps: fpsEma,
      });
      statsBar.setVisible(liveSession);
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

  // `#app` is a horizontal flex row (index.html) so the dev tuning panel
  // (createDebugPanel, below) can dock as a right-hand sibling COLUMN
  // without ever overlaying the 3D view (M9 follow-up — it used to be a
  // fixed-position overlay on top of the canvas). canvasHost is the flex:1
  // child the renderer actually fills; when the panel isn't rendered
  // (production without ?tune — createDebugPanel's own shouldRender() gate
  // gets the final say) canvasHost is #app's ONLY child and fills 100% of
  // it, identical to the old plain (non-flex) layout.
  //
  // `contain: layout` makes canvasHost the containing block for every
  // position:fixed overlay mounted into it below (HUD, sound toggle,
  // countdown, calibration wizard, the menus/gate) — so their top/right/
  // inset values resolve against the CANVAS's own box, not the full window,
  // and correctly stop short of the panel column's width instead of drifting
  // under it. It also — unavoidably, the two are a package deal in CSS —
  // gives canvasHost its own stacking context, which is harmless here only
  // because EVERY z-indexed overlay now lives inside it, so their relative
  // stacking order (hud 10 < countdown 50 < calibration 60 < menus/gate
  // 100 < sound toggle/reopen tab 110) is preserved exactly as before.
  canvasHost = document.createElement('div');
  canvasHost.id = 'canvas-host';
  Object.assign(canvasHost.style, {
    position: 'relative',
    flex: '1 1 auto',
    minWidth: '0', // flexbox's default min-width:auto can otherwise refuse to shrink the canvas below its last-rendered width
    height: '100%',
    overflow: 'hidden',
    contain: 'layout',
    cursor: 'grab', // M11: click-and-drag camera pan is available everywhere on the canvas; overlay buttons/dialogs set their own `cursor: pointer` and win the cascade over this inherited value
    touchAction: 'none', // let pointer events (not the browser's native touch-scroll/pinch) own gestures over the canvas — same reasoning three.js's own OrbitControls uses
  });
  container.appendChild(canvasHost);

  const sceneHandle = createScene(canvasHost, { quality });
  scene = sceneHandle.scene;
  camera = sceneHandle.camera;
  keyLight = sceneHandle.keyLight;
  render = sceneHandle.render;
  renderer = sceneHandle.renderer;

  if (showLookDev) {
    addLookDevContent(scene);
    camera.position.set(0, 1.05, 0.72);
    camera.lookAt(0, 0, 0);
  } else {
    const ovalBBox = computeTrackBBox(buildTrack(TRACKS.oval.refs));
    refHalfExtent = { x: ovalBBox.hx, y: ovalBBox.hy };
    if (showDebug) addGroundPlane();

    // Default-off sound preference, read once up front — independent of the
    // audio engine's own lifecycle (that doesn't exist until the gate is
    // dismissed) so both the gate's copy and the corner button's initial
    // label are correct on the very first paint.
    muted = !loadSoundPref();

    inputManager = createInputManager();
    hud = createHud(canvasHost);
    // measureStatsBarBounds reads hud/coachWidget/soundToggle by closing over
    // their module-level `let` bindings, so it's safe to pass here even
    // though coachWidget/soundToggle are both still undefined at this exact
    // line (createStatsBar's own mount-time reposition() call just measures
    // them as "not present yet", which is literally true right now, and
    // gets corrected by the buildSession()/resize reposition() calls below
    // once they exist).
    statsBar = createStatsBar(canvasHost, measureStatsBarBounds);
    coachWidget = createCoachWidget(canvasHost);
    debugPanel = createDebugPanel(container, canvasHost, TUNING);
    menu = createMenuSystem(canvasHost);
    countdown = createCountdownOverlay(canvasHost);
    calibrationOverlay = createCalibrationOverlay(canvasHost);
    qualityLadder = createQualityLadder(sceneHandle, quality);

    // Fix round 1: the stats bar's left/right reserve depends on the real
    // layout of its neighbors, which a browser window resize can change
    // (independent of any session rebuild) — re-measure whenever that
    // happens. Scoped to this branch (like the rest of the overlay wiring)
    // since statsBar only exists here, never in ?lookdev mode.
    window.addEventListener('resize', () => statsBar?.reposition());

    // Mouse-wheel/trackpad-pinch zoom (render/cameraZoom.ts). Listens on
    // canvasHost SPECIFICALLY (never window/document) — canvasHost and the
    // docked tuning panel column are siblings, not ancestor/descendant, so a
    // wheel event over the panel (scrolling its own overflow-y content)
    // never reaches this listener at all; nothing needs to explicitly
    // exclude it. `passive: false` + preventDefault() stops the browser's
    // own page-scroll/ctrl-wheel-zoom over the canvas. Trackpad pinch
    // gestures arrive as wheel events with ctrlKey set — treated the same,
    // just more sensitive (stepZoom's `pinch` option).
    canvasHost.addEventListener(
      'wheel',
      (event) => {
        event.preventDefault();
        zoomTarget = stepZoom(zoomTarget, event.deltaY, { pinch: event.ctrlKey });
      },
      { passive: false },
    );

    // Click-and-drag camera pan (render/cameraPan.ts). Listens on canvasHost
    // SPECIFICALLY, same as the wheel zoom above, but ALSO gates on the
    // pointerdown's own target being the renderer's canvas element itself —
    // see handlePointerDown's own doc comment for why that's what keeps a
    // click on the SOUND/MENU buttons or an open menu from ever starting a
    // drag. setPointerCapture means the drag keeps tracking even if the
    // cursor leaves the canvas (or the window) before releasing.
    canvasHost.addEventListener('pointerdown', handlePointerDown);
    canvasHost.addEventListener('pointermove', handlePointerMove);
    canvasHost.addEventListener('pointerup', endPan);
    canvasHost.addEventListener('pointercancel', endPan);

    // A static default session sits behind the gate/menu so the table isn't empty.
    buildSession(DEFAULT_CONFIG);

    // The one valid place to unlock WebAudio — then straight into the menu.
    createStartGate(canvasHost, !muted, () => {
      const newEngine = createAudioEngine();
      newEngine.ensureRunning();
      engine = newEngine;
      sfx = createSfx(newEngine);
      attachVoices(); // the default session predates audio; give it voices now
      applyMuted(); // silence the fresh (always-unmuted-by-construction) engine if the loaded/default preference is off
      soundToggle = createSoundToggle(canvasHost, { initialOn: !muted, onToggle: toggleSound });
      menuButton = createMenuButton(canvasHost, abortToMenu);
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

  // Esc (or the on-screen MENU button, same abortToMenu() path) aborts back
  // to the menu; 'M' toggles mute; '[' / ']' live-step stickiness — practice
  // mode only, while actually racing (see the M10 brief).
  window.addEventListener('keydown', (event) => {
    if (event.code === 'Escape') {
      abortToMenu();
      return;
    }
    if (event.code === 'KeyM' && engine) {
      toggleSound();
      return;
    }
    if (event.code === 'BracketLeft' || event.code === 'BracketRight') {
      if (!session || session.config.mode !== 'practice' || session.race.phase() !== 'racing') return;
      const dir = event.code === 'BracketRight' ? 1 : -1;
      const nextId = stepStickiness(currentStickiness, dir);
      if (nextId === currentStickiness) return; // already clamped at this end
      currentStickiness = nextId;
      applyStickiness(TUNING, nextId);
      session.coach?.recompute(TUNING);
      const level = STICKINESS_LEVELS[stickinessIndex(nextId)]!;
      hud?.flashMessage(level.label.toUpperCase());
    }
  });
}

init();
