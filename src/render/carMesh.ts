import {
  BufferGeometry,
  CanvasTexture,
  CylinderGeometry,
  DoubleSide,
  Float32BufferAttribute,
  Group,
  Mesh,
  MeshPhysicalMaterial,
  MeshStandardMaterial,
  Object3D,
  SRGBColorSpace,
  type Material,
  type Texture,
} from 'three';

// Procedural 1970s Aurora AFX HO slot-car bodies. buildCarBody(styleId) is the
// ONLY public body-construction API — the glb-swappable seam. If the procedural
// loft ever fails the eyeball test, a GLTFLoader can replace the internals of
// this one function without touching carsView/main.
//
// Car-local space: +x = forward, origin at the GUIDE PIN (just behind the
// nose, "front axle-ish"), +y up, wheels resting on y = 0. The whole group is
// lifted onto the roadbed and oriented by carsView; nothing here knows about
// three's world axes or the sim.
//
// Anti-"melted soap" countermeasures, all per the M5 brief:
//   - crease-doubled profile points (sill + shoulder) → hard specular lines,
//   - a flat truncated Kamm tail cap (both the 917K and 512M chop the tail),
//   - a separate tinted canopy loft with a distinct body boundary,
//   - dark wheel-arch insets over each wheel,
//   - the low-wide toy stance (≤20 mm tall, ~28 mm wide, ~76 mm long).

export type CarStyleId = 'p917' | 'f512';

export interface CarBody {
  group: Group;
  wheels: { front: Object3D; rear: Object3D };
  dispose(): void;
}

/** Wheelbase (pin→rear axle), meters. Shared with carsView's chord math. */
export const WHEELBASE = 0.034;

// ---- Overall dimensions (meters) ----
const NOSE_X = 0.0155; // nose ring, ahead of the pin
const NOSE_APEX = 0.0013; // fan apex barely projects → a blunt rounded nose
const TAIL_X = -0.0575; // Kamm tail, behind the pin
const REAR_AXLE_X = -WHEELBASE; // rear axle sits a wheelbase behind the pin

// Wheels: rears fatter/taller than fronts (period stance). Radii are exported
// for carsView's Δs/radius wheel-spin math.
export const WHEEL_R_FRONT = 0.0045; // 9 mm dia
export const WHEEL_R_REAR = 0.005; // 10 mm dia
const WHEEL_W_FRONT = 0.0045;
const WHEEL_W_REAR = 0.007;
const WHEEL_Z_FRONT = 0.0108; // lateral offset of each front wheel
const WHEEL_Z_REAR = 0.0102;

// ---- Materials (authored oversaturated; ACES tames) ----
const CANOPY_COLOR = '#1a2126';
const TIRE_COLOR = '#0c0c0e';
const CHASSIS_COLOR = '#14140f';
const ARCH_COLOR = '#080809';

interface Livery {
  base: string; // paint base color
  number: string; // roundel number
}

export const LIVERIES: Record<CarStyleId, Livery> = {
  p917: { base: '#ff3d00', number: '1' }, // neon Gulf-adjacent orange
  f512: { base: '#e8100c', number: '2' }, // screaming Ferrari red
};

// =====================================================================
// Loft machinery
// =====================================================================

/** One half-profile point in the cross-section (z lateral, y up). */
type Rail = [z: number, y: number];
/** A cross-section: x along the car + N half-rails (bottom-center → top-center). */
interface Station {
  x: number;
  rails: Rail[];
}

// Rails that carry a hard crease (duplicated in the ring so normals split):
// index 2 = sill (lower body edge), index 4 = shoulder (character line).
const HARD_RAILS = new Set([2, 4]);

interface RingPoint {
  z: number;
  y: number;
}

/**
 * Builds one closed cross-section ring from a half-profile. Walks up the right
 * side (bottom-center → top-center), then mirrors down the left side. Hard
 * rails are emitted twice (coincident) so the loft's normal averaging splits
 * there into a crisp crease instead of a soft blob.
 */
