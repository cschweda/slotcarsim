// Slim top-center "stats bar": current speed (raw + HO scale-equivalent
// mph), the player's session lap/crash tallies, rolling FPS, and the sim's
// (permanently fixed) tick rate — visible alongside the HUD only while a
// session is actually live (countdown/racing, any mode; main.ts owns that
// gate). Pure formatters are exported/tested independently of the DOM
// factory, the same split hud.ts's formatLapTime uses.
const STYLE_ID = 'm11-stats-bar-style';

/** Aurora AFX HO scale: 1:64. */
const HO_SCALE_FACTOR = 64;
const MS_TO_MPH = 2.23694;
/** The sim's tick rate is a structural constant (src/loop.ts's DEFAULT_DT = 1/120) — a plain literal, never computed, since it can't vary at runtime. */
export const TICK_RATE_LABEL = '120 Hz';

/** A real-world speed rescaled to what it would be at HO (1:64) scale — the "scale mph" HO slot-car racers actually talk in (3 m/s ≈ 429 scale mph). */
export function scaleMph(vMetersPerSec: number): number {
  return vMetersPerSec * HO_SCALE_FACTOR * MS_TO_MPH;
}

export function formatSpeed(vMetersPerSec: number): string {
  return `SPEED ${vMetersPerSec.toFixed(2)} m/s`;
}

export function formatScaleMph(vMetersPerSec: number): string {
  return `≈${Math.round(scaleMph(vMetersPerSec))} scale mph`;
}

export function formatLaps(laps: number): string {
  return `LAPS ${laps}`;
}

export function formatCrashes(crashes: number): string {
  return `CRASHES ${crashes}`;
}

export function formatAiCrashes(aiCrashes: number): string {
  return `AI CRASHES ${aiCrashes}`;
}

export function formatFps(fps: number): string {
  return `${Math.round(fps)} FPS`;
}

export interface StatsBarUpdate {
  /** Player car's current speed, m/s. */
  speedMs: number;
  /** Player session lap total. */
  laps: number;
  /** Player deslots this session. */
  crashes: number;
  /** AI deslots this session — omit entirely (not just 0) when this session has no AI car; it's then left out of the rendered line. */
  aiCrashes?: number;
  /** Rolling-measured render fps. */
  fps: number;
}

export interface StatsBar {
  update(state: StatsBarUpdate): void;
  /** Shown only while a session is actually live (countdown/racing) — same gating convention as the M10 on-screen MENU button. */
  setVisible(visible: boolean): void;
}

function ensureStyles(): void {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = `
    .m11-stats-bar-row {
      position: fixed;
      top: 12px;
      /* Reserve the left cluster (HUD, ~328px at its widest observed
         content per ui/coach.ts's own measured comment, PLUS the COACH
         widget when a session has it on: left:350px + ~60px box) and the
         right cluster (the stacked SOUND/MENU buttons' own column) so the
         bar centers in the space actually BETWEEN them instead of on the
         canvas's raw midpoint -- which, on a narrower canvas (e.g. the tune
         dev panel docked), used to land the bar right on top of the COACH
         widget. left/right are relative to the containing block's OWN
         edges (canvasHost, via its own contain:layout), so this holds at
         any canvas width, not just the one it was eyeballed at. */
      left: 420px;
      right: 170px;
      z-index: 10;
      display: flex;
      justify-content: center;
      pointer-events: none;
    }
    .m11-stats-bar {
      display: none;
      /* A flex item's default min-width is "auto" (its content's natural
         width) — with nowrap text that refuses to shrink below the full
         line's width no matter how little room the row above actually has,
         defeating the whole point of reserving that space. min-width: 0
         lets it actually shrink to fit; overflow/text-overflow then
         truncate gracefully (real text, just visually clipped) instead of
         spilling out over the HUD/COACH/SOUND/MENU on either side. */
      min-width: 0;
      max-width: 100%;
      overflow: hidden;
      text-overflow: ellipsis;
      font-family: 'SFMono-Regular', Menlo, Consolas, monospace;
      font-size: 12px;
      letter-spacing: 0.02em;
      color: #e8e8e8;
      background: rgba(10, 10, 12, 0.72);
      border: 1px solid rgba(255, 180, 84, 0.22);
      border-radius: 6px;
      padding: 8px 12px;
      white-space: nowrap;
    }
    .m11-stats-bar--visible {
      display: block;
    }
  `;
  document.head.appendChild(style);
}

/**
 * Mounts the top-center stats strip into `host` (main.ts passes canvasHost —
 * the same element the HUD and sound/menu buttons mount into — whose own
 * `contain: layout` makes the outer row's `position: fixed` resolve against
 * the canvas's own box, not the whole window, so it never drifts under the
 * docked tuning panel). The outer `.m11-stats-bar-row` is a non-interactive
 * flex strip that reserves space for the HUD/COACH cluster on the left and
 * the SOUND/MENU column on the right, centering the actual visible bar in
 * what's left between them (see ensureStyles' own comment) — "top-center"
 * relative to the OTHER overlays, not the raw canvas midpoint. Starts
 * hidden; main.ts's frame loop toggles setVisible() and feeds update() every
 * frame while a session is live.
 */
export function createStatsBar(host: HTMLElement): StatsBar {
  ensureStyles();

  const row = document.createElement('div');
  row.className = 'm11-stats-bar-row';
  host.appendChild(row);

  const el = document.createElement('div');
  el.className = 'm11-stats-bar';
  row.appendChild(el);

  function update(state: StatsBarUpdate): void {
    const parts = [
      formatSpeed(state.speedMs),
      formatScaleMph(state.speedMs),
      formatLaps(state.laps),
      formatCrashes(state.crashes),
    ];
    if (state.aiCrashes !== undefined) parts.push(formatAiCrashes(state.aiCrashes));
    parts.push(formatFps(state.fps), TICK_RATE_LABEL);
    el.textContent = parts.join(' · ');
  }

  function setVisible(visible: boolean): void {
    el.classList.toggle('m11-stats-bar--visible', visible);
  }

  return { update, setVisible };
}
