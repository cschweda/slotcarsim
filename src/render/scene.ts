import {
  ACESFilmicToneMapping,
  Color,
  HemisphereLight,
  PCFShadowMap,
  PerspectiveCamera,
  PMREMGenerator,
  Scene,
  SpotLight,
  SRGBColorSpace,
  WebGLRenderer,
} from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';

// Very dark warm color: the room is implied by the environment map's
// lighting/reflections, but not shown directly in v1.
const BACKGROUND_COLOR = '#0e0c0a';
const KEY_LIGHT_COLOR = '#ffd9a0';
const FILL_SKY_COLOR = '#8ba8c9';
const FILL_GROUND_COLOR = '#4a3524';

export type Quality = 'high' | 'medium' | 'low';

interface QualityPreset {
  /** Device-pixel-ratio ceiling. */
  maxDpr: number;
  /** Key-light shadow map resolution. */
  shadowMapSize: number;
}

// The preset chosen from ?quality (default high) seeds BOTH the initial
// renderer setup below AND the auto quality ladder's starting tier/ceiling
// (see createQualityLadder) — the ladder steps down from here under load and
// never recovers back above it.
const QUALITY_PRESETS: Record<Quality, QualityPreset> = {
  high: { maxDpr: 2, shadowMapSize: 2048 },
  medium: { maxDpr: 1.5, shadowMapSize: 1024 },
  low: { maxDpr: 1.25, shadowMapSize: 1024 },
};

export interface SceneOptions {
  quality?: Quality;
}

export interface SceneHandle {
  renderer: WebGLRenderer;
  scene: Scene;
  camera: PerspectiveCamera;
  /** The warm key spot; environment.ts re-aims it over the table. */
  keyLight: SpotLight;
  render(): void;
  dispose(): void;
}

/**
 * Sets up the photoreal rendering pipeline: ACES tone mapping, an
 * environment-lit PBR scene, a warm shadow-casting key light, and a
 * "standing at the table" camera rig. Quality presets scale DPR + shadow map
 * size; the key light's placement over the table is done in environment.ts.
 */
export function createScene(container: HTMLElement, options: SceneOptions = {}): SceneHandle {
  const preset = QUALITY_PRESETS[options.quality ?? 'high'];

  const renderer = new WebGLRenderer({ antialias: true });
  renderer.outputColorSpace = SRGBColorSpace;
  renderer.toneMapping = ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.0;
  renderer.shadowMap.enabled = true;
  // PCFSoftShadowMap is deprecated as of this pinned three version — it
  // silently downgrades to PCFShadowMap at runtime with a console warning
  // (identical rendered output). Using PCFShadowMap directly avoids the
  // dead API and the warning.
  renderer.shadowMap.type = PCFShadowMap;
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, preset.maxDpr));
  renderer.setSize(container.clientWidth, container.clientHeight);
  container.appendChild(renderer.domElement);

  const scene = new Scene();
  scene.background = new Color(BACKGROUND_COLOR);

  // Biggest zero-asset photoreal lever: an environment map makes clearcoat
  // paint and chrome read as real. The generator itself is disposed once the
  // PMREM texture has been extracted; the texture lives on as scene.environment.
  const pmremGenerator = new PMREMGenerator(renderer);
  const environmentTexture = pmremGenerator.fromScene(new RoomEnvironment()).texture;
  pmremGenerator.dispose();
  scene.environment = environmentTexture;
  // The RoomEnvironment IBL alone was overpowering the scene (verified by
  // zeroing the direct lights and finding the ground/spheres barely dimmed)
  // — it should read as fill/reflection information, not the key light.
  // Chrome still samples the full environment texture for reflections;
  // this only scales its lighting contribution.
  scene.environmentIntensity = 0.35;

  const camera = new PerspectiveCamera(45, container.clientWidth / container.clientHeight, 0.05, 10);
  camera.position.set(0, 1.05, 0.72);
  camera.lookAt(0, 0, 0);

  // Warm key light: a "room lamp" hanging over the table. With the
  // environment cut to fill-only (above), this light needs to carry the
  // scene as the dominant source — a warm pool of light with visible
  // falloff, not just a specular kicker on top of ambient. Tuned by eye
  // (see fix-round-2 note in the M0 report) to read as saturated neon
  // orange-red plastic under lamp light, not a daylight-studio wash.
  const keyLight = new SpotLight(KEY_LIGHT_COLOR, 20, 0, 0.6, 0.5, 2);
  keyLight.position.set(0.6, 1.6, 0.4);
  keyLight.castShadow = true;
  keyLight.shadow.mapSize.set(preset.shadowMapSize, preset.shadowMapSize);
  keyLight.shadow.camera.near = 0.5;
  keyLight.shadow.camera.far = 4;
  scene.add(keyLight);
  scene.add(keyLight.target);

  // Low-intensity cool-sky/warm-ground fill — this IS the "ambience away
  // from the key light," so it's kept low enough that the spot reads as the
  // clearly dominant source. Casts no shadows.
  const fillLight = new HemisphereLight(FILL_SKY_COLOR, FILL_GROUND_COLOR, 0.28);
  scene.add(fillLight);

  function handleResize(): void {
    const width = container.clientWidth;
    const height = container.clientHeight;
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
    renderer.setSize(width, height);
  }
  // A plain window 'resize' listener only fires for an actual browser-window
  // resize — it misses `container`'s own box changing for any OTHER reason,
  // e.g. main.ts's dev tuning panel docking/undocking as a sibling flex
  // column with the window itself never resizing (M9 follow-up: the panel
  // used to overlay the canvas; now it shares the flex row, so the canvas
  // must react when that sibling appears/disappears). ResizeObserver watches
  // `container`'s actual box directly, so one mechanism covers both a window
  // resize (which still changes container's box) AND a sibling-driven flex
  // reflow — ResizeObserver also fires once immediately upon observe(), which
  // just means this runs once redundantly right after the setSize() call a
  // few lines above (harmless — handleResize is idempotent).
  const resizeObserver = new ResizeObserver(handleResize);
  resizeObserver.observe(container);

  function render(): void {
    renderer.render(scene, camera);
  }

  function dispose(): void {
    resizeObserver.disconnect();
    environmentTexture.dispose();
    renderer.dispose();
    container.removeChild(renderer.domElement);
  }

  return { renderer, scene, camera, keyLight, render, dispose };
}

