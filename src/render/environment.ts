import {
  BoxGeometry,
  CanvasTexture,
  Mesh,
  MeshPhysicalMaterial,
  MeshStandardMaterial,
  PlaneGeometry,
  RepeatWrapping,
  SRGBColorSpace,
  type Material,
  type Scene,
  type SpotLight,
  type Texture,
} from 'three';

// The room the track sits in: a warm wood table on a dark basement floor under
// a single incandescent lamp pool that falls off into warm darkness. The table
// top is at y=0 so the roadbed (bottom at y=0) rests on a real, thick object.
//
// The key light is CREATED in scene.ts (so its shadow-map size tracks the
// quality preset); this module re-aims it over the table center and shrink-
// wraps its shadow camera to the table, because the table dimensions live here.

// Default centroid (the oval's) the table sits under. Sim (x, y) -> three
// (x, ·, -y). M7 passes the active track's centroid so the figure-8 is centered
// on the table too, not just the oval.
const DEFAULT_CENTER_X = 0.381;
const DEFAULT_CENTER_Z = -0.2286;
const TABLE_WIDTH = 1.7; // along three x
const TABLE_DEPTH = 0.9; // along three z
const TABLE_THICKNESS = 0.018; // ~18 mm slab
const TABLE_TOP_Y = 0;

const FLOOR_Y = TABLE_TOP_Y - TABLE_THICKNESS - 0.75; // basement floor ~0.75 m below the table
const FLOOR_SIZE = 24;

const WOOD_BASE = '#6b4a2c';
const FLOOR_COLOR = '#141210';

/** Warm mid-brown plywood/folding-table top: planks, seams, and fine grain. */
function makeWoodTexture(): Texture | undefined {
  if (typeof document === 'undefined' || typeof document.createElement !== 'function') return undefined;
  const canvas = document.createElement('canvas');
  canvas.width = 1024;
  canvas.height = 512;
  const ctx = canvas.getContext('2d');
  if (!ctx) return undefined;

  ctx.fillStyle = WOOD_BASE;
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  // Distinct planks, each with a slightly different warm tone so the top does
  // not read as one flat laminate sheet.
  const plankH = 85; // ~0.15 m on this table
  for (let y = 0; y < canvas.height; y += plankH) {
    const r = 92 + Math.random() * 16 - 8;
    const g = 64 + Math.random() * 12 - 6;
    const b = 40 + Math.random() * 10 - 5;
    ctx.fillStyle = `rgb(${Math.round(r)},${Math.round(g)},${Math.round(b)})`;
    ctx.fillRect(0, y, canvas.width, plankH);
  }

  // Long grain streaks running along the planks (horizontal).
  for (let i = 0; i < 2600; i++) {
    const y = Math.random() * canvas.height;
    const x = Math.random() * canvas.width;
    const len = 40 + Math.random() * 220;
    const shade = Math.random() * 42 - 21;
    const tone = 0.5 + Math.random() * 0.3;
    ctx.strokeStyle = `rgba(${Math.round(70 * tone) + shade + 40},${
      Math.round(48 * tone) + shade + 24
    },${Math.round(28 * tone) + shade + 12},0.28)`;
    ctx.lineWidth = 0.5 + Math.random() * 1.4;
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.bezierCurveTo(x + len * 0.3, y + (Math.random() - 0.5) * 6, x + len * 0.7, y + (Math.random() - 0.5) * 6, x + len, y);
    ctx.stroke();
  }

  // Plank seams: darker horizontal lines every ~85 px (~0.15 m on this table).
  const plankHeight = plankH;
  for (let y = plankHeight; y < canvas.height; y += plankHeight) {
    const jitter = (Math.random() - 0.5) * 6;
    ctx.strokeStyle = 'rgba(26,16,8,0.55)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(0, y + jitter);
    ctx.lineTo(canvas.width, y + jitter);
    ctx.stroke();
    // subtle highlight just below the seam
    ctx.strokeStyle = 'rgba(150,110,70,0.10)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, y + jitter + 2);
    ctx.lineTo(canvas.width, y + jitter + 2);
    ctx.stroke();
  }

  // Fine grain noise.
  const image = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const data = image.data;
  for (let p = 0; p < data.length; p += 4) {
    const n = (Math.random() - 0.5) * 18;
    data[p] = Math.max(0, Math.min(255, data[p]! + n));
    data[p + 1] = Math.max(0, Math.min(255, data[p + 1]! + n));
    data[p + 2] = Math.max(0, Math.min(255, data[p + 2]! + n));
  }
  ctx.putImageData(image, 0, 0);

  const texture = new CanvasTexture(canvas);
  texture.colorSpace = SRGBColorSpace;
  texture.wrapS = RepeatWrapping;
  texture.wrapT = RepeatWrapping;
  texture.needsUpdate = true;
  return texture;
}

