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

// ---- Layout: left/right derived from the REAL neighbor geometry ----------
// Fix round 1 (post-M11a review): this bar used to reserve a hand-measured
// `left: 420px; right: 170px` — correct only as long as COACH's/HUD's/the
// SOUND+MENU column's own widths never changed (a longer label, different
// font metrics, or the dev tuning panel narrowing canvasHost could all have
// quietly broken it with no warning, since nothing here ever looked at their
// ACTUAL rendered size). Everything below measures the real neighbor
// elements instead, every time it might matter (mount / window resize /
// session rebuild — see createStatsBar and its `reposition()`), and derives
// left/right from that measurement — see computeStatsBarBounds.

/** Extra breathing room kept between the bar and whichever neighbor edge it's clearing. */
export const NEIGHBOR_GAP_PX = 16;

/** The original M11a hand-measured constants — kept ONLY as the fallback for when a measurement comes back degenerate (see computeStatsBarBounds' zero-width-host check). */
export const FALLBACK_LEFT_PX = 420;
export const FALLBACK_RIGHT_PX = 170;

/**
 * Raw geometry `reposition()` needs to derive left/right, reduced to plain
 * numbers (no DOMRect) so callers — tests especially — never have to
 * construct or stub a real DOMRect. All four are `getBoundingClientRect()`-
 * style viewport-relative px.
 */
export interface StatsBarMeasurement {
  /**
   * canvasHost's own left/right edges. `position: fixed`'s containing block
   * for this bar's outer row is canvasHost itself (its own `contain: layout`
   * — see main.ts's canvasHost comment), so left/right below are computed
   * relative to THIS, not the raw window — the bar keeps its clearance even
   * when the dev tuning panel narrows canvasHost well short of the window's
   * own width. (The brief's own "viewport width" phrasing assumes the two
   * coincide, true only when the panel isn't docked; using canvasHost's own
   * edge instead is strictly more correct and is exactly what the original
   * M11a layout bug — the panel silently stealing width — needed.)
   */
  hostLeft: number;
  hostRight: number;
  /**
   * The right edge of the rightmost left-stack widget actually present:
   * COACH's own right edge when the session has it on, else HUD's. Callers
   * don't need to decide which — a hidden (`display: none`) element's own
   * `getBoundingClientRect()` reads as the all-zero rect, so passing
   * `Math.max(hud.right, coach.right)` naturally resolves to whichever one
   * is actually visible (or HUD alone, when COACH doesn't even exist yet).
   */
  leftNeighborRight: number;
  /** The left edge of the SOUND/MENU button column (SOUND's own element — it's always visible once created, unlike MENU, which is hidden outside a live session). */
  rightNeighborLeft: number;
}

export type StatsBarMeasure = () => StatsBarMeasurement;

export interface StatsBarBounds {
  leftPx: number;
  rightPx: number;
  /** hostWidth − leftPx − rightPx (never negative) — the width the bar's centered content actually has to work with; feeds the scale-mph degradation in formatStatsLine. `Number.POSITIVE_INFINITY` in the fallback branch: a degradation decision is only as trustworthy as the measurement it's based on, and the fallback branch has none. */
  middleWidthPx: number;
}

/**
 * `left = (leftNeighborRight − hostLeft) + gap`; `right = (hostRight −
 * rightNeighborLeft) + gap` — both clamped at 0 so a not-yet-mounted
 * neighbor (measures as the zero rect) can't push the bar the wrong way.
 *
 * Falls back to the original M11a hand-measured constants whenever the HOST
 * itself measures with zero (or negative) width — the one signature that
 * can only mean "there's no real layout to read yet": jsdom has no layout
 * engine at all (every `getBoundingClientRect()` reads as the zero rect),
 * and a real, mounted canvasHost always has positive width from its very
 * first paint. leftNeighborRight/rightNeighborLeft being individually zero
 * (a neighbor not mounted yet) is a normal, valid measurement — the formula
 * above already degrades that gracefully to "nothing to clear on that
 * side" — so only the host's own rect decides whether to trust the
 * measurement at all.
 */
export function computeStatsBarBounds(m: StatsBarMeasurement): StatsBarBounds {
  const hostWidth = m.hostRight - m.hostLeft;
  if (hostWidth <= 0) {
    return { leftPx: FALLBACK_LEFT_PX, rightPx: FALLBACK_RIGHT_PX, middleWidthPx: Number.POSITIVE_INFINITY };
  }
  const leftPx = Math.max(0, m.leftNeighborRight - m.hostLeft) + NEIGHBOR_GAP_PX;
  const rightPx = Math.max(0, m.hostRight - m.rightNeighborLeft) + NEIGHBOR_GAP_PX;
  const middleWidthPx = Math.max(0, hostWidth - leftPx - rightPx);
  return { leftPx, rightPx, middleWidthPx };
}

// ---- Graceful degradation: drop scale-mph before the zone gets ellipsized -

