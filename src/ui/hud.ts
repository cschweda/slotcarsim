// Minimal always-on HUD overlay: lap/last/best times, a throttle bar, and the
// active input source. Deliberate visual polish (fonts, layout, animation) is
// M8 — this is functional, legible, and out of the way of the 3D view.
const STYLE_ID = 'm2-hud-style';

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
      border: 1px solid rgba(255, 255, 255, 0.14);
      border-radius: 6px;
      padding: 8px 12px;
      font-size: 13px;
      line-height: 1.7;
      white-space: nowrap;
    }
    .m2-hud__source {
      opacity: 0.7;
      font-size: 11px;
    }
    .m2-hud__muted {
      display: none;
      color: #ff8a80;
      font-size: 11px;
      letter-spacing: 0.06em;
      margin-top: 2px;
    }
    .m2-hud__muted--active {
      display: block;
    }
    .m2-hud__bar {
      width: 14px;
      background: rgba(10, 10, 12, 0.72);
      border: 1px solid rgba(255, 255, 255, 0.14);
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

  // Built from DOM nodes (textContent), not innerHTML — sourceLabel already
  // only ever comes from our own ThrottleSource constants, but this way
  // there is no HTML-injection surface at all, now or if that ever changes.
  const lapLine = document.createElement('div');
  const opponentLine = document.createElement('div');
  opponentLine.className = 'm2-hud__source';
  const sourceLine = document.createElement('div');
  sourceLine.className = 'm2-hud__source';
  const mutedLine = document.createElement('div');
  mutedLine.className = 'm2-hud__muted';
  mutedLine.textContent = 'MUTED';
  panel.appendChild(lapLine);
  panel.appendChild(opponentLine);
  panel.appendChild(sourceLine);
  panel.appendChild(mutedLine);
  root.appendChild(panel);

  const bar = document.createElement('div');
  bar.className = 'm2-hud__bar';
  const barFill = document.createElement('div');
  barFill.className = 'm2-hud__bar-fill';
  bar.appendChild(barFill);
  root.appendChild(bar);

  container.appendChild(root);

  function update(state: HudUpdate): void {
    const lapText = state.lapTarget ? `LAP ${state.lap}/${state.lapTarget}` : `LAP ${state.lap}`;
    lapLine.textContent =
      `${lapText} · LAST ${formatLapTime(state.lastLapSec)} · BEST ${formatLapTime(state.bestLapSec)}`;
    if (state.opponentLap === undefined || state.opponentLap === null) {
      opponentLine.textContent = '';
    } else {
      opponentLine.textContent = `AI ${state.opponentLap}${state.lapTarget ? `/${state.lapTarget}` : ''}`;
    }
    sourceLine.textContent = state.sourceLabel;
    mutedLine.classList.toggle('m2-hud__muted--active', state.muted);

    const clamped = Math.min(1, Math.max(0, state.throttle));
    barFill.style.height = `${(clamped * 100).toFixed(1)}%`;
  }

  return { update };
}
