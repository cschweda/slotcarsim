// @vitest-environment jsdom
//
// Regression-guard style, same pattern as overlays.test.ts: a DOM factory
// (createStatsBar) plus its pure formatters/layout math, tested together.
// vitest's project-wide default environment is 'node' (see vite.config.ts)
// — the pragma above opts this file alone into jsdom so `document` exists
// here.
import { describe, expect, it } from 'vitest';
import {
  CHAR_WIDTH_PX,
  FALLBACK_LEFT_PX,
  FALLBACK_RIGHT_PX,
  NEIGHBOR_GAP_PX,
  TICK_RATE_LABEL,
  computeStatsBarBounds,
  createStatsBar,
  estimateTextWidthPx,
  formatAiCrashes,
  formatCrashes,
  formatFps,
  formatLaps,
  formatScaleMph,
  formatSpeed,
  formatStatsLine,
  scaleMph,
  type StatsBarMeasure,
  type StatsBarMeasurement,
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

// A convenient all-zero measurement — exactly what a real getBoundingClientRect()
// reads for canvasHost, HUD, COACH, and SOUND alike under jsdom (no layout
// engine at all), so this doubles as "the fallback path" input.
const ZERO_MEASUREMENT: StatsBarMeasurement = {
  hostLeft: 0,
  hostRight: 0,
  leftNeighborRight: 0,
  rightNeighborLeft: 0,
};

describe('computeStatsBarBounds', () => {
  it('falls back to the original hand-measured constants when the host measures as a zero-width rect (jsdom, or before first layout)', () => {
    expect(computeStatsBarBounds(ZERO_MEASUREMENT)).toEqual({
      leftPx: FALLBACK_LEFT_PX,
      rightPx: FALLBACK_RIGHT_PX,
      middleWidthPx: Number.POSITIVE_INFINITY,
    });
  });

  it('derives left/right from the real neighbor edges relative to the host, plus the gap', () => {
    const m: StatsBarMeasurement = { hostLeft: 0, hostRight: 1200, leftNeighborRight: 380, rightNeighborLeft: 1000 };
    const bounds = computeStatsBarBounds(m);
    expect(bounds.leftPx).toBe(380 + NEIGHBOR_GAP_PX);
    expect(bounds.rightPx).toBe(1200 - 1000 + NEIGHBOR_GAP_PX);
    expect(bounds.middleWidthPx).toBe(1200 - bounds.leftPx - bounds.rightPx);
  });

  it('still works when canvasHost is not flush against the viewport left edge (e.g. offset by some ancestor layout)', () => {
    const m: StatsBarMeasurement = { hostLeft: 240, hostRight: 1440, leftNeighborRight: 620, rightNeighborLeft: 1240 };
    const bounds = computeStatsBarBounds(m);
    expect(bounds.leftPx).toBe(620 - 240 + NEIGHBOR_GAP_PX);
    expect(bounds.rightPx).toBe(1440 - 1240 + NEIGHBOR_GAP_PX);
  });

  it('clamps a not-yet-mounted/hidden neighbor (reads as the zero rect) at 0 instead of going negative', () => {
    const m: StatsBarMeasurement = { hostLeft: 0, hostRight: 800, leftNeighborRight: 0, rightNeighborLeft: 0 };
    const bounds = computeStatsBarBounds(m);
    expect(bounds.leftPx).toBe(NEIGHBOR_GAP_PX);
    expect(bounds.rightPx).toBe(800 + NEIGHBOR_GAP_PX);
  });

  it('"coach if mounted, else HUD" is the caller passing Math.max(hud.right, coach.right) as leftNeighborRight', () => {
    const hudRight = 340;
    const coachHiddenRight = 0; // display:none reads as the zero rect
    expect(Math.max(hudRight, coachHiddenRight)).toBe(hudRight);

    const coachVisibleRight = 410;
    expect(Math.max(hudRight, coachVisibleRight)).toBe(coachVisibleRight);
  });
});

describe('estimateTextWidthPx', () => {
  it('is length times the documented per-char estimate', () => {
    expect(estimateTextWidthPx('abcdef')).toBe(6 * CHAR_WIDTH_PX);
    expect(estimateTextWidthPx('')).toBe(0);
  });
});

describe('formatStatsLine (graceful degradation)', () => {
  const state = { speedMs: 2.41, laps: 7, crashes: 2, fps: 60 };
  const fullLine = 'SPEED 2.41 m/s · ≈345 scale mph · LAPS 7 · CRASHES 2 · 60 FPS · 120 Hz';
  const reducedLine = 'SPEED 2.41 m/s · LAPS 7 · CRASHES 2 · 60 FPS · 120 Hz';
  const fullWidthPx = estimateTextWidthPx(fullLine); // 420 at CHAR_WIDTH_PX=6

  it('keeps the full line, incl. scale mph, when the zone comfortably fits it', () => {
    expect(formatStatsLine(state, 10_000)).toBe(fullLine);
  });

  it('drops the scale-mph segment first when the zone is too narrow for the full line', () => {
    const line = formatStatsLine(state, 50);
    expect(line).toBe(reducedLine);
    expect(line).not.toContain('scale mph');
  });

  it('degradation threshold sits exactly at the full line\'s own estimated width', () => {
    expect(formatStatsLine(state, fullWidthPx)).toBe(fullLine); // exactly fits -> kept
    expect(formatStatsLine(state, fullWidthPx - 1)).toBe(reducedLine); // one px short -> dropped
  });

  it('never degrades when middleWidthPx is the computeStatsBarBounds fallback sentinel (Infinity)', () => {
    expect(formatStatsLine(state, Number.POSITIVE_INFINITY)).toBe(fullLine);
  });

  it('still inserts AI CRASHES right after CRASHES in both the full and the degraded line', () => {
    const withAi = { speedMs: 0, laps: 0, crashes: 0, aiCrashes: 1, fps: 60 };
    expect(formatStatsLine(withAi, 10_000)).toBe(
      'SPEED 0.00 m/s · ≈0 scale mph · LAPS 0 · CRASHES 0 · AI CRASHES 1 · 60 FPS · 120 Hz',
    );
    expect(formatStatsLine(withAi, 50)).toBe('SPEED 0.00 m/s · LAPS 0 · CRASHES 0 · AI CRASHES 1 · 60 FPS · 120 Hz');
  });
});

describe('createStatsBar', () => {
  function stubMeasure(overrides: Partial<StatsBarMeasurement> = {}): StatsBarMeasure {
    const m: StatsBarMeasurement = { ...ZERO_MEASUREMENT, ...overrides };
    return () => m;
  }

  it('mounts hidden into the host', () => {
    const host = document.createElement('div');
    createStatsBar(host, stubMeasure());
    const el = host.querySelector('.m11-stats-bar');
    expect(el).not.toBeNull();
    expect(el!.classList.contains('m11-stats-bar--visible')).toBe(false);
  });

  it('setVisible toggles the visible class', () => {
    const host = document.createElement('div');
    const bar = createStatsBar(host, stubMeasure());
    const el = host.querySelector('.m11-stats-bar')!;

    bar.setVisible(true);
    expect(el.classList.contains('m11-stats-bar--visible')).toBe(true);

    bar.setVisible(false);
    expect(el.classList.contains('m11-stats-bar--visible')).toBe(false);
  });

  it('update() renders the full worked-example line when there is no AI car (default stub measures zero rects -> fallback, never degrades)', () => {
    const host = document.createElement('div');
    const bar = createStatsBar(host, stubMeasure());
    const el = host.querySelector('.m11-stats-bar')!;

    bar.update({ speedMs: 2.41, laps: 7, crashes: 2, fps: 60 });
    expect(el.textContent).toBe('SPEED 2.41 m/s · ≈345 scale mph · LAPS 7 · CRASHES 2 · 60 FPS · 120 Hz');
  });

  it('update() inserts AI CRASHES right after CRASHES only when the session has an AI car', () => {
    const host = document.createElement('div');
    const bar = createStatsBar(host, stubMeasure());
    const el = host.querySelector('.m11-stats-bar')!;

    bar.update({ speedMs: 0, laps: 0, crashes: 0, aiCrashes: 1, fps: 60 });
    expect(el.textContent).toBe('SPEED 0.00 m/s · ≈0 scale mph · LAPS 0 · CRASHES 0 · AI CRASHES 1 · 60 FPS · 120 Hz');

    bar.update({ speedMs: 0, laps: 0, crashes: 0, fps: 60 });
    expect(el.textContent).not.toContain('AI CRASHES');
  });

  it('repeated construction reuses the shared stylesheet without throwing', () => {
    const hostA = document.createElement('div');
    const hostB = document.createElement('div');
    expect(() => createStatsBar(hostA, stubMeasure())).not.toThrow();
    expect(() => createStatsBar(hostB, stubMeasure())).not.toThrow();
    expect(document.querySelectorAll('#m11-stats-bar-style').length).toBe(1);
  });

  it('mounts already positioned from a single synchronous reposition() call — no separate "apply" step needed', () => {
    const host = document.createElement('div');
    const measurement: StatsBarMeasurement = {
      hostLeft: 0,
      hostRight: 1200,
      leftNeighborRight: 380,
      rightNeighborLeft: 1000,
    };
    createStatsBar(host, () => measurement);
    const row = host.querySelector('.m11-stats-bar-row') as HTMLElement;
    expect(row.style.left).toBe(`${380 + NEIGHBOR_GAP_PX}px`);
    expect(row.style.right).toBe(`${1200 - 1000 + NEIGHBOR_GAP_PX}px`);
  });

  it('falls back to the hand-measured constants when measure() reports a zero-width host (jsdom\'s own getBoundingClientRect default)', () => {
    const host = document.createElement('div');
    createStatsBar(host, stubMeasure());
    const row = host.querySelector('.m11-stats-bar-row') as HTMLElement;
    expect(row.style.left).toBe(`${FALLBACK_LEFT_PX}px`);
    expect(row.style.right).toBe(`${FALLBACK_RIGHT_PX}px`);
  });

  it('reposition() re-measures and re-applies left/right — the window-resize and session-rebuild triggers', () => {
    const host = document.createElement('div');
    let measurement: StatsBarMeasurement = {
      hostLeft: 0,
      hostRight: 1200,
      leftNeighborRight: 380,
      rightNeighborLeft: 1000,
    };
    const bar = createStatsBar(host, () => measurement);
    const row = host.querySelector('.m11-stats-bar-row') as HTMLElement;
    expect(row.style.left).toBe(`${380 + NEIGHBOR_GAP_PX}px`);

    // e.g. the dev tuning panel docking narrower, or COACH switching off between sessions.
    measurement = { hostLeft: 0, hostRight: 1600, leftNeighborRight: 340, rightNeighborLeft: 1420 };
    bar.reposition();
    expect(row.style.left).toBe(`${340 + NEIGHBOR_GAP_PX}px`);
    expect(row.style.right).toBe(`${1600 - 1420 + NEIGHBOR_GAP_PX}px`);
  });

  it('degradation threshold end-to-end: update() drops scale mph once reposition() leaves too little room, and restores it once the zone widens back', () => {
    const host = document.createElement('div');
    // middle ≈ 1200 - (380+16) - (1200-1000+16) = 1200 - 396 - 216 = 588px — comfortably fits the ~420px full line.
    let measurement: StatsBarMeasurement = {
      hostLeft: 0,
      hostRight: 1200,
      leftNeighborRight: 380,
      rightNeighborLeft: 1000,
    };
    const bar = createStatsBar(host, () => measurement);
    const el = host.querySelector('.m11-stats-bar')!;
    const state = { speedMs: 2.41, laps: 7, crashes: 2, fps: 60 };

    bar.update(state);
    expect(el.textContent).toContain('scale mph');

    // Narrow the canvas (e.g. the dev panel docking wider): middle zone collapses well under ~420px.
    measurement = { hostLeft: 0, hostRight: 900, leftNeighborRight: 380, rightNeighborLeft: 700 };
    bar.reposition();
    bar.update(state);
    expect(el.textContent).not.toContain('scale mph');
    expect(el.textContent).toBe('SPEED 2.41 m/s · LAPS 7 · CRASHES 2 · 60 FPS · 120 Hz');

    // Widen back — scale mph returns.
    measurement = { hostLeft: 0, hostRight: 1200, leftNeighborRight: 380, rightNeighborLeft: 1000 };
    bar.reposition();
    bar.update(state);
    expect(el.textContent).toContain('scale mph');
  });
});