/**
 * Simple monospace character-width estimate for this bar's 12px
 * 'SFMono-Regular'/Menlo/Consolas stack — a deliberately plain, rounded
 * figure (not a real canvas-measured advance width, and a little under this
 * stack's true ~7-7.2px/char at 12px): this only has to tell "comfortably
 * fits" from "definitely doesn't", erring toward keeping content rather than
 * dropping it prematurely, since the bar's own CSS `text-overflow:ellipsis`
 * remains the true safety net for whatever this estimate gets wrong.
 */
export const CHAR_WIDTH_PX = 6;

export function estimateTextWidthPx(text: string): number {
  return text.length * CHAR_WIDTH_PX;
}

function statsBarParts(state: StatsBarUpdate, includeScaleMph: boolean): string[] {
  const parts = [formatSpeed(state.speedMs)];
  if (includeScaleMph) parts.push(formatScaleMph(state.speedMs));
  parts.push(formatLaps(state.laps), formatCrashes(state.crashes));
  if (state.aiCrashes !== undefined) parts.push(formatAiCrashes(state.aiCrashes));
  parts.push(formatFps(state.fps), TICK_RATE_LABEL);
  return parts;
}

/**
 * The full line if it's estimated to fit `middleWidthPx`, else the same line
 * with the least-essential `≈nnn scale mph` segment dropped first — a
 * cleaner degradation than letting the bar's own ellipsis truncate an
 * arbitrary suffix mid-word once the zone gets tight (e.g. the dev tuning
 * panel docked on a narrow window). For this bar's default content (no AI
 * car, 1-2 digit values), the full line's estimated width comes out to
 * ~420px at the rate above — a zone narrower than that (before an
 * AI-CRASHES segment, if present, pushes the number higher still) drops
 * scale-mph. `middleWidthPx` of `Infinity` (computeStatsBarBounds' fallback
 * branch) always keeps the full line, since there's no real measurement to
 * doubt it with.
 */
export function formatStatsLine(state: StatsBarUpdate, middleWidthPx: number): string {
  const full = statsBarParts(state, true).join(' · ');
  if (estimateTextWidthPx(full) <= middleWidthPx) return full;
  return statsBarParts(state, false).join(' · ');
}

export interface StatsBar {
  update(state: StatsBarUpdate): void;
  /** Shown only while a session is actually live (countdown/racing) — same gating convention as the M10 on-screen MENU button. */
  setVisible(visible: boolean): void;
  /** Re-measures the real neighbor layout (via the `measure` callback passed to createStatsBar) and re-applies left/right. Called once automatically on construction ("on mount"); the caller (main.ts) is responsible for calling it again on window resize and after every session rebuild — COACH's own presence, and hence the left neighbor's width, varies by mode. */
  reposition(): void;
}

function ensureStyles(): void {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = `
    .m11-stats-bar-row {
      position: fixed;
      top: 12px;
      /* left/right are set inline by reposition() (below), never here — see
         computeStatsBarBounds' own docblock for the full derivation.
         reposition() always runs synchronously during createStatsBar's own
         construction, before this stylesheet could ever be observed without
         them set, so this rule intentionally carries no left/right of its
         own (and no stale hand-measured default to drift out of sync). */
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
 * docked tuning panel). `measure` supplies the raw neighbor geometry (see
 * StatsBarMeasurement) on demand — main.ts's own closure reads the live
 * HUD/COACH/SOUND-button element refs; tests stub it directly with plain
 * numbers, no real DOM measurement involved. Calls `reposition()` once
 * immediately (the "on mount" trigger); main.ts calls it again on window
 * resize and on every session rebuild (see `StatsBar.reposition`'s own
 * doc). Starts hidden; main.ts's frame loop toggles setVisible() and feeds
 * update() every frame while a session is live.
 */
export function createStatsBar(host: HTMLElement, measure: StatsBarMeasure): StatsBar {
  ensureStyles();

  const row = document.createElement('div');
  row.className = 'm11-stats-bar-row';
  host.appendChild(row);

  const el = document.createElement('div');
  el.className = 'm11-stats-bar';
  row.appendChild(el);

  // Cached from the last reposition() — update() runs every frame and must
  // NOT re-measure the DOM that often; only the three triggers named on
  // StatsBar.reposition's own doc actually change this.
  let middleWidthPx = Number.POSITIVE_INFINITY;

  function reposition(): void {
    const bounds = computeStatsBarBounds(measure());
    row.style.left = `${bounds.leftPx}px`;
    row.style.right = `${bounds.rightPx}px`;
    middleWidthPx = bounds.middleWidthPx;
  }

  function update(state: StatsBarUpdate): void {
    el.textContent = formatStatsLine(state, middleWidthPx);
  }

  function setVisible(visible: boolean): void {
    el.classList.toggle('m11-stats-bar--visible', visible);
  }

  reposition();

  return { update, setVisible, reposition };
}
