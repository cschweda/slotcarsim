// Dev-only live tuning panel: sliders bound directly to the mutable TUNING
// singleton (mutating it IS the mechanism — every sim step re-reads it fresh,
// per config/tuning.ts), a response-mode select, numeric readouts, and a
// small strip chart of recent v/throttle. Rendered only in dev or with
// `?tune`, so it never ships to a normal build's DOM. Deliberate visual
// polish is M8 — this is functional, not pretty.
import type { Tuning } from '../config/tuning';

export interface DebugPanelSample {
  v: number;
  throttle: number;
  /** M8: the auto quality ladder's rolling-window average frame time, ms. */
  frameMs?: number;
  /** M8: the auto quality ladder's current tier label (e.g. "high", "high-dpr1.5", "high-noshadow"). */
  qualityTier?: string;
}

export interface DebugPanel {
  sample(data: DebugPanelSample): void;
}

type NumericTuningKey =
  | 'supplyV'
  | 'controllerR'
  | 'accelPerVolt'
  | 'backEmfK'
  | 'brakeK'
  | 'rollingDrag'
  | 'keyboardRampRate'
  | 'gripSoft'
  | 'gripHard'
  | 'yawPerAccel'
  | 'scrubPerAccel';

interface SliderSpec {
  key: NumericTuningKey;
  min: number;
  max: number;
  step: number;
}

const SLIDERS: SliderSpec[] = [
  { key: 'supplyV', min: 10, max: 25, step: 0.1 },
  { key: 'controllerR', min: 20, max: 120, step: 1 },
  { key: 'accelPerVolt', min: 0.4, max: 2, step: 0.01 },
  { key: 'backEmfK', min: 2, max: 12, step: 0.1 },
  { key: 'brakeK', min: 2, max: 16, step: 0.1 },
  { key: 'rollingDrag', min: 0, max: 1, step: 0.01 },
  { key: 'keyboardRampRate', min: 1, max: 6, step: 0.1 },
  // M3 cornering/deslot constants (ranges per the M3 brief).
  { key: 'gripSoft', min: 4, max: 30, step: 0.5 },
  { key: 'gripHard', min: 6, max: 36, step: 0.5 },
  { key: 'yawPerAccel', min: 0, max: 0.2, step: 0.005 },
  { key: 'scrubPerAccel', min: 0, max: 2, step: 0.05 },
];

const RESPONSE_MODES = ['authentic', 'linear', 'stepped'] as const;

const CHART_WIDTH = 240;
const CHART_HEIGHT = 80;
const MAX_SAMPLES = CHART_WIDTH; // one column per sample, ~4s at ~60fps
const CHART_V_HEADROOM = 4; // m/s — fixed chart scale, comfortably above vmax

const STYLE_ID = 'm2-debug-panel-style';

function shouldRender(): boolean {
  const dev = Boolean(import.meta.env.DEV);
  const tuneParam = new URLSearchParams(window.location.search).has('tune');
  return dev || tuneParam;
}

function ensureStyles(): void {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = `
    .m2-debug {
      flex: 0 0 300px;
      max-height: 100vh;
      overflow-y: auto;
      box-sizing: border-box;
      background: rgba(10, 10, 12, 0.85);
      border-left: 1px solid rgba(255, 255, 255, 0.14);
      padding: 10px 12px 12px;
      font-family: 'SFMono-Regular', Menlo, Consolas, monospace;
      font-size: 11px;
      color: #e8e8e8;
    }
    .m2-debug--collapsed {
      display: none;
    }
    .m2-debug__header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      margin: 0 0 8px;
    }
    .m2-debug__header h2 {
      font-size: 11px;
      margin: 0;
      font-weight: 600;
      letter-spacing: 0.06em;
      text-transform: uppercase;
      color: #9fd3ff;
    }
    .m2-debug__close {
      flex-shrink: 0;
      width: 20px;
      height: 20px;
      padding: 0;
      line-height: 1;
      font-size: 12px;
      color: #e8e8e8;
      background: rgba(255, 255, 255, 0.08);
      border: 1px solid rgba(255, 255, 255, 0.25);
      border-radius: 4px;
      cursor: pointer;
    }
    .m2-debug-reopen {
      position: fixed;
      top: 60px;
      right: 12px;
      z-index: 110;
      display: none;
      font-family: 'SFMono-Regular', Menlo, Consolas, monospace;
      font-size: 12px;
      font-weight: 600;
      letter-spacing: 0.05em;
      color: #e8e8e8;
      background: rgba(10, 10, 12, 0.72);
      border: 1px solid rgba(255, 180, 84, 0.22);
      border-radius: 6px;
      padding: 6px 10px;
      cursor: pointer;
    }
    .m2-debug-reopen--visible {
      display: block;
    }
    .m2-debug__row {
      display: flex;
      justify-content: space-between;
      gap: 6px;
      margin: 6px 0 2px;
    }
    .m2-debug input[type='range'] {
      width: 100%;
      display: block;
    }
    .m2-debug select {
      width: 100%;
      margin-bottom: 6px;
      background: #1a1a1c;
      color: #e8e8e8;
      border: 1px solid rgba(255, 255, 255, 0.2);
    }
    .m2-debug__readout {
      margin-top: 8px;
      display: flex;
      justify-content: space-between;
      opacity: 0.85;
    }
    .m2-debug canvas {
      display: block;
      margin-top: 8px;
      background: rgba(0, 0, 0, 0.35);
      border-radius: 3px;
    }
  `;
  document.head.appendChild(style);
}

