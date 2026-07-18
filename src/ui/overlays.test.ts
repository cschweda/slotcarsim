// @vitest-environment jsdom
//
// Regression guard for the DOM-only UI layer (overlays.ts, plus hud.ts and
// menus.ts extracted alongside it): the imports below ARE the guard against
// a module-evaluation-time ReferenceError (a top-level call reading a
// const/let before its own declaration has run — the bug class main.ts's
// init() restructure closes off). If any of these files regressed to
// invoking something eagerly at module scope out of order, the import
// itself would throw and this whole file would fail to collect, before any
// assertion below even runs. vitest's project-wide default environment is
// 'node' (see vite.config.ts) — the pragma above opts this file alone into
// jsdom so `document` exists here without affecting any other test file.
import { describe, expect, it } from 'vitest';
import { createHud } from './hud';
import { createMenuSystem, createStartGate } from './menus';
import { createCalibrationOverlay, createCountdownOverlay } from './overlays';

describe('createCountdownOverlay', () => {
  it('mounts hidden into the host and exposes set/hide', () => {
    const host = document.createElement('div');
    const overlay = createCountdownOverlay(host);

    const el = host.querySelector('.m8-countdown') as HTMLElement | null;
    expect(el).not.toBeNull();
    expect(el!.style.display).toBe(''); // not shown yet — no inline display set

    expect(() => overlay.set('3')).not.toThrow();
    expect(el!.style.display).toBe('flex');
    expect(el!.textContent).toBe('3');
    expect(el!.classList.contains('m8-countdown--go')).toBe(false);

    expect(() => overlay.set('GO')).not.toThrow();
    expect(el!.textContent).toBe('GO');
    expect(el!.classList.contains('m8-countdown--go')).toBe(true);

    expect(() => overlay.hide()).not.toThrow();
    expect(el!.style.display).toBe('none');
  });

  it('repeated construction reuses the shared stylesheet without throwing', () => {
    const hostA = document.createElement('div');
    const hostB = document.createElement('div');
    expect(() => createCountdownOverlay(hostA)).not.toThrow();
    expect(() => createCountdownOverlay(hostB)).not.toThrow();
    expect(document.querySelectorAll('#m8-countdown-style').length).toBe(1);
  });
});

describe('createCalibrationOverlay', () => {
  it('mounts hidden into the host and exposes set(active, secondsLeft)', () => {
    const host = document.createElement('div');
    const overlay = createCalibrationOverlay(host);

    const el = host.querySelector('.m8-calibration') as HTMLElement | null;
    expect(el).not.toBeNull();
    expect(el!.style.display).toBe('');

    expect(() => overlay.set(true, 4.2)).not.toThrow();
    expect(el!.style.display).toBe('flex');
    expect(el!.querySelector('.m8-calibration__sub')!.textContent).toContain('5s'); // ceil(4.2)

    expect(() => overlay.set(false, 0)).not.toThrow();
    expect(el!.style.display).toBe('none');
  });

  it('repeated construction reuses the shared stylesheet without throwing', () => {
    const hostA = document.createElement('div');
    const hostB = document.createElement('div');
    expect(() => createCalibrationOverlay(hostA)).not.toThrow();
    expect(() => createCalibrationOverlay(hostB)).not.toThrow();
    expect(document.querySelectorAll('#m8-calibration-style').length).toBe(1);
  });
});

describe('module-eval guard: the rest of the DOM-only UI layer', () => {
  it('ui/hud.ts constructs and updates without throwing', () => {
    const host = document.createElement('div');
    const hud = createHud(host);

    expect(host.querySelector('.m2-hud')).not.toBeNull();
    expect(() =>
      hud.update({
        lap: 1,
        lastLapSec: null,
        bestLapSec: null,
        throttle: 0,
        sourceLabel: 'Keyboard',
        muted: false,
      }),
    ).not.toThrow();
  });

  it('ui/menus.ts constructs createMenuSystem and createStartGate without throwing', () => {
    const menuHost = document.createElement('div');
    const menu = createMenuSystem(menuHost);
    expect(typeof menu.openSetup).toBe('function');
    expect(typeof menu.openResults).toBe('function');

    const gateHost = document.createElement('div');
    expect(() => createStartGate(gateHost, () => {})).not.toThrow();
    expect(gateHost.querySelector('.m6-gate')).not.toBeNull();
  });
});
