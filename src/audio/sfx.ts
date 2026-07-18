// One-shot sound effects: deslot clatter, lap beep, countdown beeps. Unlike
// motorVoice.ts's persistent per-car graphs, every call here builds a fresh,
// short-lived node graph — that's the CORRECT pattern for one-shots (the
// brief's "never create nodes per frame" rule is about the continuously
//-driven motor voices, not these rare, discrete, self-releasing bursts).
// Frequency/gain envelopes are scheduled ONCE per call via the AudioParam
// automation API (setValueAtTime/exponentialRampToValueAtTime) — this is the
// idiomatic way to shape a one-shot in WebAudio, not the imperative
// per-frame `.value =` writes the persistent voices must avoid.
import type { AudioEngine } from './engine';
import { clamp } from '../sim/math';

export interface Sfx {
  /** Deslot clatter: shaped noise burst + descending plastic clicks, panned toward the car. */
  deslotClatter(pan: number): void;
  /** Short quiet blip on a player lap. */
  lapBeep(): void;
  /** Race-start countdown tone; `final` is the "go" tone (M7 wires this in). */
  countdownBeep(final: boolean): void;
  /** No persistent nodes to release — every sound above already self-disposes on 'ended'. Kept for interface symmetry with engine/motorVoice. */
  dispose(): void;
}

const CLATTER_DURATION = 0.35;
const CLATTER_SWEEP_START_HZ = 1800;
const CLATTER_SWEEP_END_HZ = 500;
const CLATTER_Q = 1.2;
const CLATTER_PEAK_GAIN = 0.9;

const CLICK_FREQS_HZ = [900, 700, 550, 420];
const CLICK_SPACING_SEC = 0.06;
const CLICK_DURATION_SEC = 0.02;
const CLICK_PEAK_GAIN = 0.3;

const LAP_BEEP_FREQ_HZ = 1250;
const LAP_BEEP_DURATION_SEC = 0.06;
const LAP_BEEP_GAIN = 0.25;

const COUNTDOWN_FREQ_HZ = 880;
const COUNTDOWN_DURATION_SEC = 0.2;
const COUNTDOWN_FINAL_FREQ_HZ = 1320;
const COUNTDOWN_FINAL_DURATION_SEC = 0.4;
const COUNTDOWN_GAIN = 0.3;

/** Exponential ramps can't target exactly 0 — this floor reads as silence but keeps the ramp well-defined. */
const SILENT_FLOOR = 0.0001;
/** Extra time after an envelope's nominal end before stop() — comfortably past the point the ramp is inaudible. */
const STOP_MARGIN_SEC = 0.02;

/** Schedules an instant attack + exponential decay to (effectively) silence, starting at `when` and lasting `duration` seconds. */
function scheduleDecay(gain: AudioParam, when: number, duration: number, peak: number): void {
  gain.setValueAtTime(peak, when);
  gain.exponentialRampToValueAtTime(SILENT_FLOOR, when + duration);
}

/** A short noise buffer for one deslotClatter call — regenerated per call (rare, discrete event; no benefit to sharing/caching a 0.4s buffer the way motorVoice.ts's continuous 2s hiss loop does). */
function makeBurstNoiseBuffer(ctx: BaseAudioContext, seconds: number): AudioBuffer {
  const buffer = ctx.createBuffer(1, Math.round(ctx.sampleRate * seconds), ctx.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < data.length; i++) {
    data[i] = Math.random() * 2 - 1;
  }
  return buffer;
}

export function createSfx(engine: AudioEngine): Sfx {
  const { ctx } = engine;

  function deslotClatter(pan: number): void {
    const t0 = ctx.currentTime;

    const panner = ctx.createStereoPanner();
    panner.pan.value = clamp(pan, -1, 1);
    panner.connect(engine.master);

    // Shaped noise burst: bandpass sweeping down from ~1.8kHz to ~500Hz.
    const noise = ctx.createBufferSource();
    noise.buffer = makeBurstNoiseBuffer(ctx, CLATTER_DURATION + STOP_MARGIN_SEC);
    const noiseFilter = ctx.createBiquadFilter();
    noiseFilter.type = 'bandpass';
    noiseFilter.Q.value = CLATTER_Q;
    noiseFilter.frequency.setValueAtTime(CLATTER_SWEEP_START_HZ, t0);
    noiseFilter.frequency.exponentialRampToValueAtTime(CLATTER_SWEEP_END_HZ, t0 + CLATTER_DURATION);
    const noiseGain = ctx.createGain();
    scheduleDecay(noiseGain.gain, t0, CLATTER_DURATION, CLATTER_PEAK_GAIN);
    noise.connect(noiseFilter);
    noiseFilter.connect(noiseGain);
    noiseGain.connect(panner);
    noise.start(t0);
    noise.stop(t0 + CLATTER_DURATION + STOP_MARGIN_SEC);
    // The noise burst outlives every click below, so its 'ended' is the right
    // moment to tear down the whole call's graph, including the shared panner.
    noise.addEventListener(
      'ended',
      () => {
        noise.disconnect();
        noiseFilter.disconnect();
        noiseGain.disconnect();
        panner.disconnect();
      },
      { once: true },
    );

    // 3-4 descending square-wave clicks — plastic clacks as the car tumbles.
    for (let i = 0; i < CLICK_FREQS_HZ.length; i++) {
      const freq = CLICK_FREQS_HZ[i]!;
      const clickAt = t0 + i * CLICK_SPACING_SEC;
      const osc = ctx.createOscillator();
      osc.type = 'square';
      osc.frequency.value = freq;
      const clickGain = ctx.createGain();
      scheduleDecay(clickGain.gain, clickAt, CLICK_DURATION_SEC, CLICK_PEAK_GAIN);
      osc.connect(clickGain);
      clickGain.connect(panner);
      osc.start(clickAt);
      osc.stop(clickAt + CLICK_DURATION_SEC + STOP_MARGIN_SEC);
      osc.addEventListener(
        'ended',
        () => {
          osc.disconnect();
          clickGain.disconnect();
        },
        { once: true },
      );
    }
  }

  function lapBeep(): void {
    const t0 = ctx.currentTime;
    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.value = LAP_BEEP_FREQ_HZ;
    const gain = ctx.createGain();
    scheduleDecay(gain.gain, t0, LAP_BEEP_DURATION_SEC, LAP_BEEP_GAIN);
    osc.connect(gain);
    gain.connect(engine.master);
    osc.start(t0);
    osc.stop(t0 + LAP_BEEP_DURATION_SEC + STOP_MARGIN_SEC);
    osc.addEventListener(
      'ended',
      () => {
        osc.disconnect();
        gain.disconnect();
      },
      { once: true },
    );
  }

  function countdownBeep(final: boolean): void {
    const t0 = ctx.currentTime;
    const freq = final ? COUNTDOWN_FINAL_FREQ_HZ : COUNTDOWN_FREQ_HZ;
    const duration = final ? COUNTDOWN_FINAL_DURATION_SEC : COUNTDOWN_DURATION_SEC;
    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.value = freq;
    const gain = ctx.createGain();
    scheduleDecay(gain.gain, t0, duration, COUNTDOWN_GAIN);
    osc.connect(gain);
    gain.connect(engine.master);
    osc.start(t0);
    osc.stop(t0 + duration + STOP_MARGIN_SEC);
    osc.addEventListener(
      'ended',
      () => {
        osc.disconnect();
        gain.disconnect();
      },
      { once: true },
    );
  }

  function dispose(): void {
    // No persistent nodes here to release — see the Sfx.dispose doc comment.
  }

  return { deslotClatter, lapBeep, countdownBeep, dispose };
}