function buildRing(rails: Rail[]): RingPoint[] {
  const pts: RingPoint[] = [];
  // Right side, bottom-center up to top-center (inclusive of both centers).
  for (let i = 0; i < rails.length; i++) {
    const [z, y] = rails[i]!;
    pts.push({ z, y });
    if (HARD_RAILS.has(i)) pts.push({ z, y });
  }
  // Left side, mirror z, top-1 down to bottom+1 (skip the two center points).
  for (let i = rails.length - 2; i >= 1; i--) {
    const [z, y] = rails[i]!;
    pts.push({ z: -z, y });
    if (HARD_RAILS.has(i)) pts.push({ z: -z, y });
  }
  return pts;
}

/** Uniform Catmull-Rom on a scalar; p1..p2 is the active segment. */
function catmull(p0: number, p1: number, p2: number, p3: number, t: number): number {
  const t2 = t * t;
  const t3 = t2 * t;
  return (
    0.5 *
    (2 * p1 +
      (-p0 + p2) * t +
      (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 +
      (-p0 + 3 * p1 - 3 * p2 + p3) * t3)
  );
}

/**
 * Resamples the key stations into `perSegment × (K−1) + 1` dense stations,
 * Catmull-Rom-blending x and every rail component along the length so the
 * lofted skin is smooth between the hand-authored sections.
 */
function densify(key: Station[], perSegment: number): Station[] {
  const K = key.length;
  const railCount = key[0]!.rails.length;
  const at = (i: number): Station => key[Math.max(0, Math.min(K - 1, i))]!;
  const out: Station[] = [];
  for (let seg = 0; seg < K - 1; seg++) {
    const s0 = at(seg - 1);
    const s1 = at(seg);
    const s2 = at(seg + 1);
    const s3 = at(seg + 2);
    // Include the final endpoint only on the last segment; otherwise the next
    // segment's step 0 re-emits that station.
    const lastStep = seg === K - 2 ? perSegment : perSegment - 1;
    for (let step = 0; step <= lastStep; step++) {
      const t = step / perSegment;
      const rails: Rail[] = [];
      for (let r = 0; r < railCount; r++) {
        const z = catmull(s0.rails[r]![0], s1.rails[r]![0], s2.rails[r]![0], s3.rails[r]![0], t);
        const y = catmull(s0.rails[r]![1], s1.rails[r]![1], s2.rails[r]![1], s3.rails[r]![1], t);
        rails.push([z, y]);
      }
      out.push({ x: catmull(s0.x, s1.x, s2.x, s3.x, t), rails });
    }
  }
  return out;
}

interface LoftResult {
  positions: number[];
  /** Planar top-projection UVs, only meaningful when uvBounds is supplied. */
  uvs: number[];
}

interface LoftOptions {
  /** Add a fan cap collapsing the first ring to an apex just ahead of it. */
  noseCap?: boolean;
  /** How far ahead of the first ring the nose apex projects. */
  noseApex?: number;
  /** Add a flat fan cap over the last ring (the Kamm tail). */
  tailCap?: boolean;
  /** [xMin, xMax, halfWidth] for planar top-projection UVs. */
  uvBounds?: [number, number, number];
}

/**
 * Lofts a skin over dense stations. Vertices are laid out as a station×ring
 * grid and shared between adjacent stations (smooth along the length);
 * coincident crease duplicates in each ring make the sill/shoulder read hard.
 * Degenerate (zero-area) quads between crease duplicates are skipped so no
 * vertex is left with a NaN normal.
 */
function loft(stations: Station[], opts: LoftOptions): { geometry: BufferGeometry } {
  const rings = stations.map((s) => buildRing(s.rails));
  const R = rings[0]!.length;
  const S = stations.length;

  const pos: number[] = [];
  const uv: number[] = [];
  const [uxMin, uxMax, uHalf] = opts.uvBounds ?? [0, 1, 1];
  const pushVert = (x: number, y: number, z: number): number => {
    const idx = pos.length / 3;
    pos.push(x, y, z);
    uv.push((x - uxMin) / (uxMax - uxMin), (z + uHalf) / (2 * uHalf));
    return idx;
  };

  // Grid of vertex indices.
  const grid: number[][] = [];
  for (let s = 0; s < S; s++) {
    const row: number[] = [];
    const ring = rings[s]!;
    for (let k = 0; k < R; k++) {
      row.push(pushVert(stations[s]!.x, ring[k]!.y, ring[k]!.z));
    }
    grid.push(row);
  }

  const indices: number[] = [];
  const quad = (a: number, b: number, c: number, d: number): void => {
    indices.push(a, b, d, b, c, d);
  };
  for (let s = 0; s < S - 1; s++) {
    const ring = rings[s]!;
    for (let k = 0; k < R; k++) {
      const kn = (k + 1) % R;
      // Skip the zero-area seam between a crease's coincident duplicates.
      if (ring[k]!.z === ring[kn]!.z && ring[k]!.y === ring[kn]!.y) continue;
      quad(grid[s]![k]!, grid[s + 1]![k]!, grid[s + 1]![kn]!, grid[s]![kn]!);
    }
  }

  // Nose cap: fan the first ring to an apex a touch ahead of it.
  if (opts.noseCap) {
    const ring = rings[0]!;
    let cy = 0;
    let cz = 0;
    for (const p of ring) {
      cy += p.y;
      cz += p.z;
    }
    cy /= ring.length;
    cz /= ring.length;
    const apex = pushVert(stations[0]!.x + (opts.noseApex ?? 0.002), cy, cz);
    for (let k = 0; k < R; k++) {
      const kn = (k + 1) % R;
      if (ring[k]!.z === ring[kn]!.z && ring[k]!.y === ring[kn]!.y) continue;
      indices.push(grid[0]![kn]!, grid[0]![k]!, apex);
    }
  }

  // Tail cap: flat fan over the last ring → the truncated Kamm face.
  if (opts.tailCap) {
    const last = S - 1;
    const ring = rings[last]!;
    let cy = 0;
    let cz = 0;
    for (const p of ring) {
      cy += p.y;
      cz += p.z;
    }
    cy /= ring.length;
    cz /= ring.length;
    const center = pushVert(stations[last]!.x, cy, cz);
    for (let k = 0; k < R; k++) {
      const kn = (k + 1) % R;
      if (ring[k]!.z === ring[kn]!.z && ring[k]!.y === ring[kn]!.y) continue;
      indices.push(grid[last]![k]!, grid[last]![kn]!, center);
    }
  }

  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new Float32BufferAttribute(pos, 3));
  geometry.setAttribute('uv', new Float32BufferAttribute(uv, 2));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  return { geometry };
}

