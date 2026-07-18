// @vitest-environment jsdom
//
// Regression guard for the DOM-only UI layer (overlays.ts, plus hud.ts,
// menus.ts, and debugPanel.ts extracted/exercised alongside it): the imports
// below ARE the guard against a module-evaluation-time ReferenceError (a
// top-level call reading a const/let before its own declaration has run —
// the bug class main.ts's init() restructure closes off). If any of these
// files regressed to invoking something eagerly at module scope out of
// order, the import itself would throw and this whole file would fail to
// collect, before any assertion below even runs. vitest's project-wide
// default environment is 'node' (see vite.config.ts) — the pragma above opts
// this file alone into jsdom so `document` exists here without affecting any
// other test file.
import { afterEach, describe, expect, it } from 'vitest';
import { TUNING } from '../config/tuning';
import { createDebugPanel } from './debugPanel';
import { createHud } from './hud';
import { createMenuSystem, createStartGate } from './menus';
import {
  createCalibrationOverlay,
  createCountdownOverlay,
  createReplayBanner,
  createReplayButton,
  createSoundToggle,
} from './overlays';

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

describe('createSoundToggle', () => {
  it('renders OFF by default, calls onToggle on click, and only relabels once the caller calls set() — the button never drives its own state', () => {
    const host = document.createElement('div');
    let toggled = 0;
    const toggle = createSoundToggle(host, {
      initialOn: false,
      onToggle: () => {
        toggled += 1;
      },
    });

    const button = host.querySelector('button');
    expect(button).not.toBeNull();
    expect(button!.getAttribute('aria-pressed')).toBe('false');
    expect(button!.textContent).toContain('OFF');
    expect(button!.getAttribute('aria-label')).toBeTruthy();

    button!.click();
    expect(toggled).toBe(1);
    // main.ts (the single source of truth for the mute flag) is responsible
    // for calling set() back after actually flipping state — a click alone
    // must not relabel the button, or the button and main.ts's own flag
    // could disagree about which one is "real".
    expect(button!.getAttribute('aria-pressed')).toBe('false');

    toggle.set(true);
    expect(button!.getAttribute('aria-pressed')).toBe('true');
    expect(button!.textContent).toContain('ON');
    expect(button!.textContent).not.toContain('OFF');
  });

  it('renders ON when constructed with initialOn: true, and can flip back to OFF via set()', () => {
    const host = document.createElement('div');
    const toggle = createSoundToggle(host, { initialOn: true, onToggle: () => {} });
    const button = host.querySelector('button')!;
    expect(button.getAttribute('aria-pressed')).toBe('true');
    expect(button.textContent).toContain('ON');

    toggle.set(false);
    expect(button.getAttribute('aria-pressed')).toBe('false');
    expect(button.textContent).toContain('OFF');
  });

  it('repeated construction reuses the shared stylesheet without throwing', () => {
    const hostA = document.createElement('div');
    const hostB = document.createElement('div');
    expect(() => createSoundToggle(hostA, { initialOn: false, onToggle: () => {} })).not.toThrow();
    expect(() => createSoundToggle(hostB, { initialOn: false, onToggle: () => {} })).not.toThrow();
    expect(document.querySelectorAll('#m9-sound-toggle-style').length).toBe(1);
  });
});

describe('createReplayButton', () => {
  it('starts hidden, becomes visible via setVisible(), and calls onClick on click', () => {
    const host = document.createElement('div');
    let clicks = 0;
    const button = createReplayButton(host, () => {
      clicks += 1;
    });

    const el = host.querySelector('button') as HTMLButtonElement | null;
    expect(el).not.toBeNull();
    expect(el!.classList.contains('m11b-replay-button--visible')).toBe(false);
    expect(el!.getAttribute('aria-label')).toBeTruthy();

    button.setVisible(true);
    expect(el!.classList.contains('m11b-replay-button--visible')).toBe(true);

    el!.click();
    expect(clicks).toBe(1);

    button.setVisible(false);
    expect(el!.classList.contains('m11b-replay-button--visible')).toBe(false);
  });

  it('repeated construction reuses the shared stylesheet without throwing', () => {
    const hostA = document.createElement('div');
    const hostB = document.createElement('div');
    expect(() => createReplayButton(hostA, () => {})).not.toThrow();
    expect(() => createReplayButton(hostB, () => {})).not.toThrow();
    expect(document.querySelectorAll('#m11b-replay-button-style').length).toBe(1);
  });
});

