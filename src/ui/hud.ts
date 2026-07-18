// Vintage-scoreboard HUD overlay: a big lap counter with a subtle amber
// accent, race position (P1/P2), last/best lap times (best flashes on
// improvement), a throttle bar, and the active input source. M8 polish over
// the M2 functional-only layout — still minimal and out of the way of the 3D
// view. M9 removed the "MUTED" badge that used to live here: the persistent
// top-right sound toggle button (ui/overlays.ts) now carries that state, so
// this HUD doesn't duplicate it. M10 adds a practice-mode header variant and
// a transient flashMessage() (the practice [ ]/[ ] live stickiness change).
const STYLE_ID = 'm2-hud-style';

/** The established M8 amber accent. */
const AMBER = '#ffb454';
/** How long a flashMessage() stays visible before fading out, in ms (must match the CSS animation duration below). */
const FLASH_DURATION_MS = 1500;

export interface HudUpdate {
  lap: number;
  lastLapSec: number | null;
  bestLapSec: number | null;
  /** Player throttle, 0..1. */
  throttle: number;
  sourceLabel: string;
  /** M7: laps to win — renders "LAP n / target" when set (a race). */
  lapTarget?: number;
  /** M7: the AI opponent's lap count, shown as a second line when set (a race, or M10 practice with an AI companion). */
  opponentLap?: number | null;
  /** M8: 1 (leading) or 2 (trailing) — set only in race mode (an opponent exists to rank against; practice never sets this, even with an AI companion — no competition framing). */
  position?: 1 | 2;
  /** M8: show the subtle "squeeze the trigger to connect a gamepad" hint — true until any gamepad has ever been seen. */
  showGamepadHint?: boolean;
  /** M10: practice mode — replaces the "LAP n" header with "PRACTICE · LAP n". */
  practice?: boolean;
  /** M13: current camera view — a small badge appears for chase/cockpit (table = no badge). */
  cameraView?: 'table' | 'chase' | 'cockpit';
  /** M13: in cockpit, whether time is running at ½× (default) or 1× (T pressed) — drives the badge's ½×/1× suffix. */
  cockpitHalfSpeed?: boolean;
}

export interface Hud {
  update(state: HudUpdate): void;
  /** M10: briefly flash a short message (e.g. a stickiness level name) near the lap counter, fading out over ~1.5s. Re-triggerable — a new call while one is still fading restarts the animation. */
  flashMessage(text: string): void;
  /** The HUD's own root DOM node — exposed so main.ts can measure its real layout (getBoundingClientRect) for the stats bar's dynamic left/right positioning (see ui/statsBar.ts's computeStatsBarBounds). */
  root: HTMLElement;
}