// =====================================================================
// Style profiles
// =====================================================================

/**
 * Body cross-sections, nose → tail. Both styles share this skeleton; the
 * per-style tweaks below sharpen the 512's nose/fenders and round the 917's.
 * Rails, bottom → top: 0 keel-center, 1 floor edge, 2 sill (HARD), 3 max
 * width, 4 shoulder (HARD), 5 upper flank, 6 deck edge, 7 spine center.
 */
function baseStations(): Station[] {
  return [
    { x: NOSE_X, rails: [[0, 0.004], [0.0045, 0.004], [0.0078, 0.005], [0.009, 0.0064], [0.0082, 0.0077], [0.0052, 0.0081], [0.0026, 0.008], [0, 0.0079]] },
    { x: 0.008, rails: [[0, 0.0034], [0.006, 0.0033], [0.0106, 0.0049], [0.012, 0.0072], [0.0106, 0.009], [0.0066, 0.0094], [0.0031, 0.0092], [0, 0.009]] },
    { x: -0.002, rails: [[0, 0.0032], [0.0062, 0.003], [0.0118, 0.005], [0.0133, 0.008], [0.0117, 0.0099], [0.0071, 0.0101], [0.0033, 0.0099], [0, 0.0096]] },
    { x: -0.014, rails: [[0, 0.0032], [0.0065, 0.003], [0.012, 0.005], [0.0133, 0.0086], [0.0119, 0.0109], [0.0073, 0.0113], [0.0034, 0.0111], [0, 0.0109]] },
    { x: -0.024, rails: [[0, 0.003], [0.0068, 0.0028], [0.0125, 0.0048], [0.0139, 0.0089], [0.0121, 0.0113], [0.0076, 0.0119], [0.0036, 0.0119], [0, 0.0117]] },
    { x: -0.036, rails: [[0, 0.0028], [0.007, 0.0026], [0.0129, 0.0046], [0.0143, 0.009], [0.0133, 0.0121], [0.0093, 0.0133], [0.0047, 0.0139], [0, 0.0141]] },
    { x: -0.048, rails: [[0, 0.003], [0.0066, 0.0028], [0.0126, 0.0048], [0.0141, 0.0086], [0.0131, 0.0119], [0.0091, 0.0131], [0.0046, 0.0136], [0, 0.0138]] },
    { x: TAIL_X, rails: [[0, 0.0035], [0.006, 0.003], [0.0119, 0.005], [0.0136, 0.0086], [0.0126, 0.0116], [0.0086, 0.0129], [0.0041, 0.0133], [0, 0.0134]] },
  ];
}

