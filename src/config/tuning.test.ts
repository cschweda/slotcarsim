import { describe, expect, it } from 'vitest';
import {
  STICKINESS_LEVELS,
  TUNING,
  applyStickiness,
  stepStickiness,
  stickinessGrip,
  stickinessIndex,
  type Tuning,
} from './tuning';

describe('STICKINESS_LEVELS', () => {
  it('is authentic -> sticky -> magna -> glue, ascending multiplier, authentic at 1.0', () => {
    expect(STICKINESS_LEVELS.map((l) => l.id)).toEqual(['authentic', 'sticky', 'magna', 'glue']);
    expect(STICKINESS_LEVELS[0]!.mult).toBe(1.0);
    for (let i = 1; i < STICKINESS_LEVELS.length; i++) {
      expect(STICKINESS_LEVELS[i]!.mult).toBeGreaterThan(STICKINESS_LEVELS[i - 1]!.mult);
    }
  });
});

describe('stickinessGrip(id) — mapping math', () => {
  it('authentic reproduces the base 8/11 exactly (mult 1.0)', () => {
    const g = stickinessGrip('authentic');
    expect(g.gripSoft).toBeCloseTo(8, 9);
    expect(g.gripHard).toBeCloseTo(11, 9);
  });

  it('magna matches the documented Magna-Traction reference values (~17/24)', () => {
    const g = stickinessGrip('magna');
    expect(g.gripSoft).toBeCloseTo(16.8, 9);
    expect(g.gripHard).toBeCloseTo(23.1, 9);
  });

  it('sticky and glue scale the same base 8/11 by their own multiplier', () => {
    const sticky = stickinessGrip('sticky');
    expect(sticky.gripSoft).toBeCloseTo(12, 9);
    expect(sticky.gripHard).toBeCloseTo(16.5, 9);

    const glue = stickinessGrip('glue');
    expect(glue.gripSoft).toBeCloseTo(21.6, 9);
    expect(glue.gripHard).toBeCloseTo(29.7, 9);
  });

  it('is monotonically increasing across levels for both gripSoft and gripHard', () => {
    const values = STICKINESS_LEVELS.map((l) => stickinessGrip(l.id));
    for (let i = 1; i < values.length; i++) {
      expect(values[i]!.gripSoft).toBeGreaterThan(values[i - 1]!.gripSoft);
      expect(values[i]!.gripHard).toBeGreaterThan(values[i - 1]!.gripHard);
    }
  });
});

describe('applyStickiness(cfg, id) — the ?tune live-mutation pattern', () => {
  it('mutates gripSoft/gripHard on the SAME cfg object (no cloning)', () => {
    const cfg: Tuning = { ...TUNING };
    const ref = cfg;
    applyStickiness(cfg, 'magna');
    expect(cfg).toBe(ref); // same object identity
    expect(cfg.gripSoft).toBeCloseTo(16.8, 9);
    expect(cfg.gripHard).toBeCloseTo(23.1, 9);
  });

  it('is idempotent regardless of the cfg gripSoft/gripHard value beforehand (re-derives from the fixed base, not from whatever is currently on cfg)', () => {
    const cfg: Tuning = { ...TUNING };
    applyStickiness(cfg, 'glue');
    // Applying a lower level afterward must land on THAT level's base-derived
    // value, not compound on top of glue's already-scaled numbers.
    applyStickiness(cfg, 'authentic');
    expect(cfg.gripSoft).toBeCloseTo(8, 9);
    expect(cfg.gripHard).toBeCloseTo(11, 9);
  });

  it('leaves every other cfg field untouched', () => {
    const cfg: Tuning = { ...TUNING };
    applyStickiness(cfg, 'magna');
    expect(cfg.brakeK).toBe(TUNING.brakeK);
    expect(cfg.accelPerVolt).toBe(TUNING.accelPerVolt);
    expect(cfg.vmax).toBe(TUNING.vmax);
  });
});

describe('stickinessIndex(id)', () => {
  it('maps each id to its position in STICKINESS_LEVELS', () => {
    expect(stickinessIndex('authentic')).toBe(0);
    expect(stickinessIndex('sticky')).toBe(1);
    expect(stickinessIndex('magna')).toBe(2);
    expect(stickinessIndex('glue')).toBe(3);
  });
});

describe('stepStickiness(id, dir) — practice-mode live [ ]/[ ] adjust', () => {
  it('] (dir +1) steps to the next more-forgiving level', () => {
    expect(stepStickiness('authentic', 1)).toBe('sticky');
    expect(stepStickiness('sticky', 1)).toBe('magna');
    expect(stepStickiness('magna', 1)).toBe('glue');
  });

  it('[ (dir -1) steps to the previous, less-forgiving level', () => {
    expect(stepStickiness('glue', -1)).toBe('magna');
    expect(stepStickiness('magna', -1)).toBe('sticky');
    expect(stepStickiness('sticky', -1)).toBe('authentic');
  });

  it('clamps at the top end: ] at glue (the last level) stays at glue', () => {
    expect(stepStickiness('glue', 1)).toBe('glue');
  });

  it('clamps at the bottom end: [ at authentic (the first level) stays at authentic', () => {
    expect(stepStickiness('authentic', -1)).toBe('authentic');
  });
});
