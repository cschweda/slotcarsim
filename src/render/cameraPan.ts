// Pure click-and-drag / gamepad-stick camera panning math for the track
// camera. No three.js/DOM here — main.ts (the thin wiring surface) listens
// for pointer events on the canvas host AND polls the left gamepad stick,
// converts each into a world-plane delta, and folds it into a pan TARGET:
// the sim-plane (x, y) point main.ts's applyCameraFraming() re-centers BOTH
// the camera's lookAt and its position on every frame — exactly the way
// approachZoom()'s output rescales that SAME fitted offset's length. Mouse
// drag, wheel zoom, and the gamepad sticks all fold into the same per-frame
// framing call, so they compose for free.

/** A sim-plane (x, y) point — main.ts maps this to three-space via `(x, ·, −y)`, the same convention reframeCamera's own lookAt has always used. */
export interface Vec2 {
  x: number;
  y: number;
}

export interface PanBounds {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
}

/** How far past the track's own bounding box the pan target may still travel — enough to nudge the framing past the very edge, never far enough to lose the track entirely. */
export const PAN_MARGIN_M = 0.3;

/** Full-deflection LEFT STICK pan rate, in canvas-widths of world distance per second — tuned to feel comparable to a fast physical drag at whatever the CURRENT zoom's visibleWorldWidth is. */
export const STICK_PAN_WIDTHS_PER_SEC = 0.8;

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

/**
 * The pan target's allowed range: the track's own sim-plane bounding box
 * (center ± half-extent), padded by `margin` on every side.
 */
export function panBoundsFromBBox(
  bbox: { cx: number; cy: number; hx: number; hy: number },
  margin: number = PAN_MARGIN_M,
): PanBounds {
  return {
    minX: bbox.cx - bbox.hx - margin,
    maxX: bbox.cx + bbox.hx + margin,
    minY: bbox.cy - bbox.hy - margin,
    maxY: bbox.cy + bbox.hy + margin,
  };
}

/**
 * One pointer-move's screen-pixel delta → a world-plane delta, scaled so the
 * point under the cursor travels the same world distance the cursor itself
 * travelled (a "grab and drag" 1:1 feel): `visibleWorldWidth` is how many
 * world meters span the canvas's full width at the CURRENT zoom (main.ts
 * derives it from the camera's fov/aspect and its live zoomed distance);
 * `canvasWidthPx` is that same canvas's current CSS pixel width. Pixels are
 * square (no separate horizontal/vertical scale), so the same
 * world-units-per-pixel ratio applies to both the x and y delta.
 */
export function screenDeltaToWorld(
  screenDx: number,
  screenDy: number,
  visibleWorldWidth: number,
  canvasWidthPx: number,
): Vec2 {
  const unitsPerPx = canvasWidthPx > 0 ? visibleWorldWidth / canvasWidthPx : 0;
  return { x: screenDx * unitsPerPx, y: screenDy * unitsPerPx };
}

/** Clamp a pan target into `bounds`, independently per axis. */
export function clampPanTarget(target: Vec2, bounds: PanBounds): Vec2 {
  return {
    x: clamp(target.x, bounds.minX, bounds.maxX),
    y: clamp(target.y, bounds.minY, bounds.maxY),
  };
}

/**
 * Folds one pointer-move event into the current pan target — a "grab and
 * drag" feel: the world point under the cursor follows the cursor. `x` and
 * `y` need OPPOSITE arithmetic here because of this table's own coordinate
 * convention (sim `y` maps to three `−z` — see reframeCamera's lookAt)
 * combined with how a downward-tilted camera's screen-vertical maps to that
 * same depth axis: dragging RIGHT slides the target LEFT (`x`: subtract the
 * converted delta) but dragging DOWN slides the target's `y` UP, i.e.
 * increases it (`y`: add). Verified against the real running app, not just
 * derived on paper — a wrong sign here is a classic, easy-to-make mistake.
 * A zero screen delta is exactly a no-op.
 */
export function stepPan(
  current: Vec2,
  screenDx: number,
  screenDy: number,
  visibleWorldWidth: number,
  canvasWidthPx: number,
  bounds: PanBounds,
): Vec2 {
  if (screenDx === 0 && screenDy === 0) return current;
  const delta = screenDeltaToWorld(screenDx, screenDy, visibleWorldWidth, canvasWidthPx);
  return clampPanTarget({ x: current.x - delta.x, y: current.y + delta.y }, bounds);
}

/**
 * Per-frame pan-target velocity from a LEFT STICK (x, y) reading (already
 * radially deadzoned — see input/gamepad.ts's readGamepadCameraInput;
 * standard axes[0]/[1] convention: stickY negative = pushed up). Unlike
 * stepPan's mouse-drag "grab and slide the content" metaphor (which moves
 * the target OPPOSITE to the gesture), a stick pans the CAMERA directly —
 * the same convention as an RTS/flight-camera stick or an arrow-key map
 * scroll: pushing the stick up/right moves the camera's own focus up/right
 * across the table, revealing more of what's in that direction — i.e. the
 * exact OPPOSITE sign, per axis, from stepPan's drag delta.
 * `rateWidthsPerSec` canvas-widths of world distance sweep per second at
 * full deflection, so top speed feels comparable to a fast physical drag at
 * the current zoom. A zero stick reading is exactly a no-op.
 */
export function stepPanFromStick(
  current: Vec2,
  stickX: number,
  stickY: number,
  dt: number,
  visibleWorldWidth: number,
  bounds: PanBounds,
  rateWidthsPerSec: number = STICK_PAN_WIDTHS_PER_SEC,
): Vec2 {
  if (stickX === 0 && stickY === 0) return current;
  const worldPerSec = visibleWorldWidth * rateWidthsPerSec;
  const next = {
    x: current.x + stickX * worldPerSec * dt,
    y: current.y - stickY * worldPerSec * dt,
  };
  return clampPanTarget(next, bounds);
}