function formatNum(n: number): string {
  return n.toFixed(2);
}

const NOOP_PANEL: DebugPanel = { sample() {} };

/**
 * `flexRoot` is the app's horizontal flex row (main.ts's `#app`) — the panel
 * docks into it as a right-hand sibling COLUMN of the canvas host, never an
 * overlay on top of the 3D view (M9 follow-up). `canvasHost` is the flex
 * sibling the 3D view actually renders into: the small "TUNE" reopen tab
 * mounts there instead (rather than inside the collapsible column itself,
 * which disappears when collapsed) so it shares the canvas's own
 * position:fixed containing block/stacking context with the HUD and sound
 * toggle — "near but not colliding with the sound button," per the brief.
 */
export function createDebugPanel(flexRoot: HTMLElement, canvasHost: HTMLElement, tuning: Tuning): DebugPanel {
  if (!shouldRender()) {
    return NOOP_PANEL;
  }

  ensureStyles();

  const root = document.createElement('div');
  root.className = 'm2-debug';

  const header = document.createElement('div');
  header.className = 'm2-debug__header';
  const heading = document.createElement('h2');
  heading.textContent = 'Tuning';
  const closeButton = document.createElement('button');
  closeButton.type = 'button';
  closeButton.className = 'm2-debug__close';
  closeButton.textContent = '✕';
  closeButton.setAttribute('aria-label', 'Collapse tuning panel');
  header.append(heading, closeButton);
  root.appendChild(header);

  const modeRow = document.createElement('div');
  modeRow.className = 'm2-debug__row';
  const modeLabel = document.createElement('label');
  modeLabel.textContent = 'responseMode';
  modeLabel.htmlFor = 'm2-debug-responseMode';
  modeRow.appendChild(modeLabel);
  root.appendChild(modeRow);

  const modeSelect = document.createElement('select');
  modeSelect.id = 'm2-debug-responseMode';
  modeSelect.name = 'responseMode';
  for (const mode of RESPONSE_MODES) {
    const option = document.createElement('option');
    option.value = mode;
    option.textContent = mode;
    option.selected = tuning.responseMode === mode;
    modeSelect.appendChild(option);
  }
  modeSelect.addEventListener('change', () => {
    const value = modeSelect.value;
    if (value === 'authentic' || value === 'linear' || value === 'stepped') {
      tuning.responseMode = value;
    }
  });
  root.appendChild(modeSelect);

  for (const spec of SLIDERS) {
    const inputId = `m2-debug-${spec.key}`;

    const row = document.createElement('div');
    row.className = 'm2-debug__row';
    const nameLabel = document.createElement('label');
    nameLabel.textContent = spec.key;
    nameLabel.htmlFor = inputId;
    const valueSpan = document.createElement('span');
    valueSpan.textContent = formatNum(tuning[spec.key]);
    row.appendChild(nameLabel);
    row.appendChild(valueSpan);
    root.appendChild(row);

    const input = document.createElement('input');
    input.type = 'range';
    input.id = inputId;
    input.name = spec.key;
    input.min = String(spec.min);
    input.max = String(spec.max);
    input.step = String(spec.step);
    input.value = String(tuning[spec.key]);
    input.addEventListener('input', () => {
      const value = Number(input.value);
      tuning[spec.key] = value;
      valueSpan.textContent = formatNum(value);
    });
    root.appendChild(input);
  }

  const readout = document.createElement('div');
  readout.className = 'm2-debug__readout';
  const vReadout = document.createElement('span');
  const throttleReadout = document.createElement('span');
  readout.appendChild(vReadout);
  readout.appendChild(throttleReadout);
  root.appendChild(readout);

  // M8: auto quality ladder readout (rolling avg frame time + current tier).
  const qualityReadout = document.createElement('div');
  qualityReadout.className = 'm2-debug__readout';
  root.appendChild(qualityReadout);

  const canvas = document.createElement('canvas');
  canvas.width = CHART_WIDTH;
  canvas.height = CHART_HEIGHT;
  root.appendChild(canvas);
  const ctx = canvas.getContext('2d');

  flexRoot.appendChild(root);

  // Small standalone reopen tab — lives in canvasHost (not inside `root`,
  // which goes display:none while collapsed) so there's always something to
  // click. Positioned just below the sound toggle button rather than beside
  // it, so it never collides regardless of the button's ON/OFF label width.
  const reopenTab = document.createElement('button');
  reopenTab.type = 'button';
  reopenTab.className = 'm2-debug-reopen';
  reopenTab.textContent = 'TUNE';
  reopenTab.setAttribute('aria-label', 'Open tuning panel');
  canvasHost.appendChild(reopenTab);

  // Collapsing hides the column entirely (a `display:none` flex sibling
  // frees its space, so canvasHost's ResizeObserver — see render/scene.ts —
  // picks up the resulting box-size change and re-fits the renderer
  // automatically; no explicit resize call needed here). State is plain
  // in-memory, intentionally not persisted across reloads.
  function setCollapsed(collapsed: boolean): void {
    root.classList.toggle('m2-debug--collapsed', collapsed);
    reopenTab.classList.toggle('m2-debug-reopen--visible', collapsed);
  }
  closeButton.addEventListener('click', () => setCollapsed(true));
  reopenTab.addEventListener('click', () => setCollapsed(false));

  const samples: DebugPanelSample[] = [];

  function draw(): void {
    if (!ctx) return;
    ctx.clearRect(0, 0, CHART_WIDTH, CHART_HEIGHT);
    if (samples.length < 2) return;

    // Throttle: filled area, 0..1 maps to the full chart height.
    ctx.beginPath();
    ctx.moveTo(0, CHART_HEIGHT);
    samples.forEach((sample, i) => {
      ctx.lineTo(i, CHART_HEIGHT - sample.throttle * CHART_HEIGHT);
    });
    ctx.lineTo(samples.length - 1, CHART_HEIGHT);
    ctx.closePath();
    ctx.fillStyle = 'rgba(94, 224, 107, 0.35)';
    ctx.fill();

    // v: line, against a fixed headroom scale (not autoscaled).
    ctx.beginPath();
    samples.forEach((sample, i) => {
      const y = CHART_HEIGHT - Math.min(1, sample.v / CHART_V_HEADROOM) * CHART_HEIGHT;
      if (i === 0) {
        ctx.moveTo(i, y);
      } else {
        ctx.lineTo(i, y);
      }
    });
    ctx.strokeStyle = '#9fd3ff';
    ctx.lineWidth = 1.5;
    ctx.stroke();
  }

  function sample(data: DebugPanelSample): void {
    samples.push(data);
    if (samples.length > MAX_SAMPLES) {
      samples.shift();
    }
    vReadout.textContent = `v=${data.v.toFixed(2)} m/s`;
    throttleReadout.textContent = `throttle=${data.throttle.toFixed(2)}`;
    if (data.frameMs !== undefined || data.qualityTier !== undefined) {
      qualityReadout.textContent =
        `${data.frameMs !== undefined ? `frame=${data.frameMs.toFixed(1)}ms` : ''}` +
        `${data.qualityTier !== undefined ? ` · tier=${data.qualityTier}` : ''}`;
    }
    draw();
  }

  return { sample };
}
