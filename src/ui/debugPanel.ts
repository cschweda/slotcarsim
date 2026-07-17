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
  | 'keyboardRampRate';

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
      position: fixed;
      top: 12px;
      right: 12px;
      z-index: 10;
      width: 260px;
      background: rgba(10, 10, 12, 0.85);
      border: 1px solid rgba(255, 255, 255, 0.14);
      border-radius: 6px;
      padding: 10px 12px 12px;
      font-family: 'SFMono-Regular', Menlo, Consolas, monospace;
      font-size: 11px;
      color: #e8e8e8;
    }
    .m2-debug h2 {
      font-size: 11px;
      margin: 0 0 8px;
      font-weight: 600;
      letter-spacing: 0.06em;
      text-transform: uppercase;
      color: #9fd3ff;
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

export function createDebugPanel(tuning: Tuning): DebugPanel {
  if (!shouldRender()) {
    return NOOP_PANEL;
  }

  ensureStyles();

  const root = document.createElement('div');
  root.className = 'm2-debug';

  const heading = document.createElement('h2');
  heading.textContent = 'Tuning';
  root.appendChild(heading);

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

  const canvas = document.createElement('canvas');
  canvas.width = CHART_WIDTH;
  canvas.height = CHART_HEIGHT;
  root.appendChild(canvas);
  const ctx = canvas.getContext('2d');

  document.body.appendChild(root);

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
    draw();
  }

  return { sample };
}
