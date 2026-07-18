import { describe, expect, it } from 'vitest';
import { TUNING } from '../../config/tuning';
import { aLatEff, maxCornerSpeed } from './aLatEff';

const IN = 0.0254;
const G = TUNING.gravity;

// The 9" inner lane: centerline radius 9", minus the lane offset — the tightest
// corner in the catalog, and the one the brief pins the banked-speed sanity
// numbers against.
const R_INNER_9 = 9 * IN - TUNING.laneOffset; // ≈ 0.20955 m
const KAPPA_INNER_9 = 1 / R_INNER_9; // ≈ 4.772 1/m
const BANK_30 = 0.5236; // 30° in radians

describe('aLatEff — the ONE shared effective-lateral-demand helper', () => {
  it('bank 0 reproduces the raw v²·|κ| term EXACTLY (the flat-track regression bridge)', () => {
    for (const v of [0, 0.5, 1.5, 2.7, 3.0]) {
      for (const kappa of [0, KAPPA_INNER_9, -KAPPA_INNER_9, 1 / (6 * IN)]) {
        // Object.is: not just close — bit-identical to the pre-M12 expression.
        expect(Object.is(aLatEff(v, kappa, 0, G), v * v * Math.abs(kappa))).toBe(true);
      }
    }
  });

  it('the max(0, …) floor holds a slow car in the slot on a steep bank (never falls inward)', () => {
    // A stationary car on a 30° bank: v²·|κ|·cos − G·sin < 0, floored to 0.
    expect(aLatEff(0, KAPPA_INNER_9, BANK_30, G)).toBe(0);
    // A crawling car, still below the point where the banked demand goes positive.
    expect(aLatEff(0.5, KAPPA_INNER_9, BANK_30, G)).toBe(0);
  });

  it('banking reduces effective demand: same v/κ demands less on a bank than flat', () => {
    const v = 1.9;
    expect(aLatEff(v, KAPPA_INNER_9, BANK_30, G)).toBeLessThan(aLatEff(v, KAPPA_INNER_9, 0, G));
  });
});

describe('maxCornerSpeed — the inverse (banked corners allow a higher closed-form cap)', () => {
  it('flat 9" inner-lane deslot speed ≈ 1.518 m/s (sqrt(gripHard·r))', () => {
    expect(maxCornerSpeed(TUNING.gripHard, KAPPA_INNER_9, 0, G)).toBeCloseTo(1.518, 3);
  });

  it('30°-banked 9" inner-lane deslot speed ≈ 1.96 m/s — the whole point of banking', () => {
    const banked = maxCornerSpeed(TUNING.gripHard, KAPPA_INNER_9, BANK_30, G);
    expect(banked).toBeCloseTo(1.96, 2);
    // The closed form the brief pins: sqrt((gripHard + G·sinθ)/(|κ|·cosθ)).
    const closedForm = Math.sqrt(
      (TUNING.gripHard + G * Math.sin(BANK_30)) / (KAPPA_INNER_9 * Math.cos(BANK_30)),
    );
    expect(banked).toBeCloseTo(closedForm, 12);
  });

  it('is the exact inverse of aLatEff in the holding regime', () => {
    for (const bank of [0, 0.2, BANK_30, 0.7]) {
      const C = TUNING.gripHard;
      const v = maxCornerSpeed(C, KAPPA_INNER_9, bank, G);
      expect(aLatEff(v, KAPPA_INNER_9, bank, G)).toBeCloseTo(C, 9);
    }
  });

  it('returns Infinity on a straight (κ→0) so a flat straight is never corner-capped', () => {
    expect(maxCornerSpeed(TUNING.gripHard, 0, 0, G)).toBe(Infinity);
  });
});
