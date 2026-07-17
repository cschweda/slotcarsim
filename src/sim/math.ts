// Minimal 2D vector/angle helpers for track geometry. Plain functions over a
// plain {x, y} shape — only what path/builder code needs. No classes.

export interface Vec2 {
  x: number;
  y: number;
}

export function add(a: Vec2, b: Vec2): Vec2 {
  return { x: a.x + b.x, y: a.y + b.y };
}

export function sub(a: Vec2, b: Vec2): Vec2 {
  return { x: a.x - b.x, y: a.y - b.y };
}

export function scale(v: Vec2, k: number): Vec2 {
  return { x: v.x * k, y: v.y * k };
}

/** Rotate v by angle radians, CCW positive — matches the heading convention. */
export function rot(v: Vec2, angle: number): Vec2 {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  return { x: v.x * c - v.y * s, y: v.x * s + v.y * c };
}

export function len(v: Vec2): number {
  return Math.sqrt(v.x * v.x + v.y * v.y);
}

export function dist(a: Vec2, b: Vec2): number {
  return len(sub(a, b));
}

/** Wrap an angle (radians) into (−π, π]. */
export function wrapAngle(a: number): number {
  let result = a % (2 * Math.PI);
  if (result <= -Math.PI) {
    result += 2 * Math.PI;
  } else if (result > Math.PI) {
    result -= 2 * Math.PI;
  }
  return result;
}

export function clamp(x: number, lo: number, hi: number): number {
  return Math.min(Math.max(x, lo), hi);
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/**
 * Interpolate a car's arc-length position between two ticks on a closed loop
 * of length L, taking the SHORT FORWARD hop rather than a naive lerp — cars
 * only ever move forward, so a step that wraps past L back to a small value
 * (e.g. a=9.9, b=0.1, L=10) must interpolate through the s=0 line, not
 * backward across most of the lap. Returns a value in [0, L).
 */
export function wrapLerp(a: number, b: number, alpha: number, L: number): number {
  const forwardDistance = (((b - a) % L) + L) % L;
  const raw = a + forwardDistance * alpha;
  return ((raw % L) + L) % L;
}
