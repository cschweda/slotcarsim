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

  return { set: render };
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
