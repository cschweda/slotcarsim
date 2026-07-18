// One persistent per-car WebAudio graph: a pancake-motor voice whose pitch
// tracks speed, with commutator buzz and brush hiss riding along, panned by
// table position. Built ONCE per car (main.ts creates one per car when the
// start gate unlocks audio) and driven every render frame via `update()`,
// which only ever moves existing AudioParams with `setTargetAtTime` — never
// creates/destroys nodes and never assigns `.value` directly at audio rate
// (both would either leak nodes every frame or produce zipper noise).
import type { AudioEngine } from './engine';
import { motorF0, motorGains, panForX } from './mapping';

export interface MotorVoiceUpdate {
  /** Car speed, m/s. */
  v: number;
  /** Trigger position, 0..1 (constant-controlled cars pass v/vmax — see main.ts). */
  throttle: number;
  /** Car's current world x position, sim coords. */
  x: number;
  vmax: number;
  tableHalfWidth: number;
  centerX: number;
}

export interface MotorVoiceOptions {
  /** Fixed per-voice pitch detune, in cents, applied at construction (never touched again). Player 0; pace/AI ≈ +26 (~+1.5%) — see main.ts. */
  detuneCents: number;
}

export interface MotorVoice {
  update(input: MotorVoiceUpdate): void;
  dispose(): void;
}

/** setTargetAtTime time constant for every per-frame param glide (brief: τ≈0.03s — fast enough to track speed changes, slow enough to never zipper). */
const TAU = 0.03;

const BUZZ_HARMONIC = 3;
const HISS_HARMONIC = 6;
const BUZZ_Q = 2;
const HISS_Q = 0.8;
const NOISE_BUFFER_SECONDS = 2;

// One shared 2s white-noise buffer per AudioContext: every voice's hiss
// branch reads the same sample data through its OWN AudioBufferSourceNode
// (a source node is per-voice and one-shot-startable; the underlying sample
// DATA has no reason to be regenerated per car). Math.random is fine here —
// this is audio/, not sim/ — but the buffer is still built exactly once per
// context, never per frame, per the brief. WeakMap keyed by ctx so nothing
// here outlives the context it was generated for.
const noiseBuffers = new WeakMap<BaseAudioContext, AudioBuffer>();

function getNoiseBuffer(ctx: BaseAudioContext): AudioBuffer {
  const cached = noiseBuffers.get(ctx);
  if (cached) return cached;

  const buffer = ctx.createBuffer(1, Math.round(ctx.sampleRate * NOISE_BUFFER_SECONDS), ctx.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < data.length; i++) {
    data[i] = Math.random() * 2 - 1;
  }
  noiseBuffers.set(ctx, buffer);
  return buffer;
}

export function createMotorVoice(engine: AudioEngine, options: MotorVoiceOptions): MotorVoice {
  const { ctx } = engine;
  const { detuneCents } = options;

  // ---- Tone branch: triangle at f0 (the fundamental motor whine) ----
  const toneOsc = ctx.createOscillator();
  toneOsc.type = 'triangle';
  toneOsc.detune.value = detuneCents; // fixed for the voice's life — WebAudio combines frequency*2^(detune/1200) continuously, so this alone gives the authentic ±1.5% beat with no per-frame math.
  const toneGain = ctx.createGain();
  toneGain.gain.value = 0;
  toneOsc.connect(toneGain);

  // ---- Buzz branch: square at 3·f0 through a tracking bandpass (commutator) ----
  const buzzOsc = ctx.createOscillator();
  buzzOsc.type = 'square';
  buzzOsc.detune.value = detuneCents;
  const buzzFilter = ctx.createBiquadFilter();
  buzzFilter.type = 'bandpass';
  buzzFilter.Q.value = BUZZ_Q;
  buzzFilter.detune.value = detuneCents; // tracks the buzz oscillator's own detune so the passband stays centered on it
  const buzzGain = ctx.createGain();
  buzzGain.gain.value = 0;
  buzzOsc.connect(buzzFilter);
  buzzFilter.connect(buzzGain);

  // ---- Hiss branch: looped white noise through a tracking bandpass (brush) ----
  const hissSource = ctx.createBufferSource();
  hissSource.buffer = getNoiseBuffer(ctx);
  hissSource.loop = true;
  const hissFilter = ctx.createBiquadFilter();
  hissFilter.type = 'bandpass';
  hissFilter.Q.value = HISS_Q;
  hissFilter.detune.value = detuneCents; // same fixed per-voice detune as every other branch (pace/AI ≈+26 cents)
  const hissGain = ctx.createGain();
  hissGain.gain.value = 0;
  hissSource.connect(hissFilter);
  hissFilter.connect(hissGain);

  // ---- Shared voice bus: three branches -> gain -> pan -> master ----
  const voiceGain = ctx.createGain();
  voiceGain.gain.value = 1;
  const panner = ctx.createStereoPanner();
  toneGain.connect(voiceGain);
  buzzGain.connect(voiceGain);
  hissGain.connect(voiceGain);
  voiceGain.connect(panner);
  panner.connect(engine.master);

  // Sources start immediately and run for the voice's whole lifetime — every
  // branch gain starts at 0, so nothing is audible until update() raises it.
  // This is what "persistent per-car graph" means: no node is ever created or
  // torn down again until dispose().
  toneOsc.start();
  buzzOsc.start();
  hissSource.start();

  function update(input: MotorVoiceUpdate): void {
    const { v, throttle, x, vmax, tableHalfWidth, centerX } = input;
    const now = ctx.currentTime;

    const f0 = motorF0(v, vmax);
    const gains = motorGains(throttle, v, vmax);
    const pan = panForX(x, centerX, tableHalfWidth);

    toneOsc.frequency.setTargetAtTime(f0, now, TAU);
    buzzOsc.frequency.setTargetAtTime(f0 * BUZZ_HARMONIC, now, TAU);
    buzzFilter.frequency.setTargetAtTime(f0 * BUZZ_HARMONIC, now, TAU);
    hissFilter.frequency.setTargetAtTime(f0 * HISS_HARMONIC, now, TAU);

    toneGain.gain.setTargetAtTime(gains.tone, now, TAU);
    buzzGain.gain.setTargetAtTime(gains.buzz, now, TAU);
    hissGain.gain.setTargetAtTime(gains.hiss, now, TAU);

    panner.pan.setTargetAtTime(pan, now, TAU);
  }

  function dispose(): void {
    toneOsc.stop();
    buzzOsc.stop();
    hissSource.stop();
    toneOsc.disconnect();
    buzzOsc.disconnect();
    hissSource.disconnect();
    toneGain.disconnect();
    buzzFilter.disconnect();
    buzzGain.disconnect();
    hissFilter.disconnect();
    hissGain.disconnect();
    voiceGain.disconnect();
    panner.disconnect();
  }

  return { update, dispose };
}
