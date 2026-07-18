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
import type { ReplayBuffer, ReplayFrame, ReplayPlayback } from './game/replay';
import { DEFAULT_REPLAY_SPEED, createReplayBuffer, createReplayPlayback } from './game/replay';
import { readGamepadCameraInput, rumbleOnDeslot, rumbleOnReslot } from './input/gamepad';
import { createInputManager } from './input/inputManager';
import { DEFAULT_DT, createLoop } from './loop';
import type { CarsView } from './render/carsView';
import { createCarsView } from './render/carsView';
import { ZOOM_DEFAULT, approachZoom, stepZoom, stepZoomFromStick } from './render/cameraZoom';
import { panBoundsFromBBox, stepPan, stepPanFromStick, type PanBounds } from './render/cameraPan';
import { createCameraRig } from './render/cameraRig';
import { computeCarPose, computeCarRenderPose } from './render/carPose';
import type { DebugView } from './render/debugView';
import { createDebugView } from './render/debugView';
import type { Environment } from './render/environment';
import { createEnvironment } from './render/environment';
import { addLookDevContent } from './render/lookdev';
import { createQualityLadder, createScene, type Quality } from './render/scene';
import type { TrackMesh } from './render/trackMesh';
import { createTrackMesh } from './render/trackMesh';
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
import type {
  CalibrationOverlay,
  CameraButton,
  CountdownOverlay,
  MenuButton,
  ReplayBanner,
  ReplayButton,
  SoundToggle,
} from './ui/overlays';
import {
  createCalibrationOverlay,
  createCameraButton,
  createCountdownOverlay,
  createMenuButton,
  createReplayBanner,
  createReplayButton,
  createSoundToggle,
} from './ui/overlays';
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
/** M11b: persistent top-right REPLAY button, stacked below MENU — created alongside it; visible whenever a replay could start or one is already playing (see frame()). */
let replayButton: ReplayButton | undefined;
/**
 * M13: the camera-view rig (table / chase / cockpit + cockpit ½× time). Owns
 * the selected view + the camera's position/lookAt/up/near/fov while a
 * chase/cockpit frame is active; the existing applyCameraFraming() keeps the
 * table view, zoom, and pan unchanged. Created once per session lifetime (not
 * per race — the selected view persists across rebuilds), only when cars are
 * actually rendered (never in ?debug's box view). undefined ⇒ table only.
 */
let cameraRig: ReturnType<typeof createCameraRig> | undefined;
/** M13: persistent top-right VIEW button, stacked below REPLAY — cycles the camera view (same path as the `C` key). */
let cameraButton: CameraButton | undefined;
/** M11b: persistent top-center "REPLAY" banner + progress bar — created once (doesn't need the audio-unlock gesture, unlike the buttons above), shown only while a replay is actually playing. */
let replayBanner: ReplayBanner | undefined;
/** M10: persistent throttle-coach HUD widget — created once; visible only for a session with RaceConfig.coach on (see buildSession()), and hidden for the duration of a replay regardless (see frame()). */
let coachWidget: CoachWidget | undefined;
/** M11: persistent top-center stats bar — created once; visible only during countdown/racing (see frame()); its update() is skipped (not hidden) during a replay, so it reads as frozen. */
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

// ---- M11b: instant replay -------------------------------------------------
// Freeze-world replay of the last few seconds: the sim (and race machine,
// and player input) simply stop being fed ticks for the duration — the rAF
// render loop keeps running, driven instead by a captured window of
// previously-recorded ticks — so lap timing/tick count are unaffected BY
// CONSTRUCTION once live stepping resumes (zero ticks were ever lost; the
// sim just wasn't asked to advance). Camera (zoom/pan, wheel/drag/gamepad
// stick) is untouched by any of this — see frame()'s own docs on why that
// wiring lives outside every `inReplay` branch below.

