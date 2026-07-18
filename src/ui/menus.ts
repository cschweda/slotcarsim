// Minimal full-screen start gate — the ONE user-gesture surface that unlocks
// WebAudio. A gamepad button press is not user activation in Chrome, so this
// is deliberately a real click/keydown handler, and `onStart()` (which calls
// into engine.ensureRunning() -> ctx.resume()) runs synchronously INSIDE that
// handler's own call stack, not after a microtask/rAF hop. M7 expands this
// file into real menus (track/car select, race countdown); for M6 it is only
// the click-or-key-to-start gate.
const STYLE_ID = 'm6-gate-style';

function ensureStyles(): void {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = `
    .m6-gate {
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
      cursor: pointer;
      user-select: none;
    }
    .m6-gate__title {
      font-size: 28px;
      letter-spacing: 0.08em;
      font-weight: 600;
      color: #9fd3ff;
    }
    .m6-gate__line {
      font-size: 15px;
      opacity: 0.92;
    }
    .m6-gate__hint {
      font-size: 12px;
      opacity: 0.55;
    }
  `;
  document.head.appendChild(style);
}

/**
 * Mounts the start gate into `container` and calls `onStart()` exactly once,
 * synchronously inside the click/keydown handler that dismisses it. Consumes
 * that event (`stopImmediatePropagation` + `preventDefault`) so the very
 * keystroke that starts the game — which could be any key, including ones a
 * caller binds to something else (e.g. main.ts's 'M' mute) — is never also
 * interpreted as that other action.
 */
export function createStartGate(container: HTMLElement, onStart: () => void): void {
  ensureStyles();

  const root = document.createElement('div');
  root.className = 'm6-gate';

  const title = document.createElement('div');
  title.className = 'm6-gate__title';
  title.textContent = 'AFX SLOT CAR SIMULATOR';

  const line = document.createElement('div');
  line.className = 'm6-gate__line';
  line.textContent = 'Click or press any key to start';

  const hint = document.createElement('div');
  hint.className = 'm6-gate__hint';
  hint.textContent = 'Gamepad trigger = throttle · Space = throttle (keyboard)';

  root.appendChild(title);
  root.appendChild(line);
  root.appendChild(hint);
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
  // keydown on document (not just the overlay) so "press any key" works
  // regardless of what currently has focus; the overlay's own click handler
  // above covers pointer input.
  document.addEventListener('keydown', handleStart);
}
