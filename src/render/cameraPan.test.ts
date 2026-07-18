import { describe, expect, it } from 'vitest';
import {
  PAN_MARGIN_M,
  STICK_PAN_WIDTHS_PER_SEC,
  clampPanTarget,
  panBoundsFromBBox,
  screenDeltaToWorld,
  stepPan,
  stepPanFromStick,
} from './cameraPan';

describe('screenDeltaToWorld', () => {
  it('1:1 conversion: screenPx * visibleWorldWidth/canvasPx, at a close-zoom level', () => {
    const d = screenDeltaToWorld(120, -40, 2, 800);
    expect(d.x).toBeCloseTo(120 * (2 / 800), 12);
    expect(d.y).toBeCloseTo(-40 * (2 / 800), 12);
  });

  it('1:1 conversion holds at a different (zoomed-out) visibleWorldWidth too', () => {
    const d = screenDeltaToWorld(120, -40, 6, 800);
    expect(d.x).toBeCloseTo(120 * (6 / 800), 12);
    expect(d.y).toBeCloseTo(-40 * (6 / 800), 12);
  });

  it('zero screen delta converts to zero world delta', () => {
    expect(screenDeltaToWorld(0, 0, 4, 1000)).toEqual({ x: 0, y: 0 });
  });

  it('a zero canvas width does not divide by zero (defensive)', () => {
    const d = screenDeltaToWorld(10, 10, 4, 0);
    expect(Number.isFinite(d.x)).toBe(true);
    expect(Number.isFinite(d.y)).toBe(true);
  });
});

describe('panBoundsFromBBox / clampPanTarget', () => {
  const bounds = panBoundsFromBBox({ cx: 1, cy: -2, hx: 1, hy: 0.5 });

  it('adds the default margin to every side', () => {
    expect(bounds.minX).toBeCloseTo(1 - 1 - PAN_MARGIN_M, 12);
    expect(bounds.maxX).toBeCloseTo(1 + 1 + PAN_MARGIN_M, 12);
    expect(bounds.minY).toBeCloseTo(-2 - 0.5 - PAN_MARGIN_M, 12);
    expect(bounds.maxY).toBeCloseTo(-2 + 0.5 + PAN_MARGIN_M, 12);
  });

  it('passes a target already inside the bounds through unchanged', () => {
    expect(clampPanTarget({ x: 1, y: -2 }, bounds)).toEqual({ x: 1, y: -2 });
  });

  it('clamps at the +x bound', () => {
    expect(clampPanTarget({ x: 999, y: -2 }, bounds).x).toBeCloseTo(bounds.maxX, 12);
  });

  it('clamps at the -x bound', () => {
    expect(clampPanTarget({ x: -999, y: -2 }, bounds).x).toBeCloseTo(bounds.minX, 12);
  });

  it('clamps at the +y bound', () => {
    expect(clampPanTarget({ x: 1, y: 999 }, bounds).y).toBeCloseTo(bounds.maxY, 12);
  });

  it('clamps at the -y bound', () => {
    expect(clampPanTarget({ x: 1, y: -999 }, bounds).y).toBeCloseTo(bounds.minY, 12);
  });
});

describe('stepPan (mouse drag — "grab and slide the content" feel)', () => {
  const generousBounds = panBoundsFromBBox({ cx: 0, cy: 0, hx: 50, hy: 50 });

  it('a zero screen delta is a no-op', () => {
    const current = { x: 0.37, y: -1.2 };
    expect(stepPan(current, 0, 0, 3, 900, generousBounds)).toEqual(current);
  });

  it('1:1 drag feel at one zoom level: dragging right moves the target left (x: subtract)', () => {
    const next = stepPan({ x: 0, y: 0 }, 90, 0, 3, 900, generousBounds);
    expect(next.x).toBeCloseTo(-0.3, 12); // 90 * 3/900 = 0.3
    expect(next.y).toBeCloseTo(0, 12);
  });

  it('1:1 drag feel holds at a different (zoomed-out) level too', () => {
    const next = stepPan({ x: 0, y: 0 }, 90, 0, 9, 900, generousBounds);
    expect(next.x).toBeCloseTo(-0.9, 12); // 90 * 9/900 = 0.9
  });

  it('dragging down moves the target y UP (increases) — opposite arithmetic from x, because sim y maps to three -z', () => {
    const next = stepPan({ x: 0, y: 0 }, 0, 60, 3, 900, generousBounds);
    expect(next.y).toBeCloseTo(0.2, 12); // 60 * 3/900 = 0.2, ADDED not subtracted
  });

  it('clamps the result against the given bounds', () => {
    const tightBounds = panBoundsFromBBox({ cx: 0, cy: 0, hx: 0.1, hy: 0.1 });
    const next = stepPan({ x: 0, y: 0 }, 100000, 0, 3, 900, tightBounds);
    expect(next.x).toBeCloseTo(tightBounds.minX, 12); // dragged hard right -> saturates at the -x bound
  });
});

describe('stepPanFromStick (gamepad left stick — direct camera-move feel, the OPPOSITE metaphor from drag)', () => {
  const generousBounds = panBoundsFromBBox({ cx: 0, cy: 0, hx: 50, hy: 50 });

  it('zero stick input is a no-op', () => {
    const current = { x: 0.5, y: -0.25 };
    expect(stepPanFromStick(current, 0, 0, 1 / 60, 4, generousBounds)).toEqual(current);
  });

  it('stick right increases target x — opposite arithmetic from a mouse drag right', () => {
    const next = stepPanFromStick({ x: 0, y: 0 }, 1, 0, 1, 4, generousBounds, 1);
    expect(next.x).toBeCloseTo(4, 9); // full deflection * 1 width/sec * 1s * 4m width
  });

  it('stick up (negative axis value, standard convention) increases target y — pans the view up', () => {
    const next = stepPanFromStick({ x: 0, y: 0 }, 0, -1, 1, 4, generousBounds, 1);
    expect(next.y).toBeCloseTo(4, 9);
  });

  it('stick down (positive axis value) decreases target y', () => {
    const next = stepPanFromStick({ x: 0, y: 0 }, 0, 1, 1, 4, generousBounds, 1);
    expect(next.y).toBeCloseTo(-4, 9);
  });

  it('scales with dt and the default rate (STICK_PAN_WIDTHS_PER_SEC)', () => {
    const next = stepPanFromStick({ x: 0, y: 0 }, 1, 0, 0.5, 4, generousBounds);
    expect(next.x).toBeCloseTo(4 * STICK_PAN_WIDTHS_PER_SEC * 0.5, 9);
  });

  it('clamps against bounds when held long enough to run off the edge', () => {
    const tightBounds = panBoundsFromBBox({ cx: 0, cy: 0, hx: 0.1, hy: 0.1 });
    const next = stepPanFromStick({ x: 0, y: 0 }, 1, 0, 100, 4, tightBounds);
    expect(next.x).toBeCloseTo(tightBounds.maxX, 9);
  });
});
