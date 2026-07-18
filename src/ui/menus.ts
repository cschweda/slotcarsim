// The game's menus, vintage-simple to match the HUD: the WebAudio unlock gate
// (createStartGate), the race-setup menu (mode / difficulty / track / lane /
// car), and the results screen. Setup and results are keyboard-navigable
// (arrows + Enter) AND clickable, and are marked up as ARIA dialogs
// (role=dialog, aria-modal, aria-label). M7 owns all of this; main.ts wires
// the chosen RaceConfig into the sim/race and shows results when a race ends.
import type { CarStyleId } from '../render/carMesh';
import type { RaceConfig, RaceMode, RaceResults, TrackId } from '../game/race';

const STYLE_ID = 'm6-gate-style';

function ensureStyles(): void {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = `
    .m6-gate, .m7-menu {
      position: fixed;
      inset: 0;
      z-index: 100;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      gap: 14px;
      background: rgba(6, 6, 8, 0.94);
      color: #e8e8e8;
      font-family: 'SFMono-Regular', Menlo, Consolas, monospace;
      text-align: center;
      user-select: none;
    }
    .m6-gate { cursor: pointer; }
    .m7-menu:focus { outline: none; }
    .m6-gate__title, .m7-menu__title {
      font-size: 28px;
      letter-spacing: 0.08em;
      font-weight: 600;
      color: #9fd3ff;
      margin-bottom: 6px;
    }
    .m6-gate__line { font-size: 15px; opacity: 0.92; }
    .m6-gate__hint, .m7-menu__hint { font-size: 12px; opacity: 0.55; margin-top: 8px; }
    .m7-menu__panel {
      display: flex;
      flex-direction: column;
      gap: 4px;
      min-width: 340px;
      background: rgba(12, 12, 16, 0.72);
      border: 1px solid rgba(255, 255, 255, 0.14);
      border-radius: 8px;
      padding: 14px 18px;
    }
    .m7-row {
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 20px;
      padding: 7px 12px;
      border-radius: 5px;
      font-size: 15px;
      cursor: pointer;
      border: 1px solid transparent;
    }
    .m7-row--selected {
      background: rgba(159, 211, 255, 0.14);
      border-color: rgba(159, 211, 255, 0.5);
    }
    .m7-row__label { opacity: 0.8; }
    .m7-row__value { color: #9fd3ff; font-weight: 600; min-width: 130px; text-align: right; }
    .m7-row--action {
      justify-content: center;
      margin-top: 8px;
      color: #5ee06b;
      font-weight: 600;
      letter-spacing: 0.05em;
    }
    .m7-row--action.m7-row--selected { background: rgba(94, 224, 107, 0.16); border-color: rgba(94, 224, 107, 0.55); }
    .m7-banner { font-size: 24px; font-weight: 600; letter-spacing: 0.06em; }
    .m7-banner--win { color: #5ee06b; }
    .m7-banner--lose { color: #ff8a80; }
    .m7-results__stat { font-size: 15px; opacity: 0.9; }
  `;
  document.head.appendChild(style);
}

/**
 * Mounts the start gate into `container` and calls `onStart()` exactly once,
 * synchronously inside the click/keydown handler that dismisses it — the one
 * valid place to unlock WebAudio (ctx.resume()). Consumes that event so the
 * key that starts the game isn't also read as a gameplay key.
 */
