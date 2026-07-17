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

export interface SceneHandle {
  renderer: WebGLRenderer;
  scene: Scene;
  camera: PerspectiveCamera;
  render(): void;
  dispose(): void;
}

/**
 * Sets up the photoreal rendering pipeline: ACES tone mapping, an
 * environment-lit PBR scene, a warm shadow-casting key light, and a
 * "standing at the table" camera rig. Exact camera framing is a placeholder,
 * tuned for real in M4.
 */
export function createScene(container: HTMLElement): SceneHandle {
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
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
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
  keyLight.shadow.mapSize.set(2048, 2048);
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
  window.addEventListener('resize', handleResize);

  function render(): void {
    renderer.render(scene, camera);
  }

  function dispose(): void {
    window.removeEventListener('resize', handleResize);
    environmentTexture.dispose();
    renderer.dispose();
    container.removeChild(renderer.domElement);
  }

  return { renderer, scene, camera, render, dispose };
}