// =====================================================================
// M8: auto quality ladder
// =====================================================================
// A rolling frame-time monitor that steps the renderer DOWN through DPR,
// then shadow-map size, then shadows-off (+ carsView's cheap blob-shadow
// fallback) under sustained load, and back UP again once things are
// comfortably fast — never above the user's own ?quality choice. The
// tier-stepping DECISION (buildLadderTiers/createLadderPolicy) is plain data
// + an injected `applyTier` callback, with no three.js/DOM dependency, so it
// is unit-testable without a real WebGLRenderer; createQualityLadder below
// is the thin wiring onto a real SceneHandle.

/** One rung of the ladder: a concrete (dpr, shadow map size, shadows on/off) tuple. */
export interface QualityLadderTier {
  label: string;
  dpr: number;
  shadowMapSize: number;
  shadowsEnabled: boolean;
}

const LADDER_WINDOW = 120; // frames — the brief's "~120-frame window" (~2s at 60fps)
const STEP_DOWN_AVG_MS = 20;
const STEP_UP_AVG_MS = 12;
const STEP_UP_SUSTAIN_SEC = 10;
const DPR_MID = 1.5;
const DPR_FLOOR = 1.25;
const REDUCED_SHADOW_MAP_SIZE = 1024;

/**
 * The full step-down path from `start` (the user's ?quality tier — also the
 * ceiling the ladder never rises back above): DPR down through 1.5 → 1.25,
 * then shadow map size down to 1024, then shadows off entirely. Steps
 * already satisfied by `start` are skipped — e.g. a `low` start (already
 * dpr 1.25 / shadow 1024) only has the shadows-off step left, while `high`
 * (dpr 2 / shadow 2048) gets the full four-step descent.
 */
export function buildLadderTiers(start: QualityLadderTier): QualityLadderTier[] {
  const tiers: QualityLadderTier[] = [start];
  for (;;) {
    const prev = tiers[tiers.length - 1]!;
    let next: QualityLadderTier | null = null;
    if (prev.dpr > DPR_MID) {
      next = { ...prev, label: `${start.label}-dpr1.5`, dpr: DPR_MID };
    } else if (prev.dpr > DPR_FLOOR) {
      next = { ...prev, label: `${start.label}-dpr1.25`, dpr: DPR_FLOOR };
    } else if (prev.shadowMapSize > REDUCED_SHADOW_MAP_SIZE) {
      next = { ...prev, label: `${start.label}-shadow1024`, shadowMapSize: REDUCED_SHADOW_MAP_SIZE };
    } else if (prev.shadowsEnabled) {
      next = { ...prev, label: `${start.label}-noshadow`, shadowsEnabled: false };
    }
    if (!next) break;
    tiers.push(next);
  }
  return tiers;
}