export function createStartGate(container: HTMLElement, onStart: () => void): void {
  ensureStyles();

  const root = document.createElement('div');
  root.className = 'm6-gate';
  root.setAttribute('role', 'dialog');
  root.setAttribute('aria-modal', 'true');
  root.setAttribute('aria-label', 'AFX Slot Car Simulator — press any key to start');

  const title = document.createElement('div');
  title.className = 'm6-gate__title';
  title.textContent = 'AFX SLOT CAR SIMULATOR';

  const line = document.createElement('div');
  line.className = 'm6-gate__line';
  line.textContent = 'Click or press any key to start';

  const hint = document.createElement('div');
  hint.className = 'm6-gate__hint';
  hint.textContent = 'Gamepad trigger = throttle · Space = throttle (keyboard)';

  root.append(title, line, hint);
  container.appendChild(root);

  let dismissed = false;
  function handleStart(event: Event): void {
    if (dismissed) return;
    dismissed = true;
    event.preventDefault();
    event.stopImmediatePropagation();
    root.removeEventListener('click', handleStart);
    document.removeEventListener('keydown', handleStart);
    onStart(); // synchronous, still inside this real click/keydown handler's call stack
    root.remove();
  }

  root.addEventListener('click', handleStart);
  document.addEventListener('keydown', handleStart);
}

// ---- Option tables -------------------------------------------------------

const MODES: Array<{ value: RaceMode; label: string }> = [
  { value: 'race', label: 'Race vs AI' },
  { value: 'timetrial', label: 'Time Trial' },
];
const DIFFICULTIES: Array<{ value: number; label: string }> = [
  { value: 0.35, label: 'Easy' },
  { value: 0.65, label: 'Medium' },
  { value: 0.9, label: 'Hard' },
];
const TRACKS_OPT: Array<{ value: TrackId; label: string }> = [
  { value: 'oval', label: 'Classic Oval' },
  { value: 'figure8', label: 'Figure Eight' },
];
const CARS: Array<{ value: CarStyleId; label: string }> = [
  { value: 'p917', label: '917 Orange' },
  { value: 'f512', label: '512 Red' },
];
const LANE_LABELS: Record<TrackId, [string, string]> = {
  oval: ['Inner', 'Outer'],
  figure8: ['Lane 1', 'Lane 2'],
};

interface OptionRow {
  type: 'option';
  label: string;
  valueLabel: string;
  cycle(dir: 1 | -1): void;
}
interface ActionRow {
  type: 'action';
  label: string;
  activate(): void;
}
type Row = OptionRow | ActionRow;

export interface MenuSystem {
  /** Show the race-setup menu; onStart fires with the chosen config on "Start Race". */
  openSetup(onStart: (config: RaceConfig) => void): void;
  /** Show the results screen after a race. */
  openResults(results: RaceResults, handlers: ResultHandlers): void;
}

export interface ResultHandlers {
  onRestart(): void;
  onMenu(): void;
}