/** Style-specific reshaping of the shared skeleton. */
function styleStations(styleId: CarStyleId): Station[] {
  const s = baseStations();
  if (styleId === 'f512') {
    // 512M: longer flatter nose, sharper fender peaks (pull the max-width rail
    // out and the shoulder in a touch so the fender edge reads as a crease).
    for (const st of s) {
      st.rails[3]![0] += 0.0006; // wider max-width (fender peak)
      st.rails[4]![0] -= 0.0004; // tuck the shoulder → sharper peak
      if (st.x > 0) st.rails[7]![1] -= 0.0006; // flatter, lower nose
    }
  } else {
    // 917K: shorter, rounder shoulders, slightly upswept tail.
    for (const st of s) {
      st.rails[4]![1] += 0.0003; // lift the shoulder → rounder
      st.rails[5]![0] += 0.0004; // fuller upper flank
    }
    s[7]!.rails[7]![1] += 0.0009; // upswept tail spine
    s[7]!.rails[6]![1] += 0.0008;
  }
  return s;
}

/** Canopy dome cross-sections, windshield → rear roofline. */
function canopyStations(styleId: CarStyleId): Station[] {
  const backY = styleId === 'p917' ? 0.0138 : 0.0132;
  // Rails: keel-center, floor edge, sill(HARD, unused-ish), max width,
  // shoulder(HARD), upper, deck, spine — a squat dome sitting on the deck.
  const dome = (x: number, halfW: number, baseY: number, peakY: number): Station => ({
    x,
    rails: [
      [0, baseY],
      [halfW * 0.5, baseY],
      [halfW * 0.85, baseY + (peakY - baseY) * 0.12],
      [halfW, baseY + (peakY - baseY) * 0.38],
      [halfW * 0.86, baseY + (peakY - baseY) * 0.72],
      [halfW * 0.55, baseY + (peakY - baseY) * 0.92],
      [halfW * 0.26, peakY],
      [0, peakY],
    ],
  });
  return [
    dome(-0.008, 0.0035, 0.0106, 0.012),
    dome(-0.014, 0.0068, 0.0108, 0.0158),
    dome(-0.022, 0.0078, 0.011, 0.0166),
    dome(-0.03, 0.0068, 0.0114, 0.0152),
    dome(-0.036, 0.0048, backY, 0.0142),
  ];
}

