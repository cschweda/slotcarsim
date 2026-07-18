// @vitest-environment jsdom
//
// Regression-guard style, same pattern as overlays.test.ts: a DOM factory
// (createStatsBar) plus its pure formatters, tested together. vitest's
// project-wide default environment is 'node' (see vite.config.ts) — the
// pragma above opts this file alone into jsdom so `document` exists here.
import { describe, expect, it } from 'vitest';
import {
  TICK_RATE_LABEL,
  createStatsBar,
  formatAiCrashes,
  formatCrashes,
  formatFps,
  formatLaps,
  formatScaleMph,
  formatSpeed,
  scaleMph,
} from './statsBar';

describe('scaleMph', () => {
  it('pins 3 m/s to ≈429 scale mph (HO 1:64 scale, m/s -> mph)', () => {
    expect(Math.round(scaleMph(3))).toBe(429);
  });

  it('is 0 at a standstill', () => {
    expect(scaleMph(0)).toBe(0);
  });

  it('scales linearly with speed', () => {
    expect(scaleMph(6)).toBeCloseTo(scaleMph(3) * 2, 6);
  });
});

describe('formatters', () => {
  it('formatSpeed renders m/s to 2 decimals', () => {
    expect(formatSpeed(2.4137)).toBe('SPEED 2.41 m/s');
  });

  it('formatScaleMph renders the rounded ≈ value matching the worked example (2.41 m/s -> 345)', () => {
    expect(formatScaleMph(2.41)).toBe('≈345 scale mph');
  });

  it('formatLaps / formatCrashes / formatAiCrashes render plain integers', () => {
    expect(formatLaps(7)).toBe('LAPS 7');
    expect(formatCrashes(2)).toBe('CRASHES 2');
    expect(formatAiCrashes(1)).toBe('AI CRASHES 1');
  });

  it('formatFps rounds to the nearest whole frame', () => {
    expect(formatFps(59.6)).toBe('60 FPS');
    expect(formatFps(59.4)).toBe('59 FPS');
  });

  it('TICK_RATE_LABEL is the static, fixed tick rate (never computed)', () => {
    expect(TICK_RATE_LABEL).toBe('120 Hz');
  });
});

describe('createStatsBar', () => {
  it('mounts hidden into the host', () => {
    const host = document.createElement('div');
    createStatsBar(host);
    const el = host.querySelector('.m11-stats-bar');
    expect(el).not.toBeNull();
    expect(el!.classList.contains('m11-stats-bar--visible')).toBe(false);
  });

  it('setVisible toggles the visible class', () => {
    const host = document.createElement('div');
    const bar = createStatsBar(host);
    const el = host.querySelector('.m11-stats-bar')!;

    bar.setVisible(true);
    expect(el.classList.contains('m11-stats-bar--visible')).toBe(true);

    bar.setVisible(false);
    expect(el.classList.contains('m11-stats-bar--visible')).toBe(false);
  });

  it('update() renders the full worked-example line when there is no AI car', () => {
    const host = document.createElement('div');
    const bar = createStatsBar(host);
    const el = host.querySelector('.m11-stats-bar')!;

    bar.update({ speedMs: 2.41, laps: 7, crashes: 2, fps: 60 });
    expect(el.textContent).toBe('SPEED 2.41 m/s · ≈345 scale mph · LAPS 7 · CRASHES 2 · 60 FPS · 120 Hz');
  });

  it('update() inserts AI CRASHES right after CRASHES only when the session has an AI car', () => {
    const host = document.createElement('div');
    const bar = createStatsBar(host);
    const el = host.querySelector('.m11-stats-bar')!;

    bar.update({ speedMs: 0, laps: 0, crashes: 0, aiCrashes: 1, fps: 60 });
    expect(el.textContent).toBe('SPEED 0.00 m/s · ≈0 scale mph · LAPS 0 · CRASHES 0 · AI CRASHES 1 · 60 FPS · 120 Hz');

    bar.update({ speedMs: 0, laps: 0, crashes: 0, fps: 60 });
    expect(el.textContent).not.toContain('AI CRASHES');
  });

  it('repeated construction reuses the shared stylesheet without throwing', () => {
    const hostA = document.createElement('div');
    const hostB = document.createElement('div');
    expect(() => createStatsBar(hostA)).not.toThrow();
    expect(() => createStatsBar(hostB)).not.toThrow();
    expect(document.querySelectorAll('#m11-stats-bar-style').length).toBe(1);
  });
});
