// Real-time throttle-coach HUD widget: a vertical "COACH" strip near the
// HUD's throttle bar — a big 3-state lamp (▲ GO / ● HOLD / ▼ BRAKE) with a
// text label, plus a thin headroom gauge — updated once per frame from
// game/coach.ts's advise() output. DOM-only; carries no sim/coach logic of
// its own. Mounted persistently (like the HUD itself) but only ever VISIBLE
// for a session with the Coach menu row on — see setVisible(), driven by
// main.ts from the session's RaceConfig.coach.
import type { CoachZone } from '../game/coach';

const STYLE_ID = 'm10-coach-style';

const ZONE_META: Record<CoachZone, { symbol: string; label: string; color: string }> = {
  go: { symbol: '▲', label: 'GO', color: '#5ee06b' },
  hold: { symbol: '●', label: 'HOLD', color: '#ffb454' },
  brake: { symbol: '▼', label: 'BRAKE', color: '#ff5252' },
};

export interface CoachWidget {
  /** Show/hide the whole widget — off for any session with the Coach row off. */
  setVisible(visible: boolean): void;
  /** Per-frame update from game/coach.ts's Coach.advise() output. */
  update(advice: { zone: CoachZone; headroom: number }): void;
}

function ensureStyles(): void {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = `
    .m10-coach {
      position: fixed;
      top: 12px;
      left: 350px;
      z-index: 10;
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 2px;
      width: 46px;
      padding: 8px 6px;
      background: rgba(10, 10, 12, 0.72);
      border: 1px solid rgba(255, 180, 84, 0.22);
      border-radius: 6px;
      font-family: 'SFMono-Regular', Menlo, Consolas, monospace;
      pointer-events: none;
      user-select: none;
    }
    .m10-coach--hidden {
      display: none;
    }
    .m10-coach__heading {
      font-size: 9px;
      font-weight: 700;
      letter-spacing: 0.08em;
      color: #9fd3ff;
      opacity: 0.85;
      margin-bottom: 4px;
    }
    .m10-coach__lamp {
      font-size: 22px;
      line-height: 1;
    }
    .m10-coach__label {
      font-size: 10px;
      font-weight: 700;
      letter-spacing: 0.05em;
      margin-top: 2px;
    }
    .m10-coach__gauge {
      margin-top: 6px;
      width: 10px;
      height: 48px;
      background: rgba(0, 0, 0, 0.35);
      border: 1px solid rgba(255, 255, 255, 0.14);
      border-radius: 3px;
      position: relative;
      overflow: hidden;
    }
    .m10-coach__gauge-fill {
      position: absolute;
      left: 0;
      right: 0;
      bottom: 0;
      height: 0%;
    }
  `;
  document.head.appendChild(style);
}

/**
 * Mounted next to (immediately right of) the HUD's own throttle bar. The HUD
 * panel's width varies with its longest line (e.g. "PRACTICE · LAP 0"), so
 * left:350px is a fixed, measured-with-margin offset (the panel + bar
 * together measure ~328px at their widest observed content) rather than
 * something derived from the HUD's own layout — simplest given the HUD
 * doesn't expose a mount point of its own, and this only needs to clear it,
 * not track it exactly.
 */
export function createCoachWidget(container: HTMLElement): CoachWidget {
  ensureStyles();

  const root = document.createElement('div');
  root.className = 'm10-coach m10-coach--hidden';

  const heading = document.createElement('div');
  heading.className = 'm10-coach__heading';
  heading.textContent = 'COACH';

  const lamp = document.createElement('div');
  lamp.className = 'm10-coach__lamp';
  const zoneLabel = document.createElement('div');
  zoneLabel.className = 'm10-coach__label';

  const gauge = document.createElement('div');
  gauge.className = 'm10-coach__gauge';
  const gaugeFill = document.createElement('div');
  gaugeFill.className = 'm10-coach__gauge-fill';
  gauge.appendChild(gaugeFill);

  root.append(heading, lamp, zoneLabel, gauge);
  container.appendChild(root);

  function setVisible(visible: boolean): void {
    root.classList.toggle('m10-coach--hidden', !visible);
  }

  function update(advice: { zone: CoachZone; headroom: number }): void {
    const meta = ZONE_META[advice.zone];
    lamp.textContent = meta.symbol;
    lamp.style.color = meta.color;
    zoneLabel.textContent = meta.label;
    zoneLabel.style.color = meta.color;
    const clamped = Math.min(1, Math.max(0, advice.headroom));
    gaugeFill.style.height = `${(clamped * 100).toFixed(1)}%`;
    gaugeFill.style.background = meta.color;
  }

  return { setVisible, update };
}