function ensureStyles(): void {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = `
    .m2-hud {
      position: fixed;
      top: 12px;
      left: 12px;
      z-index: 10;
      display: flex;
      gap: 10px;
      align-items: stretch;
      font-family: 'SFMono-Regular', Menlo, Consolas, monospace;
      color: #e8e8e8;
      pointer-events: none;
    }
    .m2-hud__panel {
      background: rgba(10, 10, 12, 0.72);
      border: 1px solid rgba(255, 180, 84, 0.22);
      border-radius: 6px;
      padding: 8px 12px;
      font-size: 13px;
      line-height: 1.6;
      white-space: nowrap;
    }
    .m2-hud__lap {
      font-size: 22px;
      font-weight: 700;
      color: ${AMBER};
      letter-spacing: 0.02em;
    }
    .m2-hud__position {
      margin-left: 9px;
      font-size: 13px;
      font-weight: 700;
      color: #9fd3ff;
      vertical-align: middle;
    }
    .m2-hud__times {
      margin-top: 2px;
      opacity: 0.92;
    }
    .m2-hud__best {
      display: inline-block;
      border-radius: 3px;
    }
    .m2-hud__best--flash {
      animation: m2-hud-flash 0.7s ease-out;
    }
    @keyframes m2-hud-flash {
      0% { color: ${AMBER}; text-shadow: 0 0 10px rgba(255, 180, 84, 0.9); }
      100% { color: inherit; text-shadow: none; }
    }
    .m2-hud__source {
      opacity: 0.7;
      font-size: 11px;
      margin-top: 4px;
    }
    .m2-hud__view {
      display: none;
      margin-top: 5px;
      font-size: 11px;
      font-weight: 700;
      letter-spacing: 0.06em;
      color: #9fd3ff;
    }
    .m2-hud__view--show { display: block; }
    .m2-hud__view-speed {
      margin-left: 6px;
      padding: 0 5px;
      border-radius: 3px;
      color: #0e0c0a;
      background: ${AMBER};
    }
    .m2-hud__view-speed--full {
      color: ${AMBER};
      background: transparent;
      border: 1px solid rgba(255, 180, 84, 0.5);
    }
    .m2-hud__gamepad-hint {
      display: none;
      margin-top: 4px;
      font-size: 11px;
      opacity: 0.55;
      font-style: italic;
    }
    .m2-hud__gamepad-hint--active {
      display: block;
    }
    .m2-hud__bar {
      width: 14px;
      background: rgba(10, 10, 12, 0.72);
      border: 1px solid rgba(255, 180, 84, 0.22);
      border-radius: 3px;
      position: relative;
      overflow: hidden;
    }
    .m2-hud__bar-fill {
      position: absolute;
      left: 0;
      right: 0;
      bottom: 0;
      background: #5ee06b;
      height: 0%;
    }
    .m2-hud__flash {
      position: fixed;
      top: 56px;
      left: 50%;
      transform: translateX(-50%);
      z-index: 15;
      font-size: 20px;
      font-weight: 700;
      letter-spacing: 0.06em;
      color: ${AMBER};
      text-shadow: 0 0 16px rgba(255, 180, 84, 0.7), 0 2px 8px rgba(0, 0, 0, 0.8);
      opacity: 0;
      pointer-events: none;
      white-space: nowrap;
    }
    .m2-hud__flash--show {
      animation: m2-hud-message-flash ${FLASH_DURATION_MS}ms ease-out;
    }
    @keyframes m2-hud-message-flash {
      0% { opacity: 0; transform: translateX(-50%) translateY(-4px); }
      12% { opacity: 1; transform: translateX(-50%) translateY(0); }
      75% { opacity: 1; }
      100% { opacity: 0; }
    }
  `;
  document.head.appendChild(style);
}

function formatLapTime(sec: number | null): string {
  return sec === null ? '—' : sec.toFixed(3);
}

