// Real AFX pistol-grip feel via the Gamepad API analog trigger — the primary
// input; keyboard is the fallback. Chrome hands back a FRESH object from
// every navigator.getGamepads() call (Firefox mutates in place), so caching
// a Gamepad reference risks reading stale, frozen values in Chrome. This
// re-fetches on every read/connected check; only a discovered fallback
// button/axis INDEX persists across reads, never the Gamepad object itself.
//
// M8 adds two things on top of the above (unchanged) mechanism:
//  - a one-time-per-gamepad.id calibration wizard for non-standard pads
//    (buttons[7] on a `standard`-mapping pad is already trusted and never
//    needs it), persisted to localStorage so it survives a reload; and
//  - rumble on player deslot/reslot, feature-detected and fire-and-forget.
import type { ThrottleSource } from './types';

const STANDARD_THROTTLE_BUTTON = 7; // RT, per the Gamepad API "standard" mapping
const BUTTON_DISCOVERY_THRESHOLD = 0.05;
const DEADZONE = 0.03;

type FallbackControl = { kind: 'button'; index: number } | { kind: 'axis'; index: number };

function applyDeadzone(raw: number): number {
  if (raw < DEADZONE) return 0;
  return (raw - DEADZONE) / (1 - DEADZONE);
}

function clamp01(x: number): number {
  return Math.min(1, Math.max(0, x));
}

function getFirstPad(): Gamepad | null {
  for (const pad of navigator.getGamepads()) {
    if (pad) return pad;
  }
  return null;
}

/** First button whose analog value clears the discovery threshold, else the first axis away from its -1 resting value. */
function discoverFallback(pad: Gamepad): FallbackControl | null {
  const buttonIndex = pad.buttons.findIndex((b) => b.value > BUTTON_DISCOVERY_THRESHOLD);
  if (buttonIndex >= 0) {
    return { kind: 'button', index: buttonIndex };
  }
  const axisIndex = pad.axes.findIndex((v) => v !== -1);
  if (axisIndex >= 0) {
    return { kind: 'axis', index: axisIndex };
  }
  return null;
}

// =====================================================================
// M8: calibration wizard — persistence + control-selection
// =====================================================================

/** How long the auto-calibration window samples every control's range of motion, in seconds. */
export const CALIBRATION_DURATION_SEC = 5;

const CALIBRATION_STORAGE_KEY = 'slotcar.gamepadCalibration';
/** Bumped only if the persisted shape changes again; a mismatch (including a legacy pre-version payload, which has no `version` key at all) discards the whole stored map rather than risk handing a differently-shaped entry to readStoredControl. */
const CALIBRATION_STORAGE_VERSION = 1;
/** Below this, rest/max are close enough to call the calibration degenerate — the same threshold readStoredControl's own span check uses. */
const MIN_CALIBRATION_SPAN = 1e-3;

interface StoredCalibration {
  kind: 'button' | 'axis';
  index: number;
  /** Observed value at rest (the window's minimum for the chosen control). */
  rest: number;
  /** Observed value at full squeeze (the window's maximum for the chosen control). */
  max: number;
}

type CalibrationMap = Record<string, StoredCalibration>;

/** On-disk envelope: a version tag + the id→calibration map, so a future shape change (or a pre-version legacy payload) can be told apart from the current shape instead of silently misread. */
interface PersistedCalibrations {
  version: number;
  entries: CalibrationMap;
}

/**
 * Per-entry shape guard: `rest`/`max` must both be finite numbers with a
 * non-degenerate span between them. Without this, a corrupted or hand-edited
 * localStorage entry (e.g. a non-numeric `rest`) flows straight into
 * readStoredControl's `(raw - cal.rest) / (cal.max - cal.rest)` — and
 * `Math.abs(NaN) < 1e-6` is FALSE (any comparison against NaN is), so that
 * function's own "degenerate calibration" guard does NOT catch it; a NaN
 * throttle would reach the sim. Entries failing this check are dropped
 * silently rather than surfacing an error to the player over a stale/corrupt
 * calibration.
 */
function isValidStoredCalibration(value: unknown): value is StoredCalibration {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Record<string, unknown>;
  if (candidate.kind !== 'button' && candidate.kind !== 'axis') return false;
  if (typeof candidate.index !== 'number' || !Number.isFinite(candidate.index)) return false;
  if (typeof candidate.rest !== 'number' || !Number.isFinite(candidate.rest)) return false;
  if (typeof candidate.max !== 'number' || !Number.isFinite(candidate.max)) return false;
  return Math.abs(candidate.max - candidate.rest) >= MIN_CALIBRATION_SPAN;
}