export function createMenuSystem(container: HTMLElement): MenuSystem {
  ensureStyles();

  // Persisted selections so re-opening the menu keeps the player's last picks.
  let modeIdx = 0;
  let diffIdx = 1;
  let trackIdx = 0;
  let laneIdx = 0;
  let carIdx = 0;

  let root: HTMLElement | null = null;
  let keyHandler: ((e: KeyboardEvent) => void) | null = null;

  function teardown(): void {
    if (keyHandler) document.removeEventListener('keydown', keyHandler, true);
    keyHandler = null;
    root?.remove();
    root = null;
  }

  function currentConfig(onStartCar: CarStyleId): RaceConfig {
    return {
      mode: MODES[modeIdx]!.value,
      lapsToWin: 5,
      playerLane: laneIdx === 0 ? 0 : 1,
      aiDifficulty: DIFFICULTIES[diffIdx]!.value,
      trackId: TRACKS_OPT[trackIdx]!.value,
      playerCar: onStartCar,
    };
  }

  function openSetup(onStart: (config: RaceConfig) => void): void {
    teardown();
    const panel = mountPanel('Race setup');
    const title = document.createElement('div');
    title.className = 'm7-menu__title';
    title.textContent = 'RACE SETUP';
    panel.appendChild(title);

    const list = document.createElement('div');
    list.className = 'm7-menu__panel';
    list.setAttribute('role', 'listbox');
    list.setAttribute('aria-label', 'Race setup options');
    panel.appendChild(list);

    const hint = document.createElement('div');
    hint.className = 'm7-menu__hint';
    hint.textContent = '↑↓ choose · ←→ change · Enter start';
    panel.appendChild(hint);

    let selected = 0;

    const buildRows = (): Row[] => {
      const trackId = TRACKS_OPT[trackIdx]!.value;
      const rows: Row[] = [
        {
          type: 'option',
          label: 'Mode',
          valueLabel: MODES[modeIdx]!.label,
          cycle: (d) => {
            modeIdx = wrap(modeIdx + d, MODES.length);
          },
        },
      ];
      if (MODES[modeIdx]!.value === 'race') {
        rows.push({
          type: 'option',
          label: 'Difficulty',
          valueLabel: DIFFICULTIES[diffIdx]!.label,
          cycle: (d) => {
            diffIdx = wrap(diffIdx + d, DIFFICULTIES.length);
          },
        });
      }
      rows.push(
        {
          type: 'option',
          label: 'Track',
          valueLabel: TRACKS_OPT[trackIdx]!.label,
          cycle: (d) => {
            trackIdx = wrap(trackIdx + d, TRACKS_OPT.length);
          },
        },
        {
          type: 'option',
          label: 'Lane',
          valueLabel: LANE_LABELS[trackId][laneIdx === 0 ? 0 : 1],
          cycle: (d) => {
            laneIdx = wrap(laneIdx + d, 2);
          },
        },
        {
          type: 'option',
          label: 'Your Car',
          valueLabel: CARS[carIdx]!.label,
          cycle: (d) => {
            carIdx = wrap(carIdx + d, CARS.length);
          },
        },
        {
          type: 'action',
          label: MODES[modeIdx]!.value === 'race' ? 'START RACE' : 'START TIME TRIAL',
          activate: () => {
            teardown();
            onStart(currentConfig(CARS[carIdx]!.value));
          },
        },
      );
      return rows;
    };

    function render(): void {
      const rows = buildRows();
      if (selected >= rows.length) selected = rows.length - 1;
      list.replaceChildren();
      rows.forEach((row, i) => {
        const el = document.createElement('div');
        const rowId = `m7-setup-row-${i}`;
        el.id = rowId;
        el.className = `m7-row m7-row--${row.type}${i === selected ? ' m7-row--selected' : ''}`;
        el.setAttribute('role', 'option');
        el.setAttribute('aria-selected', i === selected ? 'true' : 'false');
        if (row.type === 'option') {
          const label = document.createElement('span');
          label.className = 'm7-row__label';
          label.textContent = row.label;
          const value = document.createElement('span');
          value.className = 'm7-row__value';
          value.textContent = `‹ ${row.valueLabel} ›`;
          el.append(label, value);
          el.addEventListener('click', () => {
            selected = i;
            row.cycle(1);
            render();
          });
        } else {
          el.textContent = row.label;
          el.addEventListener('click', () => {
            selected = i;
            row.activate();
          });
        }
        list.appendChild(el);
        if (i === selected) list.setAttribute('aria-activedescendant', rowId);
      });
    }

    keyHandler = (e: KeyboardEvent): void => {
      const rows = buildRows();
      const row = rows[selected];
      let handled = true;
      if (e.key === 'ArrowDown') selected = wrap(selected + 1, rows.length);
      else if (e.key === 'ArrowUp') selected = wrap(selected - 1, rows.length);
      else if (e.key === 'ArrowRight' && row?.type === 'option') row.cycle(1);
      else if (e.key === 'ArrowLeft' && row?.type === 'option') row.cycle(-1);
      else if (e.key === 'Enter' || e.key === ' ') {
        if (row?.type === 'action') return void row.activate();
        if (row?.type === 'option') row.cycle(1);
      } else if (e.key === 'Tab') {
        // Trap focus: this dialog (aria-modal) is the only focusable element
        // on the page while it's open, so Tab must not hand focus off to
        // browser chrome or reset it to the document.
        root!.focus();
      } else handled = false;
      if (handled) {
        e.preventDefault();
        e.stopPropagation();
        render();
      }
    };
    document.addEventListener('keydown', keyHandler, true);
    render();
    root!.focus();
  }

  function openResults(results: RaceResults, handlers: ResultHandlers): void {
    teardown();
    const panel = mountPanel('Race results');

    // openResults is only ever reached via a 'finished' race phase, which
    // (per game/race.ts) only a real race (not time trial, which has no win
    // condition) can produce — so this is always a win/lose result.
    const playerWon = results.winnerCarIndex === 0;
    const banner = document.createElement('div');
    banner.className = `m7-banner ${playerWon ? 'm7-banner--win' : 'm7-banner--lose'}`;
    banner.textContent = playerWon ? 'YOU WIN' : 'AI WINS';
    panel.appendChild(banner);

    const stats = document.createElement('div');
    stats.className = 'm7-menu__panel';
    for (const entry of results.order) {
      const line = document.createElement('div');
      line.className = 'm7-results__stat';
      const who = entry.isPlayer ? 'You' : 'AI';
      line.textContent = `${who}: ${entry.laps} lap${entry.laps === 1 ? '' : 's'}`;
      stats.appendChild(line);
    }
    const best = document.createElement('div');
    best.className = 'm7-results__stat';
    best.textContent = `Best lap: ${results.playerBestLapSec === null ? '—' : `${results.playerBestLapSec.toFixed(3)} s`}`;
    stats.appendChild(best);
    panel.appendChild(stats);

    const buttons = document.createElement('div');
    buttons.className = 'm7-menu__panel';
    buttons.setAttribute('role', 'listbox');
    buttons.setAttribute('aria-label', 'Race results actions');
    const actions: ActionRow[] = [
      { type: 'action', label: 'RESTART', activate: () => (teardown(), handlers.onRestart()) },
      { type: 'action', label: 'MENU', activate: () => (teardown(), handlers.onMenu()) },
    ];
    let selected = 0;

    function render(): void {
      buttons.replaceChildren();
      actions.forEach((a, i) => {
        const el = document.createElement('div');
        const rowId = `m7-results-row-${i}`;
        el.id = rowId;
        el.className = `m7-row m7-row--action${i === selected ? ' m7-row--selected' : ''}`;
        el.setAttribute('role', 'option');
        el.setAttribute('aria-selected', i === selected ? 'true' : 'false');
        el.textContent = a.label;
        el.addEventListener('click', () => {
          selected = i;
          a.activate();
        });
        buttons.appendChild(el);
        if (i === selected) buttons.setAttribute('aria-activedescendant', rowId);
      });
    }
    panel.appendChild(buttons);

    const hint = document.createElement('div');
    hint.className = 'm7-menu__hint';
    hint.textContent = '↑↓ choose · Enter select';
    panel.appendChild(hint);

    keyHandler = (e: KeyboardEvent): void => {
      let handled = true;
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') selected = wrap(selected + 1, actions.length);
      else if (e.key === 'Enter' || e.key === ' ') return void actions[selected]!.activate();
      else if (e.key === 'Tab') {
        // Trap focus: this dialog (aria-modal) is the only focusable element
        // on the page while it's open.
        root!.focus();
      } else handled = false;
      if (handled) {
        e.preventDefault();
        e.stopPropagation();
        render();
      }
    };
    document.addEventListener('keydown', keyHandler, true);
    render();
    root!.focus();
  }

  /** Build the dialog root with ARIA and return the flex column to fill. */
  function mountPanel(ariaLabel: string): HTMLElement {
    root = document.createElement('div');
    root.className = 'm7-menu';
    root.tabIndex = -1;
    root.setAttribute('role', 'dialog');
    root.setAttribute('aria-modal', 'true');
    root.setAttribute('aria-label', ariaLabel);
    container.appendChild(root);
    return root;
  }

  return { openSetup, openResults };
}

function wrap(i: number, n: number): number {
  return ((i % n) + n) % n;
}
