// Vintage-scoreboard HUD overlay: a big lap counter with a subtle amber
// accent, race position (P1/P2), last/best lap times (best flashes on
// improvement), a throttle bar, the active input source, and a small muted
// badge. M8 polish over the M2 functional-only layout — still minimal and
// out of the way of the 3D view.
const STYLE_ID = 'm2-hud-style';

/** The established M8 amber accent. */
const AMBER = '#ffb454';

export interface HudUpdate {
  lap: number;
  lastLapSec: number | null;
  bestLapSec: number | null;
  /** Player throttle, 0..1. */
  throttle: number;
  sourceLabel: string;
  /** M6: true while the M-key dev/courtesy mute is active. */
  muted: boolean;
  /** M7: laps to win — renders "LAP n / target" when set (a race). */
  lapTarget?: number;
  /** M7: the AI opponent's lap count, shown as a second line when set (a race). */
  opponentLap?: number | null;
  /** M8: 1 (leading) or 2 (trailing) — set only in race mode (an opponent exists to rank against). */
  position?: 1 | 2;
}

export interface Hud {
  update(state: HudUpdate): void;
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
    .m2-hud__muted-badge {
      display: none;
      margin-top: 4px;
      font-size: 10px;
      letter-spacing: 0.06em;
      color: #ff8a80;
      background: rgba(255, 138, 128, 0.14);
      border: 1px solid rgba(255, 138, 128, 0.4);
      border-radius: 3px;
      padding: 1px 6px;
    }
    .m2-hud__muted-badge--active {
      display: inline-block;
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
  const mutedBadge = document.createElement('div');
  mutedBadge.className = 'm2-hud__muted-badge';
  mutedBadge.textContent = 'MUTED';

  panel.append(lapLine, timesLine, opponentLine, sourceLine, mutedBadge);
  root.appendChild(panel);

  const bar = document.createElement('div');
  bar.className = 'm2-hud__bar';
  const barFill = document.createElement('div');
  barFill.className = 'm2-hud__bar-fill';
  bar.appendChild(barFill);
  root.appendChild(bar);

  container.appendChild(root);

  // Tracks the last bestLapSec we've already flashed for, so the flash
  // fires exactly once per improvement (bestLapSec is monotonically
  // non-increasing per game/race.ts, so "changed" here always means "got
  // better," including the very first lap going from null to a value).
  let lastSeenBest: number | null = null;

  function update(state: HudUpdate): void {
    lapLine.textContent = state.lapTarget ? `LAP ${state.lap}/${state.lapTarget}` : `LAP ${state.lap}`;
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
    mutedBadge.classList.toggle('m2-hud__muted-badge--active', state.muted);

    const clamped = Math.min(1, Math.max(0, state.throttle));
    barFill.style.height = `${(clamped * 100).toFixed(1)}%`;
  }

  return { update };
}
