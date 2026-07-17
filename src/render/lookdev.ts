import { Mesh, MeshPhysicalMaterial, PlaneGeometry, Scene, SphereGeometry } from 'three';

// TEMPORARY look-dev content. Proves the photoreal pipeline (clearcoat,
// chrome, environment reflections, warm shadows) before any real track/car
// geometry exists. Delete this file and its call site once M4 lands real
// track + car meshes.
export function addLookDevContent(scene: Scene): void {
  const ground = new Mesh(
    new PlaneGeometry(2, 2),
    new MeshPhysicalMaterial({
      color: '#8a6a4a',
      roughness: 0.6,
    }),
  );
  ground.rotation.x = -Math.PI / 2;
  ground.receiveShadow = true;
  scene.add(ground);

  const sphereRadius = 0.12;
  const sphereGeometry = new SphereGeometry(sphereRadius, 32, 16);

  // AFX neon orange clearcoat paint. Authored oversaturated — ACES tone
  // mapping tames it on render.
  const clearcoatSphere = new Mesh(
    sphereGeometry,
    new MeshPhysicalMaterial({
      color: '#ff3d00',
      clearcoat: 1,
      clearcoatRoughness: 0.06,
      roughness: 0.4,
      metalness: 0,
    }),
  );
  clearcoatSphere.position.set(-0.18, sphereRadius, 0);
  clearcoatSphere.castShadow = true;
  scene.add(clearcoatSphere);

  // Chrome.
  const chromeSphere = new Mesh(
    sphereGeometry,
    new MeshPhysicalMaterial({
      color: '#ffffff',
      metalness: 1,
      roughness: 0.06,
    }),
  );
  chromeSphere.position.set(0.18, sphereRadius, 0);
  chromeSphere.castShadow = true;
  scene.add(chromeSphere);
}
