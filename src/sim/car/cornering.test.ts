import { describe, expect, it } from 'vitest';
import type { Tuning } from '../../config/tuning';
import { TUNING } from '../../config/tuning';
import { stepCornering } from './cornering';

const DT = 1 / 120;
const IN = 0.0254;

function freshState() {
  return { aLatFiltered: 0, slideYaw: 0, hardTicks: 0 };
}

describe('stepCornering', () => {
  it('steady-state: v just below sqrt(gripSoft·r) on a constant-radius turn settles to slideYaw≈0 and no scrub', () => {
    const cfg: Tuning = { ...TUNING };
    const r = 1;
    const kappa = 1 / r;
    const v = Math.sqrt(cfg.gripSoft * r) * 0.95; // comfortably under the soft limit

    let state = freshState();
    // Run well past both filter time constants so the filtered demand settles.
    const ticks = Math.ceil((10 * cfg.latFilterTau) / DT);
    let lastResult;
    for (let i = 0; i < ticks; i++) {
      lastResult = stepCornering(state, v, kappa, DT, cfg);
      state = { aLatFiltered: lastResult.aLatFiltered, slideYaw: lastResult.slideYaw, hardTicks: lastResult.hardTicks };
    }

    expect(state.aLatFiltered).toBeLessThan(cfg.gripSoft);
    expect(Math.abs(state.slideYaw)).toBeLessThan(0.005);
    expect(lastResult!.scrubDecel).toBe(0);
    expect(lastResult!.deslotTriggered).toBe(false);
  });

  it('deslot triggers within (deslotDwell + 4·latFilterTau) sim-seconds when v sustains above sqrt(gripHard·r)', () => {
    const cfg: Tuning = { ...TUNING };
    const r = 1;
    const kappa = 1 / r;
    const v = Math.sqrt(2 * cfg.gripHard * r); // aLat steady-state = 2·gripHard: comfortable margin

    let state = freshState();
    const budgetSeconds = cfg.deslotDwell + 4 * cfg.latFilterTau;
    const maxTicks = Math.ceil(budgetSeconds / DT);

    let triggeredAtTick = -1;
    for (let i = 1; i <= maxTicks; i++) {
      const result = stepCornering(state, v, kappa, DT, cfg);
      state = { aLatFiltered: result.aLatFiltered, slideYaw: result.slideYaw, hardTicks: result.hardTicks };
      if (result.deslotTriggered) {
        triggeredAtTick = i;
        break;
      }
    }

    expect(triggeredAtTick).toBeGreaterThan(-1);
    expect(triggeredAtTick * DT).toBeLessThanOrEqual(budgetSeconds);
  });

  it('a single-tick 9″-curve κ spike between straight ticks does NOT trigger deslot (joint-boundary protection)', () => {
    const cfg: Tuning = { ...TUNING };
    const r9 = 9 * IN;
    const kappaSpike = 1 / r9;
    const v = 2.5;

    let state = freshState();

    // Settle on a straight first (kappa=0), like a car approaching the joint.
    for (let i = 0; i < 30; i++) {
      const result = stepCornering(state, v, 0, DT, cfg);
      state = { aLatFiltered: result.aLatFiltered, slideYaw: result.slideYaw, hardTicks: result.hardTicks };
      expect(result.deslotTriggered).toBe(false);
    }

    // Exactly one tick of curve κ (the joint), then back to straight.
    const spikeResult = stepCornering(state, v, kappaSpike, DT, cfg);
    state = {
      aLatFiltered: spikeResult.aLatFiltered,
      slideYaw: spikeResult.slideYaw,
      hardTicks: spikeResult.hardTicks,
    };
    expect(spikeResult.deslotTriggered).toBe(false);

    // Many more straight ticks afterward — never triggers.
    for (let i = 0; i < 120; i++) {
      const result = stepCornering(state, v, 0, DT, cfg);
      state = { aLatFiltered: result.aLatFiltered, slideYaw: result.slideYaw, hardTicks: result.hardTicks };
      expect(result.deslotTriggered).toBe(false);
    }
  });

  it('slideYaw sign follows κ sign (left positive, right negative) and decays to ~0 within ~5·slideTau after κ returns to 0', () => {
    const cfg: Tuning = { ...TUNING };
    const r = 1;
    const v = Math.sqrt(cfg.gripSoft * r + 1.5); // over ≈ 1.5 m/s², well clear of gripHard

    for (const kappaSign of [1, -1] as const) {
      let state = freshState();
      const kappa = kappaSign / r;

      // Build up slide over several time constants.
      const buildTicks = Math.ceil((10 * Math.max(cfg.latFilterTau, cfg.slideTau)) / DT);
      for (let i = 0; i < buildTicks; i++) {
        const result = stepCornering(state, v, kappa, DT, cfg);
        state = { aLatFiltered: result.aLatFiltered, slideYaw: result.slideYaw, hardTicks: result.hardTicks };
      }

      if (kappaSign > 0) {
        expect(state.slideYaw).toBeGreaterThan(0);
      } else {
        expect(state.slideYaw).toBeLessThan(0);
      }
      const peakMagnitude = Math.abs(state.slideYaw);
      expect(peakMagnitude).toBeGreaterThan(0.01); // sanity: actually built up a real slide

      // Return to straight running; decay within ~5·slideTau (+ margin for the
      // filter's own lag before `over` drops to 0).
      const decayTicks = Math.ceil((5 * cfg.slideTau + 5 * cfg.latFilterTau) / DT);
      for (let i = 0; i < decayTicks; i++) {
        const result = stepCornering(state, v, 0, DT, cfg);
        state = { aLatFiltered: result.aLatFiltered, slideYaw: result.slideYaw, hardTicks: result.hardTicks };
      }

      expect(Math.abs(state.slideYaw)).toBeLessThan(peakMagnitude * 0.02);
    }
  });

  it('caps slide yaw magnitude at 0.6 rad even under extreme over-limit demand', () => {
    const cfg: Tuning = { ...TUNING };
    const r = 1;
    const v = 20; // wildly over both limits
    const kappa = 1 / r;

    let state = freshState();
    for (let i = 0; i < 500; i++) {
      const result = stepCornering(state, v, kappa, DT, cfg);
      state = { aLatFiltered: result.aLatFiltered, slideYaw: result.slideYaw, hardTicks: result.hardTicks };
      expect(Math.abs(result.slideYaw)).toBeLessThanOrEqual(0.6 + 1e-9);
    }
  });

  it('scrub decel is proportional to over-soft filtered demand: scrubPerAccel·over', () => {
    const cfg: Tuning = { ...TUNING };
    const r = 1;
    const v = Math.sqrt(cfg.gripSoft * r + 1); // over → ~1 m/s² at steady state
    const kappa = 1 / r;

    let state = freshState();
    let last;
    for (let i = 0; i < 500; i++) {
      last = stepCornering(state, v, kappa, DT, cfg);
      state = { aLatFiltered: last.aLatFiltered, slideYaw: last.slideYaw, hardTicks: last.hardTicks };
    }

    const over = Math.max(0, state.aLatFiltered - cfg.gripSoft);
    expect(last!.scrubDecel).toBeCloseTo(cfg.scrubPerAccel * over, 9);
  });
});
