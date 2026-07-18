// Pure mouse-wheel/trackpad-pinch zoom math for the track camera. No
// three.js/DOM here — main.ts (the thin wiring surface) reads wheel events on
// the canvas host, calls stepZoom() to get a new clamped TARGET multiplier,
// and calls approachZoom() every frame to ease the camera's actual distance
// toward that target. The multiplier scales the length of the fitted camera
// offset (main.ts's CAM_OFFSET, already per-track-scaled by reframeCamera) —
// the lookAt point is never touched, so zooming never re-centers the view.

/** Close-up bound: the camera can come in to 35% of the fitted distance. */
export const ZOOM_MIN = 0.35;
/** Zoomed-out bound: a touch beyond the established "fits the whole track" framing. */
export const ZOOM_MAX = 1.15;
/** The un-zoomed default — main.ts resets to this on every session/track rebuild. */
export const ZOOM_DEFAULT = 1.0;

// A standard (non-trackpad) mouse wheel reports ~100 deltaY per notch in
// every mainstream browser. Tuned so 5 such notches (500 deltaY) sweep the
// entire [ZOOM_MIN, ZOOM_MAX] span (1.15 − 0.35 = 0.8): 0.8 / 500 = 0.0016
// per deltaY unit.
const WHEEL_SENSITIVITY = 0.0016;
/** Trackpad pinch (ctrlKey wheel events) reports much smaller deltaY per gesture-tick than a physical notch — boosted so a pinch feels comparably responsive rather than sluggish. */
const PINCH_SENSITIVITY_SCALE = 2.5;

export interface StepZoomOptions {
  /** True for a trackpad-pinch-synthesized wheel event (event.ctrlKey) — a bit more sensitive per unit of deltaY than a physical mouse notch. */
  pinch?: boolean;
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

/**
 * One wheel event's effect on the TARGET zoom multiplier, clamped to
 * [ZOOM_MIN, ZOOM_MAX]. Convention (matching every mainstream 3D
 * app/map/canvas tool, e.g. Google Maps, Blender, Figma): scrolling the wheel
 * up/away from you — a NEGATIVE `deltaY`, per the WheelEvent spec — zooms IN
 * (a smaller multiplier, camera closer); scrolling down/toward you zooms OUT.
 */
export function stepZoom(current: number, deltaY: number, opts: StepZoomOptions = {}): number {
  const sensitivity = WHEEL_SENSITIVITY * (opts.pinch ? PINCH_SENSITIVITY_SCALE : 1);
  return clamp(current + deltaY * sensitivity, ZOOM_MIN, ZOOM_MAX);
}

/** Time constant for approachZoom's ease — quick enough to feel responsive, slow enough to avoid a jarring snap to a new wheel target. */
const DEFAULT_TAU_SEC = 0.15;

/**
 * Eases `current` toward `target` over `dt` seconds via a frame-rate-independent
 * exponential approach — the same 1 − e^(−dt/τ) shape as this codebase's
 * WebAudio `setTargetAtTime` glides (audio/engine.ts's mute, motorVoice.ts's
 * parameter updates). Never overshoots, asymptotically converges, and a dt of
 * 0 (or current already at target) is a no-op.
 */
export function approachZoom(current: number, target: number, dt: number, tau: number = DEFAULT_TAU_SEC): number {
  const alpha = 1 - Math.exp(-Math.max(0, dt) / tau);
  return current + (target - current) * alpha;
}