export function createHud(container: HTMLElement): Hud {
  ensureStyles();

  const root = document.createElement('div');
  root.className = 'm2-hud';

  const panel = document.createElement('div');
  panel.className = 'm2-hud__panel';

  // Built from DOM nodes (textContent / persistent child spans), not
  // innerHTML — sourceLabel already only ever comes from our own
  // ThrottleSource constants, but this way there is no HTML-injection
  // surface at all, now or if that ever changes.
  const lapLine = document.createElement('div');
  lapLine.className = 'm2-hud__lap';
  const positionBadge = document.createElement('span');
  positionBadge.className = 'm2-hud__position';

  const timesLine = document.createElement('div');
  timesLine.className = 'm2-hud__times';
  const bestSpan = document.createElement('span');
  bestSpan.className = 'm2-hud__best';

  const opponentLine = document.createElement('div');
  opponentLine.className = 'm2-hud__source';
  const sourceLine = document.createElement('div');
  sourceLine.className = 'm2-hud__source';
  const gamepadHintLine = document.createElement('div');
  gamepadHintLine.className = 'm2-hud__gamepad-hint';
  gamepadHintLine.textContent = 'Squeeze the trigger to connect a gamepad';

  // M13: camera-view badge (with the cockpit ½×/1× time-scale chip).
  const viewLine = document.createElement('div');
  viewLine.className = 'm2-hud__view';
  const viewName = document.createElement('span');
  const viewSpeed = document.createElement('span');
  viewSpeed.className = 'm2-hud__view-speed';
  viewLine.append(viewName, viewSpeed);

  panel.append(lapLine, timesLine, opponentLine, sourceLine, gamepadHintLine, viewLine);
  root.appendChild(panel);

  const bar = document.createElement('div');
  bar.className = 'm2-hud__bar';
  const barFill = document.createElement('div');
  barFill.className = 'm2-hud__bar-fill';
  bar.appendChild(barFill);
  root.appendChild(bar);

  container.appendChild(root);

  // M10: transient flash message (e.g. the new stickiness level name),
  // fixed-positioned on its own — not a panel child — so it stays centered
  // regardless of the panel's own variable width.
  const flashEl = document.createElement('div');
  flashEl.className = 'm2-hud__flash';
  container.appendChild(flashEl);

  // Tracks the last bestLapSec we've already flashed for, so the flash
  // fires exactly once per improvement (bestLapSec is monotonically
  // non-increasing per game/race.ts, so "changed" here always means "got
  // better," including the very first lap going from null to a value).
  let lastSeenBest: number | null = null;

  function update(state: HudUpdate): void {
    lapLine.textContent = state.practice
      ? `PRACTICE · LAP ${state.lap}`
      : state.lapTarget
        ? `LAP ${state.lap}/${state.lapTarget}`
        : `LAP ${state.lap}`;
    if (state.position !== undefined) {
      positionBadge.textContent = `P${state.position}`;
      lapLine.appendChild(positionBadge);
    }

    bestSpan.textContent = formatLapTime(state.bestLapSec);
    timesLine.replaceChildren(`LAST ${formatLapTime(state.lastLapSec)} · BEST `, bestSpan);

    if (state.bestLapSec !== null && state.bestLapSec !== lastSeenBest) {
      lastSeenBest = state.bestLapSec;
      bestSpan.classList.remove('m2-hud__best--flash');
      void bestSpan.offsetWidth; // force reflow so re-adding the class restarts the animation
      bestSpan.classList.add('m2-hud__best--flash');
    }

    if (state.opponentLap === undefined || state.opponentLap === null) {
      opponentLine.textContent = '';
    } else {
      opponentLine.textContent = `AI ${state.opponentLap}${state.lapTarget ? `/${state.lapTarget}` : ''}`;
    }
    sourceLine.textContent = state.sourceLabel;
    gamepadHintLine.classList.toggle('m2-hud__gamepad-hint--active', state.showGamepadHint === true);

    const clamped = Math.min(1, Math.max(0, state.throttle));
    barFill.style.height = `${(clamped * 100).toFixed(1)}%`;

    // M13: camera-view badge — shown for chase/cockpit only; cockpit carries a
    // ½× (default) or 1× (T pressed) time-scale chip.
    const view = state.cameraView;
    const showView = view === 'chase' || view === 'cockpit';
    viewLine.classList.toggle('m2-hud__view--show', showView);
    if (showView) {
      viewName.textContent = view === 'cockpit' ? '● COCKPIT' : '● CHASE';
      if (view === 'cockpit') {
        const full = state.cockpitHalfSpeed === false;
        viewSpeed.textContent = full ? '1×' : '½×';
        viewSpeed.classList.toggle('m2-hud__view-speed--full', full);
        viewSpeed.style.display = '';
      } else {
        viewSpeed.style.display = 'none';
      }
    }
  }

  function flashMessage(text: string): void {
    flashEl.textContent = text;
    flashEl.classList.remove('m2-hud__flash--show');
    void flashEl.offsetWidth; // force reflow so re-adding the class restarts the animation, same trick as the best-lap flash
    flashEl.classList.add('m2-hud__flash--show');
  }

  return { update, flashMessage, root };
}
