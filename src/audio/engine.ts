// The single shared AudioContext + master bus. Owns the whole autoplay-policy
// lifecycle: a fresh AudioContext is constructed suspended (the browser's own
// default — nothing here forces that), and stays suspended until
// `ensureRunning()` is called from inside a REAL user-gesture handler's call
// stack (main.ts's start gate: a click or keydown — never a gamepad button
// press, which Chrome does not treat as user activation). After that first
// unlock, a statechange watchdog and a visibilitychange listener keep the
// context from getting stuck suspended/interrupted (tab hide, OS audio
// interruption) without ever resuming before that first real gesture.
export interface AudioEngine {
  ctx: AudioContext;
  /** Master gain (MASTER_GAIN unmuted / 0 muted) feeding the compressor -> destination. Exposed directly so main.ts's M-key mute can drive it — no separate mute() method (YAGNI: one AudioParam, one caller). */
  master: GainNode;
  /** Marks the engine unlocked and resumes the context. Call ONLY from inside a user-gesture handler (the start gate's click/keydown) — never from a gamepad callback. */
  ensureRunning(): void;
  /** Suspends the context (used internally on tab-hide; exposed for completeness/tests). */
  suspend(): void;
  /** Resumes the context if it's allowed to run (used internally by the watchdog/visibility handlers; exposed for completeness/tests). */
  resume(): void;
  /** Tears down listeners and closes the context. */
  dispose(): void;
}

/** Unmuted master gain — also the M-key mute toggle's "on" target in main.ts. */
export const MASTER_GAIN = 0.7;

export function createAudioEngine(): AudioEngine {
  const ctx = new AudioContext();

  const master = ctx.createGain();
  master.gain.value = MASTER_GAIN;

  const compressor = ctx.createDynamicsCompressor(); // defaults are fine (brief)
  master.connect(compressor);
  compressor.connect(ctx.destination);

  // Flips true the instant the player's first real gesture fires (see
  // ensureRunning). Gates the watchdog/visibility resume paths so nothing
  // ever tries to resume a context the player hasn't unlocked yet.
  let unlocked = false;

  function resume(): void {
    if (ctx.state === 'suspended' || ctx.state === 'interrupted') {
      void ctx.resume();
    }
  }

  function suspend(): void {
    if (ctx.state === 'running') {
      void ctx.suspend();
    }
  }

  function ensureRunning(): void {
    unlocked = true;
    resume();
  }

  // Safari/iOS can flip a running context to 'interrupted' (phone call, Siri,
  // silent-switch edge cases) without a visibilitychange firing at all; some
  // Chrome power states can drop a context back to 'suspended' unprompted.
  // Recover automatically whenever the page is visible and already unlocked.
  function handleStateChange(): void {
    if (!unlocked) return;
    if (document.visibilityState !== 'visible') return;
    resume();
  }
  ctx.addEventListener('statechange', handleStateChange);

  function handleVisibilityChange(): void {
    if (document.visibilityState === 'hidden') {
      suspend();
    } else if (unlocked) {
      resume();
    }
  }
  document.addEventListener('visibilitychange', handleVisibilityChange);

  function dispose(): void {
    document.removeEventListener('visibilitychange', handleVisibilityChange);
    ctx.removeEventListener('statechange', handleStateChange);
    master.disconnect();
    compressor.disconnect();
    void ctx.close();
  }

  return { ctx, master, ensureRunning, suspend, resume, dispose };
}