/** How much history the ring buffer holds, independent of how much any one replay actually plays back (see REPLAY_WINDOW_SEC) — a little slack beyond the window so a slightly-late R press still catches the whole moment. */
const REPLAY_CAPACITY_SEC = 6;
/** How much of the buffer's most recent history a triggered replay actually plays — long enough to show the run-up to a mistake, not just its aftermath (a 2.0s tumble: 1.1s tumbling + 0.9s marshal wait, per config/tuning.ts, plus 1s of pre-roll). */
const REPLAY_WINDOW_SEC = 3;
/** R/the REPLAY button are ignored until the buffer holds at least this much — a fraction-of-a-second buffer would "replay" almost nothing. */
const REPLAY_MIN_SEC = 0.5;
/** Wall-clock hold once natural playback completes before live sim stepping resumes — long enough to read as a deliberate pause, not a jump-cut. */
const REPLAY_HOLD_SEC = 0.4;

/** Every racing tick's states (+ that tick's player throttle) — recorded from the loop's own step callback (see init()), cleared on every session rebuild (see buildSession()). */
let replayBuffer: ReplayBuffer = createReplayBuffer(REPLAY_CAPACITY_SEC, DEFAULT_DT);

/** A currently-playing replay: the captured window it's playing back, the playback cursor driving it, and how long it's been holding since natural completion (see REPLAY_HOLD_SEC) — undefined whenever no replay is active, which frame() treats as "step/render the live sim as normal". */
interface ActiveReplay {
  frames: ReplayFrame[];
  playback: ReplayPlayback;
  holdElapsedSec: number;
}
let activeReplay: ActiveReplay | undefined;

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
  exitReplay(); // a rebuilt session's sim/race are brand new — any replay of the PREVIOUS one no longer means anything.
  replayBuffer.clear();
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
  exitReplay(); // the MENU button (unlike Esc — see init()'s keydown handler) isn't itself gated on replay state, so abandoning the race must also clean up any replay left showing.
  session.race.abort();
  countdown?.hide();
  openMenu();
}

// ---- Instant replay --------------------------------------------------------

/**
 * Whether R/the REPLAY button could actually start a replay right now: a
 * live race actually racing (not countdown/menu/gate), with the buffer past
 * REPLAY_MIN_SEC. Shared by enterReplay()'s own guard and frame()'s button-
 * visibility check, so the two can never quietly drift out of sync.
 */
function replayIsEligible(): boolean {
  return !!session && session.race.phase() === 'racing' && replayBuffer.size() * DEFAULT_DT >= REPLAY_MIN_SEC;
}

/**
 * Begins playing back the last REPLAY_WINDOW_SEC of recorded ticks. Silently
 * ignored (per the brief) unless replayIsEligible() and one isn't already
 * active — so a stray R press at the menu, during countdown, or moments
 * after a fresh session rebuild simply does nothing.
 */
function enterReplay(): void {
  if (activeReplay || !replayIsEligible()) return;
  const frames = replayBuffer.window(REPLAY_WINDOW_SEC);
  if (frames.length < 2) return; // nothing to interpolate between
  activeReplay = {
    frames,
    playback: createReplayPlayback(frames, { speed: DEFAULT_REPLAY_SPEED, dt: DEFAULT_DT }),
    holdElapsedSec: 0,
  };
  replayBanner?.set(true, 0);
}

/** Ends the current replay — early exit (R/Esc/REPLAY button) or the post-completion hold expiring (see frame()) — and resumes live sim stepping from exactly where it froze. A no-op if none is active. */
function exitReplay(): void {
  if (!activeReplay) return;
  activeReplay = undefined;
  replayBanner?.set(false, 0);
}

/** The ONE path both the 'R' key and the REPLAY button's click funnel through — enters a replay if none is active, ends the current one early otherwise — so the two can never disagree about what a press/click does. */
function toggleReplay(): void {
  if (activeReplay) exitReplay();
  else enterReplay();
}

// ---- M13: camera view --------------------------------------------------------

/** Refresh the VIEW button's label from the rig's current selected view + cockpit ½×/1× state. */
function syncCameraButton(): void {
  if (cameraRig) cameraButton?.set(cameraRig.mode(), !cameraRig.cockpitFullSpeed());
}

/** The ONE path both the 'C' key and the VIEW button's click funnel through — cycles table → chase → cockpit → table, flashing the new view's name. */
function cycleCameraView(): void {
  if (!cameraRig) return;
  const next = cameraRig.cycle();
  syncCameraButton();
  const label = next === 'cockpit' ? 'COCKPIT ½×' : next.toUpperCase();
  hud?.flashMessage(`VIEW · ${label}`);
}