describe('createReplayBanner', () => {
  it('mounts hidden, shows on set(true, progress) with a clamped progress-bar fill, hides on set(false, _)', () => {
    const host = document.createElement('div');
    const banner = createReplayBanner(host);

    const el = host.querySelector('.m11b-replay-banner') as HTMLElement | null;
    expect(el).not.toBeNull();
    expect(el!.classList.contains('m11b-replay-banner--visible')).toBe(false);

    const fill = el!.querySelector('.m11b-replay-banner__fill') as HTMLElement;

    banner.set(true, 0.42);
    expect(el!.classList.contains('m11b-replay-banner--visible')).toBe(true);
    expect(fill.style.width).toBe('42%');

    banner.set(true, 1.6); // clamps at 100%, never overshoots
    expect(fill.style.width).toBe('100%');

    banner.set(true, -0.3); // clamps at 0%, never goes negative
    expect(fill.style.width).toBe('0%');

    banner.set(false, 0.9);
    expect(el!.classList.contains('m11b-replay-banner--visible')).toBe(false);
  });

  it('repeated construction reuses the shared stylesheet without throwing', () => {
    const hostA = document.createElement('div');
    const hostB = document.createElement('div');
    expect(() => createReplayBanner(hostA)).not.toThrow();
    expect(() => createReplayBanner(hostB)).not.toThrow();
    expect(document.querySelectorAll('#m11b-replay-banner-style').length).toBe(1);
  });
});

describe('createDebugPanel', () => {
  // shouldRender() renders whenever import.meta.env.DEV OR ?tune is set;
  // forcing ?tune here (rather than relying on vitest's DEV mode happening
  // to be truthy) makes this test's outcome independent of that.
  afterEach(() => {
    window.history.pushState({}, '', '/');
  });

  it('docks the column into flexRoot (not canvasHost) and mounts the reopen tab into canvasHost, collapse <-> reopen toggling both', () => {
    window.history.pushState({}, '', '/?tune');
    const flexRoot = document.createElement('div');
    const canvasHost = document.createElement('div');
    const panel = createDebugPanel(flexRoot, canvasHost, { ...TUNING });

    expect(() => panel.sample({ v: 0, throttle: 0 })).not.toThrow();

    const column = flexRoot.querySelector('.m2-debug');
    expect(column).not.toBeNull();
    expect(canvasHost.querySelector('.m2-debug')).toBeNull(); // the column itself is NOT in canvasHost

    const closeButton = column!.querySelector('.m2-debug__close');
    expect(closeButton).not.toBeNull();
    expect(closeButton!.getAttribute('aria-label')).toBeTruthy();

    const reopenTab = canvasHost.querySelector('.m2-debug-reopen');
    expect(reopenTab).not.toBeNull();
    expect(flexRoot.querySelector('.m2-debug-reopen')).toBeNull(); // the reopen tab is NOT in flexRoot

    // Starts expanded: column visible, reopen tab hidden.
    expect(column!.classList.contains('m2-debug--collapsed')).toBe(false);
    expect(reopenTab!.classList.contains('m2-debug-reopen--visible')).toBe(false);

    (closeButton as HTMLButtonElement).click();
    expect(column!.classList.contains('m2-debug--collapsed')).toBe(true);
    expect(reopenTab!.classList.contains('m2-debug-reopen--visible')).toBe(true);

    (reopenTab as HTMLButtonElement).click();
    expect(column!.classList.contains('m2-debug--collapsed')).toBe(false);
    expect(reopenTab!.classList.contains('m2-debug-reopen--visible')).toBe(false);
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
      }),
    ).not.toThrow();
  });

  it('ui/menus.ts constructs createMenuSystem and createStartGate without throwing', () => {
    const menuHost = document.createElement('div');
    const menu = createMenuSystem(menuHost);
    expect(typeof menu.openSetup).toBe('function');
    expect(typeof menu.openResults).toBe('function');

    const gateHost = document.createElement('div');
    expect(() => createStartGate(gateHost, false, () => {})).not.toThrow();
    const gate = gateHost.querySelector('.m6-gate');
    expect(gate).not.toBeNull();
    expect(gate!.getAttribute('role')).toBe('dialog');

    // Both branches of the sound-state line (brief section 2) get a pass too.
    const gateHostOn = document.createElement('div');
    expect(() => createStartGate(gateHostOn, true, () => {})).not.toThrow();
  });
});