/** A grey roughness map derived from the wood so grain/seams vary the sheen too. */
function makeWoodRoughness(): Texture | undefined {
  if (typeof document === 'undefined' || typeof document.createElement !== 'function') return undefined;
  const canvas = document.createElement('canvas');
  canvas.width = 512;
  canvas.height = 256;
  const ctx = canvas.getContext('2d');
  if (!ctx) return undefined;
  ctx.fillStyle = '#9a9a9a'; // ~0.6 base
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  for (let i = 0; i < 1600; i++) {
    const y = Math.random() * canvas.height;
    const x = Math.random() * canvas.width;
    const len = 30 + Math.random() * 120;
    const v = 130 + Math.random() * 70;
    ctx.strokeStyle = `rgba(${v},${v},${v},0.25)`;
    ctx.lineWidth = 0.5 + Math.random() * 1.5;
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x + len, y + (Math.random() - 0.5) * 4);
    ctx.stroke();
  }
  const texture = new CanvasTexture(canvas);
  texture.wrapS = RepeatWrapping;
  texture.wrapT = RepeatWrapping;
  texture.needsUpdate = true;
  return texture;
}

/** Radial warm-to-black vignette so the floor reads as light falling into darkness. */
function makeVignetteTexture(): Texture | undefined {
  if (typeof document === 'undefined' || typeof document.createElement !== 'function') return undefined;
  const canvas = document.createElement('canvas');
  canvas.width = 512;
  canvas.height = 512;
  const ctx = canvas.getContext('2d');
  if (!ctx) return undefined;
  const g = ctx.createRadialGradient(256, 256, 20, 256, 256, 256);
  g.addColorStop(0, '#3a2c1c');
  g.addColorStop(0.4, '#221a12');
  g.addColorStop(1, '#000000');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  const texture = new CanvasTexture(canvas);
  texture.colorSpace = SRGBColorSpace;
  texture.needsUpdate = true;
  return texture;
}

export interface Environment {
  dispose(): void;
}

export interface EnvironmentOptions {
  /** Sim-plane centroid the table/light center on (defaults to the oval's). */
  center?: { x: number; y: number };
}

export function createEnvironment(
  scene: Scene,
  keyLight: SpotLight,
  options: EnvironmentOptions = {},
): Environment {
  // Sim (x, y) -> three (x, ·, -y): the table's three-z is -(sim y).
  const TABLE_CENTER_X = options.center ? options.center.x : DEFAULT_CENTER_X;
  const TABLE_CENTER_Z = options.center ? -options.center.y : DEFAULT_CENTER_Z;
  const meshes: Mesh[] = [];
  const geometries: (BoxGeometry | PlaneGeometry)[] = [];
  const materials: Material[] = [];
  const textures: Texture[] = [];

  // ---- Table ----
  const woodMap = makeWoodTexture();
  const woodRough = makeWoodRoughness();
  if (woodMap) textures.push(woodMap);
  if (woodRough) textures.push(woodRough);

  const tableGeom = new BoxGeometry(TABLE_WIDTH, TABLE_THICKNESS, TABLE_DEPTH);
  const tableMat = new MeshPhysicalMaterial({
    color: woodMap ? '#ffffff' : WOOD_BASE,
    map: woodMap ?? null,
    roughness: woodRough ? 1.0 : 0.62,
    roughnessMap: woodRough ?? null,
    metalness: 0,
  });
  const table = new Mesh(tableGeom, tableMat);
  table.position.set(TABLE_CENTER_X, TABLE_TOP_Y - TABLE_THICKNESS / 2, TABLE_CENTER_Z);
  table.receiveShadow = true;
  table.castShadow = true;
  scene.add(table);
  meshes.push(table);
  geometries.push(tableGeom);
  materials.push(tableMat);

  // ---- Floor ----
  const vignette = makeVignetteTexture();
  if (vignette) textures.push(vignette);
  const floorGeom = new PlaneGeometry(FLOOR_SIZE, FLOOR_SIZE);
  const floorMat = new MeshStandardMaterial({
    color: FLOOR_COLOR,
    map: vignette ?? null,
    roughness: 0.95,
    metalness: 0,
  });
  const floor = new Mesh(floorGeom, floorMat);
  floor.rotation.x = -Math.PI / 2;
  floor.position.set(TABLE_CENTER_X, FLOOR_Y, TABLE_CENTER_Z);
  floor.receiveShadow = false;
  scene.add(floor);
  meshes.push(floor);
  geometries.push(floorGeom);
  materials.push(floorMat);

  // ---- Lamp: re-aim the warm key spot over the table and shrink-wrap its shadow ----
  keyLight.position.set(TABLE_CENTER_X - 0.28, 0.98, TABLE_CENTER_Z + 0.34);
  keyLight.target.position.set(TABLE_CENTER_X + 0.12, 0, TABLE_CENTER_Z - 0.05);
  keyLight.target.updateMatrixWorld();
  keyLight.angle = 0.62;
  keyLight.penumbra = 0.55;
  keyLight.distance = 0;
  keyLight.decay = 2;
  keyLight.intensity = 34;
  // Shrink-wrap the shadow frustum to the table depth from the lamp.
  keyLight.shadow.camera.near = 0.45;
  keyLight.shadow.camera.far = 1.9;
  keyLight.shadow.bias = -0.0002;
  keyLight.shadow.normalBias = 0.02;
  keyLight.shadow.camera.updateProjectionMatrix();

  let disposed = false;
  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    for (const mesh of meshes) scene.remove(mesh);
    for (const geometry of geometries) geometry.dispose();
    for (const material of materials) material.dispose();
    for (const texture of textures) texture.dispose();
  };

  return { dispose };
}
