import { createLoop } from './loop';
import { addLookDevContent } from './render/lookdev';
import { createScene } from './render/scene';

const container = document.getElementById('app');
if (!container) {
  throw new Error('Missing #app container element');
}

const { scene, render } = createScene(container);
addLookDevContent(scene);

const loop = createLoop({
  step: () => {
    // No sim content yet — later milestones drive car/track state here.
  },
});

let lastTimestamp: number | undefined;

function frame(timestamp: number): void {
  if (lastTimestamp !== undefined) {
    const frameDeltaSeconds = (timestamp - lastTimestamp) / 1000;
    loop.advance(frameDeltaSeconds);
  }
  lastTimestamp = timestamp;

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