export interface QualityLadder {
  /** Feed one frame's duration in milliseconds; steps the tier per the hysteresis rule below. */
  sample(frameMs: number): void;
  tierIndex(): number;
  tierLabel(): string;
  /** True once shadows are fully disabled — carsView should show blob shadows instead. */
  blobShadowsActive(): boolean;
  /** The current rolling window's average frame time, ms (0 before the first sample) — for the debug panel's readout. */
  avgFrameMs(): number;
}

/**
 * Rolling `LADDER_WINDOW`-frame frame-time monitor: steps DOWN the instant a
 * full window's average exceeds `STEP_DOWN_AVG_MS` (the full window itself
 * IS the "sustained" signal — no separate dwell timer needed), steps UP only
 * after `STEP_UP_SUSTAIN_SEC` straight seconds of a sub-`STEP_UP_AVG_MS`
 * window average, and never rises above tier 0 (`cap`). Any tier change
 * clears the window and the good-streak timer, so each decision needs its
 * own fresh sustained read rather than acting on stale pre-change samples.
 * `applyTier` performs the actual renderer/light mutation — injected so this
 * decision logic stays testable without a real WebGLRenderer.
 */
export function createLadderPolicy(
  cap: QualityLadderTier,
  applyTier: (tier: QualityLadderTier) => void,
): QualityLadder {
  const tiers = buildLadderTiers(cap);
  // Tier 0 (the cap) is assumed already active — the caller (createScene)
  // sets it up directly, so applyTier is only ever invoked on a real change.
  let index = 0;
  let buffer: number[] = [];
  let sum = 0;
  let goodSeconds = 0;

  function stepTo(i: number): void {
    index = i;
    buffer = [];
    sum = 0;
    goodSeconds = 0;
    applyTier(tiers[index]!);
  }

  function sample(frameMs: number): void {
    buffer.push(frameMs);
    sum += frameMs;
    if (buffer.length > LADDER_WINDOW) sum -= buffer.shift()!;
    if (buffer.length < LADDER_WINDOW) return; // not a full window yet — nothing "sustained" to act on

    const avg = sum / buffer.length;

    if (avg > STEP_DOWN_AVG_MS) {
      if (index < tiers.length - 1) stepTo(index + 1);
      return;
    }
    if (avg < STEP_UP_AVG_MS) {
      goodSeconds += frameMs / 1000;
      if (goodSeconds >= STEP_UP_SUSTAIN_SEC && index > 0) stepTo(index - 1);
    } else {
      goodSeconds = 0; // between the two thresholds — neither degrading nor recovering
    }
  }

  return {
    sample,
    tierIndex: () => index,
    tierLabel: () => tiers[index]!.label,
    blobShadowsActive: () => !tiers[index]!.shadowsEnabled,
    avgFrameMs: () => (buffer.length > 0 ? sum / buffer.length : 0),
  };
}

/**
 * Wires createLadderPolicy onto a real SceneHandle: each tier change sets the
 * renderer's pixel ratio (still capped by the display's own devicePixelRatio,
 * matching createScene's own initial setup) and the key light's shadow map
 * size, forcing the shadow map render target to regenerate — three.js only
 * allocates it lazily and won't resize an existing one just because
 * `.mapSize` changed — then toggles shadows globally via
 * `renderer.shadowMap.enabled` (cheap: short-circuits all shadow-map
 * generation regardless of per-object castShadow/receiveShadow flags).
 */
export function createQualityLadder(handle: SceneHandle, cap: Quality): QualityLadder {
  const preset = QUALITY_PRESETS[cap];
  const startTier: QualityLadderTier = {
    label: cap,
    dpr: preset.maxDpr,
    shadowMapSize: preset.shadowMapSize,
    shadowsEnabled: true,
  };

  function applyTier(tier: QualityLadderTier): void {
    handle.renderer.setPixelRatio(Math.min(window.devicePixelRatio, tier.dpr));
    handle.keyLight.shadow.mapSize.set(tier.shadowMapSize, tier.shadowMapSize);
    handle.keyLight.shadow.map?.dispose();
    handle.keyLight.shadow.map = null;
    handle.renderer.shadowMap.enabled = tier.shadowsEnabled;
  }

  return createLadderPolicy(startTier, applyTier);
}