function loadCalibrations(): CalibrationMap {
  try {
    if (typeof localStorage === 'undefined') return {};
    const raw = localStorage.getItem(CALIBRATION_STORAGE_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== 'object') return {};
    const { version, entries } = parsed as Partial<PersistedCalibrations>;
    // Missing (legacy pre-version payload) or mismatched version → the whole
    // stored map is ignored, not just individual entries.
    if (version !== CALIBRATION_STORAGE_VERSION) return {};
    if (entries === null || typeof entries !== 'object') return {};
    const clean: CalibrationMap = {};
    for (const [id, entry] of Object.entries(entries)) {
      if (isValidStoredCalibration(entry)) clean[id] = entry;
    }
    return clean;
  } catch {
    return {}; // corrupt/inaccessible storage — behave as if nothing were ever calibrated
  }
}

function saveCalibrations(map: CalibrationMap): void {
  try {
    if (typeof localStorage === 'undefined') return;
    const payload: PersistedCalibrations = { version: CALIBRATION_STORAGE_VERSION, entries: map };
    localStorage.setItem(CALIBRATION_STORAGE_KEY, JSON.stringify(payload));
  } catch {
    // private-mode/quota — calibration just won't persist past this session
  }
}

/** `?calibrate` forces the wizard to (re-)run even for a standard-mapping pad or one already calibrated. */
function wantsForceCalibrate(): boolean {
  try {
    if (typeof window === 'undefined') return false;
    return new URLSearchParams(window.location.search).has('calibrate');
  } catch {
    return false;
  }
}

function controlKey(kind: 'button' | 'axis', index: number): string {
  return `${kind}:${index}`;
}

/** In-progress calibration: every button/axis's observed [min, max] range so far this window. */
interface ActiveCalibration {
  id: string;
  elapsedSec: number;
  ranges: Map<string, { min: number; max: number }>;
}

function sampleAllControls(pad: Gamepad, ranges: Map<string, { min: number; max: number }>): void {
  pad.buttons.forEach((b, i) => {
    const key = controlKey('button', i);
    const existing = ranges.get(key);
    if (existing) {
      existing.min = Math.min(existing.min, b.value);
      existing.max = Math.max(existing.max, b.value);
    } else {
      ranges.set(key, { min: b.value, max: b.value });
    }
  });
  pad.axes.forEach((v, i) => {
    const key = controlKey('axis', i);
    const existing = ranges.get(key);
    if (existing) {
      existing.min = Math.min(existing.min, v);
      existing.max = Math.max(existing.max, v);
    } else {
      ranges.set(key, { min: v, max: v });
    }
  });
}

/** The control with the largest observed range of motion, or null if nothing moved at all (a flat/idle 5s window). */
function pickBestControl(ranges: Map<string, { min: number; max: number }>): StoredCalibration | null {
  let bestKey: string | null = null;
  let bestRange = 0;
  for (const [key, { min, max }] of ranges) {
    const range = max - min;
    if (range > bestRange) {
      bestRange = range;
      bestKey = key;
    }
  }
  if (bestKey === null) return null;
  const [kindStr, indexStr] = bestKey.split(':');
  const { min, max } = ranges.get(bestKey)!;
  return { kind: kindStr as 'button' | 'axis', index: Number(indexStr), rest: min, max };
}

export interface GamepadThrottleSource extends ThrottleSource {
  /** True once ANY gamepad has ever been observed this session (stays true across a later disconnect) — drives the HUD's connect hint. */
  readonly everConnected: boolean;
  /** True while the 5s auto-calibration wizard is sampling. */
  readonly calibrating: boolean;
  /** Seconds remaining in the calibration window (0 when not calibrating). */
  readonly calibrationSecondsLeft: number;
}

