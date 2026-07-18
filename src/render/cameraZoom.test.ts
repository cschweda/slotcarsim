import { describe, expect, it } from 'vitest';
import { ZOOM_DEFAULT, ZOOM_MAX, ZOOM_MIN, approachZoom, stepZoom } from './cameraZoom';

describe('stepZoom', () => {
  it('clamps at ZOOM_MAX for a large positive (zoom-out) deltaY', () => {
    expect(stepZoom(ZOOM_DEFAULT, 100000)).toBe(ZOOM_MAX);
  });

  it('clamps at ZOOM_MIN for a large negative (zoom-in) deltaY', () => {
    expect(stepZoom(ZOOM_DEFAULT, -100000)).toBe(ZOOM_MIN);
  });

  it('a zero deltaY is a no-op', () => {
    expect(stepZoom(0.7, 0)).toBe(0.7);
  });

  it('monotonicity: wheel up/away (negative deltaY) zooms IN (decreases the multiplier); wheel down/toward (positive deltaY) zooms OUT (increases it) — the mainstream-3D-app convention', () => {
    const start = 0.7;
    expect(stepZoom(start, -50)).toBeLessThan(start);
    expect(stepZoom(start, 50)).toBeGreaterThan(start);
  });

  it('sensitivity is tuned so exactly 5 standard wheel notches (deltaY ±100) traverse the full [ZOOM_MIN, ZOOM_MAX] range', () => {
    let z = ZOOM_MAX;
    for (let i = 0; i < 5; i++) z = stepZoom(z, -100);
    expect(z).toBeCloseTo(ZOOM_MIN, 9);

    let z2 = ZOOM_MIN;
    for (let i = 0; i < 5; i++) z2 = stepZoom(z2, 100);
    expect(z2).toBeCloseTo(ZOOM_MAX, 9);
  });

  it('a trackpad pinch (pinch: true) is more sensitive per unit of deltaY than a plain wheel, same direction', () => {
    const start = ZOOM_DEFAULT;
    const plain = stepZoom(start, -20);
    const pinch = stepZoom(start, -20, { pinch: true });
    expect(pinch).toBeLessThan(plain); // moved further toward zoom-in for the same deltaY
    expect(pinch).toBeLessThan(start);
  });

  it('never exceeds the bounds no matter how many times it is chained', () => {
    let z = ZOOM_DEFAULT;
    for (let i = 0; i < 50; i++) z = stepZoom(z, -100, { pinch: true });
    expect(z).toBeGreaterThanOrEqual(ZOOM_MIN);
    let z2 = ZOOM_DEFAULT;
    for (let i = 0; i < 50; i++) z2 = stepZoom(z2, 100, { pinch: true });
    expect(z2).toBeLessThanOrEqual(ZOOM_MAX);
  });
});

describe('approachZoom', () => {
  it('dt=0 is a no-op', () => {
    expect(approachZoom(0.5, 1.0, 0)).toBe(0.5);
  });

  it('moves toward the target without ever overshooting it', () => {
    let v = ZOOM_MIN;
    const target = ZOOM_MAX;
    let prev = v;
    for (let i = 0; i < 30; i++) {
      v = approachZoom(v, target, 1 / 60);
      expect(v).toBeGreaterThanOrEqual(prev); // monotonically increasing toward target
      expect(v).toBeLessThanOrEqual(target); // never overshoots
      prev = v;
    }
  });

  it('converges close to the target after enough elapsed time', () => {
    const v = approachZoom(ZOOM_MIN, ZOOM_MAX, 5); // dt way beyond a handful of time constants
    expect(v).toBeCloseTo(ZOOM_MAX, 6);
  });

  it('approaches from above the target the same way (never undershoots)', () => {
    let v = ZOOM_MAX;
    const target = ZOOM_MIN;
    let prev = v;
    for (let i = 0; i < 30; i++) {
      v = approachZoom(v, target, 1 / 60);
      expect(v).toBeLessThanOrEqual(prev);
      expect(v).toBeGreaterThanOrEqual(target);
      prev = v;
    }
  });

  it('is already-there stable: approaching a target equal to current returns current unchanged', () => {
    expect(approachZoom(0.42, 0.42, 1 / 60)).toBeCloseTo(0.42, 12);
  });
});
