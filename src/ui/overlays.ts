// DOM-only overlay factories shown during a race: the numeric countdown
// ("3, 2, 1, GO") and the gamepad calibration wizard prompt. Extracted from
// main.ts (mechanical move — names/signatures/behavior unchanged) so this
// file, like the rest of the DOM-only UI layer (hud.ts, menus.ts), has no
// three.js import and can be imported and exercised under jsdom in isolation:
// importing this module is itself a regression guard against a
// module-evaluation-time ReferenceError (see main.ts's init() for the fuller
// story — that bug class is what this extraction + restructure closes off).

// ---- Countdown overlay ---------------------------------------------------

const COUNTDOWN_STYLE_ID = 'm8-countdown-style';
/** How long "GO" stays visible once shown, regardless of how fast the caller moves on to null (the race phase flips to 'racing' the same instant GO fires). */
const GO_HOLD_MS = 700;

function ensureCountdownStyles(): void {
  if (document.getElementById(COUNTDOWN_STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = COUNTDOWN_STYLE_ID;
  style.textContent = `
    .m8-countdown {
      position: fixed;
      inset: 0;
      z-index: 50;
      display: none;
      align-items: center;
      justify-content: center;
      font-family: 'SFMono-Regular', Menlo, Consolas, monospace;
      font-size: 130px;
      font-weight: 700;
      letter-spacing: 0.02em;
      color: #fff4e6;
      text-shadow: 0 0 30px rgba(255, 214, 170, 0.55), 0 4px 18px rgba(0, 0, 0, 0.7);
      pointer-events: none;
      user-select: none;
    }
    .m8-countdown--go {
      color: #5ee06b;
      text-shadow: 0 0 34px rgba(94, 224, 107, 0.6), 0 4px 18px rgba(0, 0, 0, 0.7);
    }
  `;
  document.head.appendChild(style);
}

export interface CountdownOverlay {
  /** Per-frame update: numbers show immediately; 'GO' holds visible for GO_HOLD_MS regardless of how fast the caller moves on to null (the race phase flips to 'racing' the same instant GO fires). */
  set(text: string | null): void;
  /** Immediate hide, bypassing any pending GO hold — Esc-abort only. */
  hide(): void;
}
export function createCountdownOverlay(host: HTMLElement): CountdownOverlay {
  ensureCountdownStyles();
  const el = document.createElement('div');
  el.className = 'm8-countdown';
  host.appendChild(el);
  let last: string | null = null;
  let goTimer: ReturnType<typeof setTimeout> | undefined;

  function show(text: string): void {
    el.textContent = text;
    el.classList.toggle('m8-countdown--go', text === 'GO');
    el.style.display = 'flex';
  }

  function hide(): void {
    clearTimeout(goTimer);
    goTimer = undefined;
    last = null;
    el.style.display = 'none';
  }

  function set(text: string | null): void {
    if (text === last) return;
    if (text === 'GO') {
      last = text;
      show(text);
      clearTimeout(goTimer);
      goTimer = setTimeout(() => {
        goTimer = undefined;
        if (last === 'GO') {
          last = null;
          el.style.display = 'none';
        }
      }, GO_HOLD_MS);
      return;
    }
    if (text === null) {
      if (goTimer !== undefined) return; // a GO hold is pending — it owns the eventual clear
      last = null;
      el.style.display = 'none';
      return;
    }
    // A genuine new number (3/2/1): cancel any stray GO timer from a
    // previous countdown and show it immediately.
    clearTimeout(goTimer);
    goTimer = undefined;
    last = text;
    show(text);
  }

  return { set, hide };
}

// ---- Gamepad calibration overlay ------------------------------------------

const CALIBRATION_STYLE_ID = 'm8-calibration-style';

function ensureCalibrationStyles(): void {
  if (document.getElementById(CALIBRATION_STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = CALIBRATION_STYLE_ID;
  style.textContent = `
    .m8-calibration {
      position: fixed;
      inset: 0;
      z-index: 60;
      display: none;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      gap: 10px;
      font-family: 'SFMono-Regular', Menlo, Consolas, monospace;
      text-align: center;
      pointer-events: none;
      user-select: none;
      background: rgba(6, 6, 8, 0.55);
    }
    .m8-calibration__title {
      font-size: 30px;
      font-weight: 700;
      letter-spacing: 0.04em;
      color: #ffb454;
      text-shadow: 0 4px 18px rgba(0, 0, 0, 0.8);
    }
    .m8-calibration__sub {
      font-size: 15px;
      color: #e8e8e8;
      opacity: 0.85;
    }
  `;
  document.head.appendChild(style);
}

export interface CalibrationOverlay {
  /** Show/update the wizard while `active`; hides once `active` is false. */
  set(active: boolean, secondsLeft: number): void;
}

// ---- Sound toggle ---------------------------------------------------------

const SOUND_TOGGLE_STYLE_ID = 'm9-sound-toggle-style';

function ensureSoundToggleStyles(): void {
  if (document.getElementById(SOUND_TOGGLE_STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = SOUND_TOGGLE_STYLE_ID;
  style.textContent = `
    .m9-sound-toggle {
      position: fixed;
      top: 12px;
      right: 12px;
      z-index: 110;
      display: block;
      font-family: 'SFMono-Regular', Menlo, Consolas, monospace;
      font-size: 13px;
      font-weight: 600;
      letter-spacing: 0.03em;
      color: #e8e8e8;
      background: rgba(10, 10, 12, 0.72);
      border: 1px solid rgba(255, 180, 84, 0.22);
      border-radius: 6px;
      padding: 8px 12px;
      cursor: pointer;
      user-select: none;
      white-space: nowrap;
    }
    .m9-sound-toggle:hover {
      border-color: rgba(255, 180, 84, 0.5);
    }
  `;
  document.head.appendChild(style);
}

export interface SoundToggle {
  /**
   * Reflects `on` in the button's label + `aria-pressed`. Never drives audio
   * itself — main.ts's own mute flag is the single source of truth; it calls
   * this AFTER actually applying a change, the same way whether that change
   * came from this button's click or the 'M' keyboard shortcut, so the two
   * can never disagree about the current state.
   */
  set(on: boolean): void;
  /** The button's own root DOM node — exposed so main.ts can measure its real layout (getBoundingClientRect) for the stats bar's dynamic left/right positioning (see ui/statsBar.ts's computeStatsBarBounds). Used in preference to the MENU button as "the SOUND/MENU column"'s reference point since this one is always visible once created, unlike MENU (hidden outside a live session). */
  root: HTMLElement;
}

/**
 * Persistent top-right "SOUND: ON/OFF" button. Meant to be mounted once
 * (main.ts does so right after the start gate is dismissed) and left in the
 * DOM for the rest of the session — a z-index above the menu system's (100)
 * full-screen dialogs keeps it visible and clickable over the setup menu,
 * countdown, racing, and results alike, satisfying "prominent, always
 * available" without any per-phase show/hide logic of its own.
 */
export function createSoundToggle(
  host: HTMLElement,
  options: { initialOn: boolean; onToggle: () => void },
): SoundToggle {
  ensureSoundToggleStyles();

  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'm9-sound-toggle';
  host.appendChild(button);

  function render(on: boolean): void {
    button.textContent = on ? '🔊 SOUND: ON' : '🔇 SOUND: OFF';
    button.setAttribute('aria-pressed', on ? 'true' : 'false');
    button.setAttribute('aria-label', on ? 'Sound is on — click to mute' : 'Sound is off — click to unmute');
  }

  render(options.initialOn);
  button.addEventListener('click', options.onToggle);

  return { set: render, root: button };
}

// ---- Menu button -----------------------------------------------------------
// M10: a discoverable, clickable way back to the setup menu — Esc already
// does this, but is invisible to mouse/gamepad players who never learn a
// keyboard shortcut exists. Stacks directly below the sound toggle (same
// fixed top-right corner, same visual style) so the two read as a matched
// pair of always-available session controls.

const MENU_BUTTON_STYLE_ID = 'm10-menu-button-style';

function ensureMenuButtonStyles(): void {
  if (document.getElementById(MENU_BUTTON_STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = MENU_BUTTON_STYLE_ID;
  style.textContent = `
    .m10-menu-button {
      position: fixed;
      top: 54px;
      right: 12px;
      z-index: 110;
      display: none;
      font-family: 'SFMono-Regular', Menlo, Consolas, monospace;
      font-size: 13px;
      font-weight: 600;
      letter-spacing: 0.03em;
      color: #e8e8e8;
      background: rgba(10, 10, 12, 0.72);
      border: 1px solid rgba(255, 180, 84, 0.22);
      border-radius: 6px;
      padding: 8px 12px;
      cursor: pointer;
      user-select: none;
      white-space: nowrap;
    }
    .m10-menu-button:hover {
      border-color: rgba(255, 180, 84, 0.5);
    }
    .m10-menu-button--visible {
      display: block;
    }
  `;
  document.head.appendChild(style);
}

export interface MenuButton {
  /** Shown only while a race is actually live (countdown/racing) — the menu/results screens already have their own way back, and the idle default session sits behind either the start gate or an already-open menu. */
  setVisible(visible: boolean): void;
}

/**
 * Persistent top-right "MENU" button. Clicking it runs the EXACT same
 * abort-to-menu path as pressing Esc (main.ts funnels both through one
 * function) — this is purely a discoverability affordance for players who'd
 * never find the keyboard shortcut, not a second code path to keep in sync.
 */
export function createMenuButton(host: HTMLElement, onClick: () => void): MenuButton {
  ensureMenuButtonStyles();

  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'm10-menu-button';
  button.textContent = '☰ MENU';
  button.setAttribute('aria-label', 'Return to the setup menu');
  host.appendChild(button);
  button.addEventListener('click', onClick);

  function setVisible(visible: boolean): void {
    button.classList.toggle('m10-menu-button--visible', visible);
  }

  return { setVisible };
}

export function createCalibrationOverlay(host: HTMLElement): CalibrationOverlay {
  ensureCalibrationStyles();

  const el = document.createElement('div');
  el.className = 'm8-calibration';
  const title = document.createElement('div');
  title.className = 'm8-calibration__title';
  title.textContent = 'SQUEEZE AND RELEASE THE TRIGGER';
  const sub = document.createElement('div');
  sub.className = 'm8-calibration__sub';
  el.append(title, sub);
  host.appendChild(el);

  let shown = false;

  function set(active: boolean, secondsLeft: number): void {
    if (active) {
      shown = true;
      sub.textContent = `Calibrating your gamepad… ${Math.max(0, Math.ceil(secondsLeft))}s`;
      el.style.display = 'flex';
    } else if (shown) {
      shown = false;
      el.style.display = 'none';
    }
  }

  return { set };
}

// ---- M11b: instant replay button + banner ---------------------------------
// A discoverable, clickable way to trigger/end instant replay — stacked
// directly below the MENU button (same top-right corner, same matched-pair
// visual style as SOUND/MENU), and a small top-center banner shown only
// while a replay is actually playing.

const REPLAY_BUTTON_STYLE_ID = 'm11b-replay-button-style';

function ensureReplayButtonStyles(): void {
  if (document.getElementById(REPLAY_BUTTON_STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = REPLAY_BUTTON_STYLE_ID;
  style.textContent = `
    .m11b-replay-button {
      position: fixed;
      top: 96px;
      right: 12px;
      z-index: 110;
      display: none;
      font-family: 'SFMono-Regular', Menlo, Consolas, monospace;
      font-size: 13px;
      font-weight: 600;
      letter-spacing: 0.03em;
      color: #e8e8e8;
      background: rgba(10, 10, 12, 0.72);
      border: 1px solid rgba(255, 180, 84, 0.22);
      border-radius: 6px;
      padding: 8px 12px;
      cursor: pointer;
      user-select: none;
      white-space: nowrap;
    }
    .m11b-replay-button:hover {
      border-color: rgba(255, 180, 84, 0.5);
    }
    .m11b-replay-button--visible {
      display: block;
    }
  `;
  document.head.appendChild(style);
}

export interface ReplayButton {
  /** Visible whenever a live session could start a replay (its buffer has enough recorded ticks) OR one is already playing (so the SAME button always offers a way to end it early — main.ts funnels both directions through one toggle function, same pattern as the MENU button's abortToMenu()). */
  setVisible(visible: boolean): void;
}

/**
 * Persistent top-right "REPLAY" button, stacked below MENU. Its click always
 * runs main.ts's one toggleReplay() path — entering a replay if none is
 * active, ending the current one early otherwise — so this button and the
 * `R` key can never disagree about what a click/press does.
 */
export function createReplayButton(host: HTMLElement, onClick: () => void): ReplayButton {
  ensureReplayButtonStyles();

  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'm11b-replay-button';
  button.textContent = '⟲ REPLAY';
  button.setAttribute('aria-label', 'Replay the last few seconds — press again, or Esc, to end early');
  host.appendChild(button);
  button.addEventListener('click', onClick);

  function setVisible(visible: boolean): void {
    button.classList.toggle('m11b-replay-button--visible', visible);
  }

  return { setVisible };
}

const REPLAY_BANNER_STYLE_ID = 'm11b-replay-banner-style';

function ensureReplayBannerStyles(): void {
  if (document.getElementById(REPLAY_BANNER_STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = REPLAY_BANNER_STYLE_ID;
  style.textContent = `
    .m11b-replay-banner {
      position: fixed;
      top: 54px;
      left: 50%;
      transform: translateX(-50%);
      z-index: 45;
      display: none;
      flex-direction: column;
      align-items: center;
      gap: 6px;
      pointer-events: none;
      user-select: none;
    }
    .m11b-replay-banner--visible {
      display: flex;
    }
    .m11b-replay-banner__label {
      font-family: 'SFMono-Regular', Menlo, Consolas, monospace;
      font-size: 15px;
      font-weight: 700;
      letter-spacing: 0.08em;
      color: #ffb454;
      text-shadow: 0 4px 14px rgba(0, 0, 0, 0.8);
      background: rgba(10, 10, 12, 0.72);
      border: 1px solid rgba(255, 180, 84, 0.35);
      border-radius: 6px;
      padding: 4px 14px;
    }
    .m11b-replay-banner__track {
      width: 160px;
      height: 3px;
      border-radius: 2px;
      background: rgba(255, 255, 255, 0.16);
      overflow: hidden;
    }
    .m11b-replay-banner__fill {
      height: 100%;
      width: 0%;
      background: #ffb454;
    }
  `;
  document.head.appendChild(style);
}

export interface ReplayBanner {
  /** Shows/hides the "REPLAY" banner; while `active`, `progress` (0..1, clamped) fills the thin bar under the label — how far through the captured window playback has reached (game/replay.ts's PlaybackCursor.progress). */
  set(active: boolean, progress: number): void;
}

export function createReplayBanner(host: HTMLElement): ReplayBanner {
  ensureReplayBannerStyles();

  const el = document.createElement('div');
  el.className = 'm11b-replay-banner';
  const label = document.createElement('div');
  label.className = 'm11b-replay-banner__label';
  label.textContent = 'REPLAY';
  const track = document.createElement('div');
  track.className = 'm11b-replay-banner__track';
  const fill = document.createElement('div');
  fill.className = 'm11b-replay-banner__fill';
  track.appendChild(fill);
  el.append(label, track);
  host.appendChild(el);

  function set(active: boolean, progress: number): void {
    el.classList.toggle('m11b-replay-banner--visible', active);
    if (active) {
      const pct = Math.round(Math.min(1, Math.max(0, progress)) * 100);
      fill.style.width = `${pct}%`;
    }
  }

  return { set };
}