export function createGamepadThrottle(): GamepadThrottleSource {
  let fallback: FallbackControl | null = null;
  let wasConnected = false;
  let everConnected = false;

  const forceCalibrate = wantsForceCalibrate();
  let calibrations = loadCalibrations();
  // Gamepad.ids we've already decided about (calibrated, skipped, or started
  // calibrating) this session — so the auto-trigger fires at most once per id
  // per session, never re-evaluated on every read.
  const evaluatedIds = new Set<string>();
  let active: ActiveCalibration | null = null;

  function finishCalibration(calibration: ActiveCalibration): void {
    const picked = pickBestControl(calibration.ranges);
    if (!picked) return; // nothing moved — leave uncalibrated, fall back to discoverFallback below
    calibrations = { ...calibrations, [calibration.id]: picked };
    saveCalibrations(calibrations);
  }

  function maybeStartCalibration(pad: Gamepad): void {
    if (evaluatedIds.has(pad.id)) return;
    evaluatedIds.add(pad.id);
    const alreadyCalibrated = calibrations[pad.id] !== undefined;
    const shouldCalibrate = forceCalibrate || (pad.mapping !== 'standard' && !alreadyCalibrated);
    if (!shouldCalibrate) return;
    active = { id: pad.id, elapsedSec: 0, ranges: new Map() };
  }

  function readStoredControl(pad: Gamepad, cal: StoredCalibration): number {
    const raw = cal.kind === 'button' ? (pad.buttons[cal.index]?.value ?? 0) : (pad.axes[cal.index] ?? 0);
    const span = cal.max - cal.rest;
    if (Math.abs(span) < 1e-6) return 0; // degenerate calibration (shouldn't happen — pickBestControl requires range > 0)
    return applyDeadzone(clamp01((raw - cal.rest) / span));
  }

  function read(dt: number): number {
    const pad = getFirstPad();
    if (!pad) {
      wasConnected = false;
      fallback = null; // force a fresh scan next time a pad appears
      if (active) {
        // Interrupted mid-calibration: it never produced a result, so this
        // id isn't meaningfully "evaluated" yet — retry fresh on reconnect.
        evaluatedIds.delete(active.id);
        active = null;
      }
      return 0;
    }
    if (!wasConnected) {
      fallback = null; // just (re)connected — re-scan for the active control
    }
    wasConnected = true;
    everConnected = true;

    maybeStartCalibration(pad);

    if (active && active.id === pad.id) {
      active.elapsedSec += dt;
      sampleAllControls(pad, active.ranges);
      if (active.elapsedSec >= CALIBRATION_DURATION_SEC) {
        finishCalibration(active);
        active = null;
      }
      return 0; // no throttle output while the wizard is sampling
    }

    const stored = calibrations[pad.id];
    if (stored) {
      return readStoredControl(pad, stored);
    }

    if (pad.mapping === 'standard') {
      const button = pad.buttons[STANDARD_THROTTLE_BUTTON];
      return applyDeadzone(button ? button.value : 0);
    }

    if (fallback === null) {
      fallback = discoverFallback(pad);
    }
    if (fallback === null) {
      return 0;
    }

    if (fallback.kind === 'button') {
      const button = pad.buttons[fallback.index];
      return applyDeadzone(button ? button.value : 0);
    }
    const axisValue = pad.axes[fallback.index];
    const normalized = axisValue === undefined ? 0 : (axisValue + 1) / 2;
    return applyDeadzone(normalized);
  }

  return {
    read,
    label: 'Gamepad',
    get connected() {
      return getFirstPad() !== null;
    },
    get everConnected() {
      return everConnected;
    },
    get calibrating() {
      return active !== null;
    },
    get calibrationSecondsLeft() {
      return active ? Math.max(0, CALIBRATION_DURATION_SEC - active.elapsedSec) : 0;
    },
  };
}

// =====================================================================
// M8: rumble
// =====================================================================

const DESLOT_RUMBLE = { duration: 300, strongMagnitude: 0.9, weakMagnitude: 0.5 };
const RESLOT_RUMBLE = { duration: 80, strongMagnitude: 0.25, weakMagnitude: 0.15 };

/** Feature-detected, fire-and-forget haptic pulse on the first connected pad — never throws, never surfaces an unhandled rejection. */
function fireRumble(params: { duration: number; strongMagnitude: number; weakMagnitude: number }): void {
  try {
    const pad = getFirstPad();
    const result = pad?.vibrationActuator?.playEffect('dual-rumble', params);
    result?.catch(() => {});
  } catch {
    // haptics unsupported/rejected synchronously — never let this interrupt the sim/render loop
  }
}

/** Player deslot: a strong 300ms dual-rumble pulse. */
export function rumbleOnDeslot(): void {
  fireRumble(DESLOT_RUMBLE);
}

/** Player reslot: a short, light 80ms pulse. */
export function rumbleOnReslot(): void {
  fireRumble(RESLOT_RUMBLE);
}