/** The ONE path the 'T' key funnels through — toggles cockpit ½× ↔ full speed (a no-op outside cockpit). */
function toggleCockpitSpeed(): void {
  if (!cameraRig || cameraRig.mode() !== 'cockpit') return;
  const full = cameraRig.toggleCockpitSpeed();
  syncCameraButton();
  hud?.flashMessage(full ? 'FULL SPEED · 1×' : 'HALF SPEED · ½×');
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
  // M13: click-drag pan is TABLE-MODE ONLY — chase/cockpit is a follow camera.
  if (cameraRig && cameraRig.mode() !== 'table') return;
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

    // M13: the table view's zoom-ease + framing now happens in the unified
    // camera block below (after the player pose is computed), so the chase/
    // cockpit rig can take the camera over instead when either is selected.
    // Zoom/pan stay TABLE-ONLY — see that block and the wheel/drag guards.

    const phase = session.race.phase();
    const liveSession = phase === 'countdown' || phase === 'racing';
    const inReplay = activeReplay !== undefined;

    // M11: gamepad camera sticks — standard-mapping pads only (see
    // input/gamepad.ts's readGamepadCameraInput), left stick pans, right
    // stick vertical zooms. Gated to a live session only, same as the stats
    // bar below — sticks stay quiet at the menu/results screens (which have
    // no gamepad navigation of their own to fight anyway, but drifting the
    // camera behind a modal that already covers the whole canvas would just
    // be pointless). Composes with wheel zoom / click-drag pan for free —
    // it's folded into the exact same zoomTarget/panTarget this frame's
    // easing above already reads. M11b: deliberately UNGATED by `inReplay` —
    // the camera (this, plus the wheel/drag listeners in init()) stays FULLY
    // LIVE during a replay; that's the feature's entire point.
    // M13: zoom/pan are TABLE-MODE ONLY — in chase/cockpit the rig owns the
    // camera, so the left/right sticks go quiet (they'd otherwise fight the
    // follow). `cameraRig.mode()` is the SELECTED view, so a deslot's momentary
    // snap-to-table doesn't re-enable them mid-tumble.
    const tableSelected = !cameraRig || cameraRig.mode() === 'table';
    if (liveSession && tableSelected) {
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
    // M11b: the REPLAY button is visible whenever it could start a replay
    // OR one is already playing — the SAME button both starts and (via
    // toggleReplay) ends one early, so it must stay visible/clickable
    // throughout, not just at the moment it became eligible.
    replayButton?.setVisible(liveSession && (inReplay || replayIsEligible()));
    // M13: the VIEW button is available whenever a race is live (its label
    // stays in sync via cycleCameraView/toggleCockpitSpeed, so it needs no
    // per-frame relabel here).
    cameraButton?.setVisible(liveSession);

    let renderPrevStates: readonly CarState[];
    let renderCurrStates: readonly CarState[];
    let renderAlpha: number;
    let voiceThrottle: number;

    if (inReplay) {
      // M11b: sim/race/input below are entirely untouched while a replay
      // plays — loop.advance() (hence sim.step()) is simply never called, so
      // live ticks resume from EXACTLY where they froze once the replay
      // ends: zero ticks lost, lap timing unaffected by construction.
      const active = activeReplay!;
      const cursor = active.playback.advance(dtFrame);
      const frame0 = active.frames[cursor.index]!;
      const frame1 = active.frames[cursor.nextIndex]!;
      renderPrevStates = frame0.states;
      renderCurrStates = frame1.states;
      renderAlpha = cursor.alpha;
      voiceThrottle = frame1.playerThrottle;
      replayBanner?.set(true, cursor.progress);

      if (active.playback.done) {
        active.holdElapsedSec += dtFrame;
        if (active.holdElapsedSec >= REPLAY_HOLD_SEC) exitReplay();
      }
    } else {
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

      // M13: half-time in cockpit — scale ONLY the wall delta fed to the sim
      // loop (½× while cockpit is selected and not toggled to full). The sim
      // still ticks the identical fixed-dt deterministic sequence; only how
      // much wall time maps to each tick changes, so lap times (sim-time) stay
      // honest. Everything else this frame (camera smoothing, quality ladder,
      // fps) uses the real dtFrame. Replay has its own pacing and never reaches
      // here (loop.advance isn't called during playback).
      renderAlpha = loop.advance(dtFrame * (cameraRig?.timeScale() ?? 1));

      for (const beep of frameBeeps) sfx?.countdownBeep(beep.final);
      handleAudioEvents(frameEvents);
      handleRumbleEvents(frameEvents);
      handleCrashEvents(frameEvents);

      // Race finished this frame → show results once (session stays on the table).
      if (session.race.phase() === 'finished' && !resultsShown) {
        resultsShown = true;
        showResults();
      }

      renderPrevStates = session.sim.prevCarStates();
      renderCurrStates = session.sim.carStates();
      voiceThrottle = pendingInput.throttle;
      replayBanner?.set(false, 0);
    }

    // HUD/coach/stats-bar/debug-panel below always read the LIVE sim
    // directly (never substituted with replay frames): mid-replay that's
    // simply whatever it was the instant the sim froze — exactly the
    // "freeze" the brief calls for, for free, with no special-casing needed.
    const currentSim = session.sim;
    const prevStates = currentSim.prevCarStates();
    const currStates = currentSim.carStates();

    const carPoses = renderCurrStates.map((curr, i) =>
      computeCarPose(renderPrevStates[i]!, curr, renderAlpha, currentSim.laneFor(i)),
    );

    if (session.carsView) {
      session.carsView.update(
        renderCurrStates.map((curr, i) => computeCarRenderPose(renderPrevStates[i]!, curr, renderAlpha, currentSim.laneFor(i))),
      );
    } else if (session.debugView) {
      session.debugView.setCarPoses(carPoses);
    }

    // --- M13: camera — chase/cockpit follow the player's SHARED render pose;
    // table (incl. the deslot snap) keeps the fitted zoom/pan framing. Runs
    // here, right after carsView.update(), so carAnchor() reads the exact
    // group transform just written (no parallel pose math). Works identically
    // during a replay: the anchor comes from the replayed frames' pose.
    const playerAirborne = renderCurrStates[PLAYER_CAR_INDEX]?.phase !== 'slot';
    const effView = cameraRig ? cameraRig.effectiveMode(playerAirborne) : 'table';
    const anchor = (effView === 'chase' || effView === 'cockpit') ? session.carsView?.carAnchor(PLAYER_CAR_INDEX) ?? null : null;
    if (cameraRig && anchor && (effView === 'chase' || effView === 'cockpit')) {
      cameraRig.follow(effView, anchor, dtFrame);
    } else {
      cameraRig?.releaseToTable();
      zoomCurrent = approachZoom(zoomCurrent, zoomTarget, dtFrame);
      applyCameraFraming();
    }
    // TRUE first person: hide the player's ENTIRE car in cockpit (zero of their
    // own geometry, on flat or banked track) — restored in full the instant the
    // view is chase/table or the deslot snap fires. AI car stays fully visible.
    // Runs BEFORE setBlobShadows so a hidden player's blob-shadow decal is
    // suppressed the same frame (no flicker into cockpit).
    session.carsView?.setBodyHidden(PLAYER_CAR_INDEX, effView === 'cockpit');
    session.carsView?.setBlobShadows(qualityLadder?.blobShadowsActive() ?? false);

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
    // silent that same frame instead of one frame late. M11b: `racing` still
    // reads true throughout a replay (the race machine's own phase never
    // changes — see above), so voices keep sounding, driven from the
    // replayed frames' own v/throttle (`renderCurrStates`/`voiceThrottle`)
    // instead of the live sim's — a replayed tumble is heard, not just seen.
    const racing = session.race.phase() === 'racing';
    renderCurrStates.forEach((state, i) => {
      const voice = session!.motorVoices[i];
      const config = session!.carConfigs[i];
      const pose = carPoses[i];
      if (!voice || !config || !pose) return;
      const throttleForVoice = config.controlled === 'input' ? voiceThrottle : state.v / TUNING.vmax;
      // M13: table-x stereo panning is a TABLE-VIEW conceit — from behind the
      // wheel (chase/cockpit) there's no left/right table axis, so pin both
      // voices to center by feeding centerX (panForX(centerX,…) = 0).
      const voiceX = effView === 'table' ? pose.x : session!.audioCenterX;
      voice.update({
        v: racing ? state.v : 0,
        throttle: racing ? throttleForVoice : 0,
        x: voiceX,
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
    // M11b: hidden and not updated during a replay — it reads the live sim,
    // which is frozen, and "coaching" a moment that already happened would
    // be nonsensical.
    coachWidget?.setVisible(!!session.coach && !inReplay);
    if (!inReplay && session.coach && coachWidget) {
      const playerLane = currentSim.laneFor(PLAYER_CAR_INDEX);
      const playerPrev = prevStates[PLAYER_CAR_INDEX]!;
      const playerCurr = currStates[PLAYER_CAR_INDEX]!;
      const s = wrapLerp(playerPrev.s, playerCurr.s, renderAlpha, playerLane.totalLength);
      const v = lerp(playerPrev.v, playerCurr.v, renderAlpha);
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
        // M13: camera view + cockpit ½×/1× — drives the small HUD badge.
        cameraView: cameraRig?.mode(),
        cockpitHalfSpeed: cameraRig ? !cameraRig.cockpitFullSpeed() : undefined,
      });
    }

    // M11: top-center stats bar — speed updates every frame, counters track
    // this session's own tallies (laps from the race machine, crashes from
    // handleCrashEvents above), visible only during countdown/racing (any
    // mode) same as the on-screen MENU button. M11b: update() is SKIPPED
    // (not hidden — `setVisible` still runs) during a replay, so it just
    // reads as frozen at whatever it last showed, per the brief.
    if (statsBar) {
      if (!inReplay) {
        const playerState = currStates[PLAYER_CAR_INDEX];
        const hasAi = raceHasAiCar(session.config);
        statsBar.update({
          speedMs: playerState ? playerState.v : 0,
          laps: session.race.laps(PLAYER_CAR_INDEX),
          crashes: playerCrashes,
          aiCrashes: hasAi ? aiCrashes : undefined,
          fps: fpsEma,
        });
      }
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
    replayBanner = createReplayBanner(canvasHost);
    qualityLadder = createQualityLadder(sceneHandle, quality);
    // M13: the camera-view rig — only when real cars are rendered (the ?debug
    // box view has no cockpit to sit in), so debug stays plain table framing.
    if (!showDebug) cameraRig = createCameraRig(camera);

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
        // M13: wheel zoom is TABLE-MODE ONLY — in chase/cockpit the rig owns
        // the camera distance, so a scroll must not fight it.
        if (cameraRig && cameraRig.mode() !== 'table') return;
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
      replayButton = createReplayButton(canvasHost, toggleReplay);
      // M13: the VIEW button exists only when the camera rig does (real cars,
      // not the ?debug box view). Seed its label from the rig's current view.
      if (cameraRig) {
        cameraButton = createCameraButton(canvasHost, cycleCameraView);
        syncCameraButton();
      }
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
        // M11b: recorded HERE (once per actual sim tick), not once per rAF
        // frame in frame() — loop.advance() may run this callback 0, 1, or
        // several times per frame depending on frame pacing, and the replay
        // ring buffer's own dt (see createReplayBuffer's default) must track
        // real sim ticks exactly, not render frames. pendingInput.throttle is
        // this exact tick's player throttle — the same value just fed into
        // sim.step() above.
        replayBuffer.record(session.sim.carStates(), pendingInput.throttle);
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
  // to the menu; 'M' toggles mute; 'R' (or the REPLAY button) toggles
  // instant replay; '[' / ']' live-step stickiness — practice mode only,
  // while actually racing (see the M10 brief).
  window.addEventListener('keydown', (event) => {
    if (event.code === 'Escape') {
      // M11b: Esc during a replay ends ONLY the replay — it must NOT also
      // abort the race underneath it. Checked first, before abortToMenu(),
      // so the two can never both fire off one keypress.
      if (activeReplay) {
        exitReplay();
        return;
      }
      abortToMenu();
      return;
    }
    if (event.code === 'KeyM' && engine) {
      toggleSound();
      return;
    }
    if (event.code === 'KeyR') {
      toggleReplay();
      return;
    }
    if (event.code === 'KeyC') {
      cycleCameraView();
      return;
    }
    if (event.code === 'KeyT') {
      toggleCockpitSpeed();
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