// =====================================================================
// Livery texture (planar top-projection paint map)
// =====================================================================

export function makeLiveryTexture(styleId: CarStyleId): { texture: Texture | null } {
  const livery = LIVERIES[styleId];
  if (typeof document === 'undefined' || typeof document.createElement !== 'function') {
    return { texture: null };
  }
  const canvas = document.createElement('canvas');
  canvas.width = 512;
  canvas.height = 512;
  const ctx = canvas.getContext('2d');
  if (!ctx) return { texture: null };

  // Base paint.
  ctx.fillStyle = livery.base;
  ctx.fillRect(0, 0, 512, 512);

  // u = along length (nose at u=1 → right of canvas); v = lateral (center at
  // 256). White center stripe runs the full length down the middle.
  ctx.fillStyle = '#f4f4ef';
  ctx.fillRect(0, 244, 512, 24);

  // Number roundels: a white disc, thin dark ring, and a bold black number, on
  // the hood and the rear deck.
  const roundel = (cx: number, cy: number, radius: number): void => {
    ctx.beginPath();
    ctx.arc(cx, cy, radius, 0, Math.PI * 2);
    ctx.fillStyle = '#f4f4ef';
    ctx.fill();
    ctx.lineWidth = radius * 0.09;
    ctx.strokeStyle = '#141414';
    ctx.stroke();
    ctx.fillStyle = '#111111';
    ctx.font = `bold ${Math.round(radius * 1.5)}px Arial, Helvetica, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    // The paint map is top-projected then sampled flipped, so numbers land
    // sideways + mirrored on the deck. Rotate/mirror them upright (top toward
    // the nose) so they read like a real hood number.
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(Math.PI / 2);
    ctx.scale(-1, 1);
    ctx.fillText(livery.number, 0, radius * 0.08);
    ctx.restore();
  };
  roundel(372, 256, 52); // hood
  roundel(150, 256, 40); // rear deck

  const texture = new CanvasTexture(canvas);
  texture.colorSpace = SRGBColorSpace;
  texture.anisotropy = 4;
  texture.needsUpdate = true;
  return { texture };
}

// =====================================================================
// Wheels + parts
// =====================================================================

interface PartSink {
  geometries: BufferGeometry[];
  materials: Material[];
  textures: Texture[];
}

function makeWheel(radius: number, width: number, sink: PartSink): Group {
  const wheel = new Group();
  wheel.name = 'wheel';

  // Tire: a cylinder whose axis is rotated to lie along z (the axle).
  const tireGeom = new CylinderGeometry(radius, radius, width, 20, 1);
  tireGeom.rotateX(Math.PI / 2);
  const tireMat = new MeshStandardMaterial({ color: TIRE_COLOR, roughness: 0.82, metalness: 0 });
  const tire = new Mesh(tireGeom, tireMat);
  tire.castShadow = true;
  wheel.add(tire);
  sink.geometries.push(tireGeom);
  sink.materials.push(tireMat);

  // Chrome mag face on the OUTER side (+z), slightly proud, with a few spokes
  // so the spin actually reads.
  const chromeMat = new MeshPhysicalMaterial({
    color: '#e8ecf0',
    metalness: 1,
    roughness: 0.12,
    clearcoat: 0.5,
  });
  sink.materials.push(chromeMat);
  const faceGeom = new CylinderGeometry(radius * 0.7, radius * 0.7, 0.0008, 16);
  faceGeom.rotateX(Math.PI / 2);
  const face = new Mesh(faceGeom, chromeMat);
  face.position.z = width / 2 + 0.0002;
  wheel.add(face);
  sink.geometries.push(faceGeom);

  const hubGeom = new CylinderGeometry(radius * 0.22, radius * 0.22, 0.0016, 10);
  hubGeom.rotateX(Math.PI / 2);
  const hub = new Mesh(hubGeom, chromeMat);
  hub.position.z = width / 2 + 0.0004;
  wheel.add(hub);
  sink.geometries.push(hubGeom);

  const spokeGeom = new BufferGeometry();
  buildSpokes(spokeGeom, radius * 0.62);
  const spokes = new Mesh(spokeGeom, chromeMat);
  spokes.position.z = width / 2 + 0.0003;
  wheel.add(spokes);
  sink.geometries.push(spokeGeom);

  return wheel;
}

/** Three flat spoke bars across the wheel face (asymmetric → spin reads). */
function buildSpokes(geometry: BufferGeometry, length: number): void {
  const pos: number[] = [];
  const idx: number[] = [];
  const halfT = 0.0006;
  for (let i = 0; i < 3; i++) {
    const a = (i / 3) * Math.PI;
    const dx = Math.cos(a);
    const dy = Math.sin(a);
    const px = -dy * halfT;
    const py = dx * halfT;
    const x0 = -dx * length;
    const y0 = -dy * length;
    const x1 = dx * length;
    const y1 = dy * length;
    const base = pos.length / 3;
    pos.push(x0 + px, y0 + py, 0, x1 + px, y1 + py, 0, x1 - px, y1 - py, 0, x0 - px, y0 - py, 0);
    idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }
  geometry.setAttribute('position', new Float32BufferAttribute(pos, 3));
  geometry.setIndex(idx);
  geometry.computeVertexNormals();
}

// =====================================================================
// Assembly
// =====================================================================

export function buildCarBody(styleId: CarStyleId): CarBody {
  const sink: PartSink = { geometries: [], materials: [], textures: [] };
  const group = new Group();
  group.name = `car-${styleId}`;

  // ---- Body ----
  const bodyStations = densify(styleStations(styleId), 6);
  const { geometry: bodyGeom } = loft(bodyStations, {
    noseCap: true,
    noseApex: NOSE_APEX,
    tailCap: true,
    uvBounds: [TAIL_X, NOSE_X + NOSE_APEX, 0.015],
  });
  const { texture: liveryTex } = makeLiveryTexture(styleId);
  if (liveryTex) sink.textures.push(liveryTex);
  const paintMat = new MeshPhysicalMaterial({
    color: liveryTex ? '#ffffff' : LIVERIES[styleId].base,
    map: liveryTex,
    clearcoat: 1,
    clearcoatRoughness: 0.06,
    roughness: 0.35,
    metalness: 0,
  });
  const body = new Mesh(bodyGeom, paintMat);
  body.name = 'body';
  body.castShadow = true;
  body.receiveShadow = true;
  group.add(body);
  sink.geometries.push(bodyGeom);
  sink.materials.push(paintMat);

  // ---- Canopy ----
  const canopyGeomStations = densify(canopyStations(styleId), 5);
  const { geometry: canopyGeom } = loft(canopyGeomStations, { noseCap: true, tailCap: true });
  const canopyMat = new MeshPhysicalMaterial({
    color: CANOPY_COLOR,
    transmission: 0,
    transparent: true,
    opacity: 0.85,
    roughness: 0.05,
    clearcoat: 1,
    clearcoatRoughness: 0.04,
    metalness: 0,
  });
  const canopy = new Mesh(canopyGeom, canopyMat);
  canopy.name = 'canopy';
  canopy.castShadow = true;
  group.add(canopy);
  sink.geometries.push(canopyGeom);
  sink.materials.push(canopyMat);

  // ---- Wheel-arch insets (dark, imply the openings) ----
  const arches = buildArches(sink);
  group.add(arches);

  // ---- Chrome engine detail ----
  const chrome = buildChrome(styleId, sink);
  group.add(chrome);

  // ---- Wheels ----
  const front = new Group();
  front.name = 'wheelFront';
  front.position.set(0, WHEEL_R_FRONT, 0);
  for (const sign of [1, -1]) {
    const w = makeWheel(WHEEL_R_FRONT, WHEEL_W_FRONT, sink);
    w.position.set(0, 0, sign * WHEEL_Z_FRONT);
    if (sign < 0) w.rotation.y = Math.PI; // face chrome outward on both sides
    front.add(w);
  }
  const rear = new Group();
  rear.name = 'wheelRear';
  rear.position.set(REAR_AXLE_X, WHEEL_R_REAR, 0);
  for (const sign of [1, -1]) {
    const w = makeWheel(WHEEL_R_REAR, WHEEL_W_REAR, sink);
    w.position.set(0, 0, sign * WHEEL_Z_REAR);
    if (sign < 0) w.rotation.y = Math.PI;
    rear.add(w);
  }
  group.add(front);
  group.add(rear);

  // ---- Chassis slab + guide pin ----
  const chassis = buildChassis(sink);
  group.add(chassis);

  function dispose(): void {
    for (const g of sink.geometries) g.dispose();
    for (const m of sink.materials) m.dispose();
    for (const t of sink.textures) t.dispose();
  }

  return { group, wheels: { front, rear }, dispose };
}

function buildArches(sink: PartSink): Group {
  const arches = new Group();
  arches.name = 'arches';
  const mat = new MeshStandardMaterial({
    color: ARCH_COLOR,
    roughness: 0.85,
    metalness: 0,
    side: DoubleSide,
  });
  sink.materials.push(mat);
  // A dark curved band arcing over the top of each wheel across its width — the
  // fender-arch lip / opening shadow, "strongly implied by dark inset". Kept to
  // the top ~135° so it never dips below the ground plane.
  const arch = (axleX: number, wheelR: number, wheelW: number, z: number): void => {
    const geom = archBand(axleX, wheelR, z, wheelW / 2 + 0.0005, wheelR + 0.0016, 16);
    const m = new Mesh(geom, mat);
    arches.add(m);
    sink.geometries.push(geom);
  };
  arch(0, WHEEL_R_FRONT, WHEEL_W_FRONT, WHEEL_Z_FRONT);
  arch(0, WHEEL_R_FRONT, WHEEL_W_FRONT, -WHEEL_Z_FRONT);
  arch(REAR_AXLE_X, WHEEL_R_REAR, WHEEL_W_REAR, WHEEL_Z_REAR);
  arch(REAR_AXLE_X, WHEEL_R_REAR, WHEEL_W_REAR, -WHEEL_Z_REAR);
  return arches;
}

/** Curved band over a wheel: radius R arc in x-y, extruded across the width. */
function archBand(
  cx: number,
  cyAxle: number,
  zc: number,
  halfSpan: number,
  radius: number,
  segments: number,
): BufferGeometry {
  const TH_MIN = 0.34; // ~19°, keeps the band above y=0
  const TH_MAX = Math.PI - 0.34;
  const zIn = zc - halfSpan;
  const zOut = zc + halfSpan;
  const pos: number[] = [];
  const idx: number[] = [];
  for (let i = 0; i <= segments; i++) {
    const th = TH_MIN + ((TH_MAX - TH_MIN) * i) / segments;
    const x = cx + radius * Math.cos(th);
    const y = cyAxle + radius * Math.sin(th);
    pos.push(x, y, zIn);
    pos.push(x, y, zOut);
    if (i < segments) {
      const b = i * 2;
      idx.push(b, b + 1, b + 3, b, b + 3, b + 2);
    }
  }
  const g = new BufferGeometry();
  g.setAttribute('position', new Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

function buildChrome(styleId: CarStyleId, sink: PartSink): Group {
  const chrome = new Group();
  chrome.name = 'chrome';
  const mat = new MeshPhysicalMaterial({ color: '#dfe4e8', metalness: 1, roughness: 0.12 });
  sink.materials.push(mat);

  // Exhaust pipes poking back out of the Kamm panel, low.
  const pipeCount = styleId === 'p917' ? 4 : 3;
  for (let i = 0; i < pipeCount; i++) {
    const geom = new CylinderGeometry(0.0011, 0.0012, 0.006, 10);
    geom.rotateZ(Math.PI / 2); // axis along x
    const pipe = new Mesh(geom, mat);
    const spread = (i - (pipeCount - 1) / 2) * 0.0055;
    pipe.position.set(TAIL_X + 0.0015, 0.0055, spread); // tip reaches ~TAIL_X − 0.0015
    chrome.add(pipe);
    sink.geometries.push(geom);
  }

  // Velocity-stack cluster hint on the engine deck, behind the canopy — just
  // proud of the deck, a suggestion of intakes, not a hot-rod blower.
  for (let i = 0; i < 6; i++) {
    const geom = new CylinderGeometry(0.00085, 0.00085, 0.0016, 8);
    const stack = new Mesh(geom, mat);
    const col = i % 3;
    const rowb = Math.floor(i / 3);
    stack.position.set(-0.0415 - rowb * 0.0055, 0.0138, (col - 1) * 0.0048);
    chrome.add(stack);
    sink.geometries.push(geom);
  }
  return chrome;
}

function buildChassis(sink: PartSink): Group {
  const chassis = new Group();
  chassis.name = 'chassis';

  const slabMat = new MeshStandardMaterial({ color: CHASSIS_COLOR, roughness: 0.6, metalness: 0.1 });
  sink.materials.push(slabMat);
  const slabGeom = boxGeometry(NOSE_X - TAIL_X - 0.006, 0.0016, 0.024);
  const slab = new Mesh(slabGeom, slabMat);
  slab.position.set((NOSE_X + TAIL_X) / 2, 0.0013, 0);
  slab.receiveShadow = true;
  chassis.add(slab);
  sink.geometries.push(slabGeom);

  // Guide pin stub + shoe plate at the origin, dipping below the nose.
  const pinMat = new MeshPhysicalMaterial({ color: '#cfd4d8', metalness: 1, roughness: 0.2 });
  sink.materials.push(pinMat);
  const pinGeom = new CylinderGeometry(0.001, 0.001, 0.0022, 8);
  const pin = new Mesh(pinGeom, pinMat);
  pin.position.set(0, -0.0006, 0);
  chassis.add(pin);
  sink.geometries.push(pinGeom);

  const shoeGeom = boxGeometry(0.004, 0.0004, 0.0022);
  const shoe = new Mesh(shoeGeom, pinMat);
  shoe.position.set(0, -0.0016, 0);
  chassis.add(shoe);
  sink.geometries.push(shoeGeom);

  return chassis;
}

/** Minimal box as a BufferGeometry (avoids importing BoxGeometry twice). */
function boxGeometry(w: number, h: number, d: number): BufferGeometry {
  const hx = w / 2;
  const hy = h / 2;
  const hz = d / 2;
  const g = new BufferGeometry();
  const p = [
    [-hx, -hy, -hz], [hx, -hy, -hz], [hx, hy, -hz], [-hx, hy, -hz],
    [-hx, -hy, hz], [hx, -hy, hz], [hx, hy, hz], [-hx, hy, hz],
  ];
  const faces = [
    [0, 1, 2, 3], [5, 4, 7, 6], [4, 0, 3, 7], [1, 5, 6, 2], [3, 2, 6, 7], [4, 5, 1, 0],
  ];
  const pos: number[] = [];
  const idx: number[] = [];
  for (const f of faces) {
    const b = pos.length / 3;
    for (const vi of f) pos.push(p[vi]![0]!, p[vi]![1]!, p[vi]![2]!);
    idx.push(b, b + 1, b + 2, b, b + 2, b + 3);
  }
  g.setAttribute('position', new Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}
