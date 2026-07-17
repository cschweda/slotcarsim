import { Mesh, MeshBasicMaterial, PlaneGeometry } from 'three';
import { TRACKS } from './config/tracks';
import { createLoop } from './loop';
import { createDebugView } from './render/debugView';
import { addLookDevContent } from './render/lookdev';
import { createScene } from './render/scene';
import { buildTrack } from './sim/track/builder';

const container = document.getElementById('app');
if (!container) {
  throw new Error('Missing #app container element');
}

const { scene, camera, render } = createScene(container);

// Constant speed for the M1 debug dots — real speed integration (throttle,
// motor curve, braking) arrives with M2's sim; this is a geometry/API demo.
const DOT_SPEED = 1.0; // m/s
const dotS: [number, number] = [0, 0];

const showLookDev = new URLSearchParams(window.location.search).has('lookdev');

let track: ReturnType<typeof buildTrack> | undefined;
let debugView: ReturnType<typeof createDebugView> | undefined;

if (showLookDev) {
  // M0 material-reference scene — reused later when tuning M4/M5 paint,
  // chrome, and canopy materials against known-good spheres.
  addLookDevContent(scene);
} else {
  addGroundPlane();
  track = buildTrack(TRACKS.oval.refs);
  debugView = createDebugView(scene, track);

  // M0's table rig framed the small look-dev spheres (~0.6m across); the
  // oval's bounding box is centered around sim (0.38, 0.23) and ~1.22m wide,
  // so re-target the same rig at that centroid and pull it back to fit.
  // Placeholder framing either way — scene.ts's own comment already notes
  // exact camera framing is tuned for real once M4 has real track geometry.
  camera.position.set(0.38, 1.7, 0.95);
  camera.lookAt(0.38, 0, -0.23);
}

function addGroundPlane(): void {
  const ground = new Mesh(new PlaneGeometry(2, 2), new MeshBasicMaterial({ color: '#3a3a3a' }));
  ground.rotation.x = -Math.PI / 2;
  scene.add(ground);
}

const loop = createLoop({
  step: (dt) => {
    dotS[0] += DOT_SPEED * dt;
    dotS[1] += DOT_SPEED * dt;
  },
});

let lastTimestamp: number | undefined;

function frame(timestamp: number): void {
  if (lastTimestamp !== undefined) {
    const frameDeltaSeconds = (timestamp - lastTimestamp) / 1000;
    loop.advance(frameDeltaSeconds);
  }
  lastTimestamp = timestamp;

  if (track && debugView) {
    debugView.setDotPositions([
      track.lanes[0].pointAt(dotS[0]).pos,
      track.lanes[1].pointAt(dotS[1]).pos,
    ]);
  }

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
