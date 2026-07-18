// Tests ONLY the auto quality ladder's tier-stepping DECISION logic
// (buildLadderTiers / createLadderPolicy) — plain data plus an injected
// applyTier callback, with no three.js/DOM dependency, so it's exercisable
// here without a real WebGLRenderer. createScene/createQualityLadder's own
// renderer/light wiring needs a live WebGL context and is verified by
// browser check instead (see the M8 report).
import { describe, expect, it } from 'vitest';
import { buildLadderTiers, createLadderPolicy, type QualityLadderTier } from './scene';

const HIGH: QualityLadderTier = { label: 'high', dpr: 2, shadowMapSize: 2048, shadowsEnabled: true };
const MEDIUM: QualityLadderTier = { label: 'medium', dpr: 1.5, shadowMapSize: 1024, shadowsEnabled: true };
const LOW: QualityLadderTier = { label: 'low', dpr: 1.25, shadowMapSize: 1024, shadowsEnabled: true };

describe('buildLadderTiers', () => {
  it('builds the full 5-tier descent from "high": dpr 2 -> 1.5 -> 1.25 -> shadow 1024 -> shadows off', () => {
    const tiers = buildLadderTiers(HIGH);
    expect(tiers.map((t) => [t.dpr, t.shadowMapSize, t.shadowsEnabled])).toEqual([
      [2, 2048, true],
      [1.5, 2048, true],
      [1.25, 2048, true],
      [1.25, 1024, true],
      [1.25, 1024, false],
    ]);
  });

  it('skips already-satisfied steps starting from "medium" (dpr 1.5 / shadow 1024 already)', () => {
    const tiers = buildLadderTiers(MEDIUM);
    expect(tiers.map((t) => [t.dpr, t.shadowMapSize, t.shadowsEnabled])).toEqual([
      [1.5, 1024, true],
      [1.25, 1024, true],
      [1.25, 1024, false],
    ]);
  });

  it('starting from "low" (already dpr 1.25 / shadow 1024) only has the shadows-off step left', () => {
    const tiers = buildLadderTiers(LOW);
    expect(tiers.map((t) => [t.dpr, t.shadowMapSize, t.shadowsEnabled])).toEqual([
      [1.25, 1024, true],
      [1.25, 1024, false],
    ]);
  });

  it('the ceiling tier (index 0) is always exactly the starting tier, unchanged', () => {
    for (const start of [HIGH, MEDIUM, LOW]) {
      expect(buildLadderTiers(start)[0]).toEqual(start);
    }
  });
});

/** Feed `n` frames of `ms` each into a policy. */
function feed(policy: ReturnType<typeof createLadderPolicy>, ms: number, n: number): void {
  for (let i = 0; i < n; i++) policy.sample(ms);
}

/**
 * Frame count so that, feeding `ms`-long frames, exactly `targetAccumSeconds`
 * of good-streak accumulation has happened by the last call. The first 119
 * calls only fill the rolling window (no average is evaluated, per
 * `if (buffer.length < LADDER_WINDOW) return`); evaluation — and so
 * goodSeconds accumulation — begins on the 120th call.
 */
function framesForAccumulatedSeconds(ms: number, targetAccumSeconds: number): number {
  const WARMUP_CALLS = 119;
  const accumulatingFrames = Math.ceil((targetAccumSeconds * 1000) / ms);
  return WARMUP_CALLS + accumulatingFrames;
}

describe('createLadderPolicy — step down', () => {
  it('does nothing before a full 120-frame window has accumulated', () => {
    const applied: number[] = [];
    const policy = createLadderPolicy(HIGH, (t) => applied.push(t.dpr));
    feed(policy, 25, 119); // one short of a full window, well above the 20ms threshold
    expect(policy.tierIndex()).toBe(0);
    expect(applied).toEqual([]);
  });

  it('steps down exactly once per fresh full window averaging > 20ms', () => {
    const applied: QualityLadderTier[] = [];
    const policy = createLadderPolicy(HIGH, (t) => applied.push(t));
    feed(policy, 25, 120); // a full window, avg 25ms > 20ms
    expect(policy.tierIndex()).toBe(1);
    expect(applied).toHaveLength(1);
    expect(applied[0]!.dpr).toBe(1.5);
  });

  it('keeps stepping down through further fresh sustained-bad windows, never past rock bottom', () => {
    const policy = createLadderPolicy(HIGH, () => {});
    const tiers = buildLadderTiers(HIGH);
    for (let step = 0; step < tiers.length + 2; step++) {
      feed(policy, 30, 120);
    }
    expect(policy.tierIndex()).toBe(tiers.length - 1); // pinned at rock bottom, not beyond
    expect(policy.blobShadowsActive()).toBe(true);
  });

  it('a sub-20ms average never triggers a step down', () => {
    const policy = createLadderPolicy(HIGH, () => {
      throw new Error('should not have stepped');
    });
    feed(policy, 15, 500);
    expect(policy.tierIndex()).toBe(0);
  });

  it('exposes the tier label for the debug panel', () => {
    const policy = createLadderPolicy(HIGH, () => {});
    expect(policy.tierLabel()).toBe('high');
    feed(policy, 25, 120);
    expect(policy.tierLabel()).toBe('high-dpr1.5');
  });
});

describe('createLadderPolicy — step up (hysteresis)', () => {
  function steppedDownOnce(): ReturnType<typeof createLadderPolicy> {
    const policy = createLadderPolicy(HIGH, () => {});
    feed(policy, 25, 120); // step down to index 1
    expect(policy.tierIndex()).toBe(1);
    return policy;
  }

  it('does NOT step up before 10 sustained seconds of a sub-12ms window average', () => {
    const policy = steppedDownOnce();
    feed(policy, 8, framesForAccumulatedSeconds(8, 9.5)); // comfortably short of the 10s threshold
    expect(policy.tierIndex()).toBe(1);
  });

  it('steps up after >=10 sustained seconds of a sub-12ms window average', () => {
    const policy = steppedDownOnce();
    feed(policy, 8, framesForAccumulatedSeconds(8, 10.5)); // comfortably past the 10s threshold
    expect(policy.tierIndex()).toBe(0);
  });

  it('never rises above tier 0 (the user\'s ?quality cap)', () => {
    const policy = createLadderPolicy(HIGH, () => {}); // already at tier 0
    feed(policy, 5, Math.ceil((20 * 1000) / 5));
    expect(policy.tierIndex()).toBe(0);
  });

  it('a mid-band average (12..20ms) neither steps down nor accumulates toward stepping up', () => {
    const policy = steppedDownOnce();
    feed(policy, 16, Math.ceil((30 * 1000) / 16)); // well over 10s, but 16ms is between the two thresholds
    expect(policy.tierIndex()).toBe(1);
  });

  it('a tier change resets the window, so a stale bad sample just before stepping up cannot immediately re-trigger a step down', () => {
    const policy = steppedDownOnce();
    feed(policy, 8, framesForAccumulatedSeconds(8, 10.5)); // steps back up to tier 0
    expect(policy.tierIndex()).toBe(0);
    // Fewer than 120 fresh samples since the step — must not have stepped down again yet.
    feed(policy, 25, 50);
    expect(policy.tierIndex()).toBe(0);
  });
});

describe('createLadderPolicy — avgFrameMs (debug panel readout)', () => {
  it('is 0 before any sample', () => {
    const policy = createLadderPolicy(HIGH, () => {});
    expect(policy.avgFrameMs()).toBe(0);
  });

  it('tracks the mean of the samples seen so far, even before a full window', () => {
    const policy = createLadderPolicy(HIGH, () => {});
    feed(policy, 10, 5);
    expect(policy.avgFrameMs()).toBeCloseTo(10, 9);
  });

  it('a tier change resets it (stepTo clears the buffer), then it tracks the fresh window', () => {
    const policy = createLadderPolicy(HIGH, () => {});
    feed(policy, 30, 120); // fills the window at 30ms avg — steps down (30 > 20) on the 120th sample
    expect(policy.tierIndex()).toBe(1);
    expect(policy.avgFrameMs()).toBe(0); // stepTo() clears the buffer on every tier change
    feed(policy, 10, 120); // a fresh full window of 10ms samples after the reset
    expect(policy.avgFrameMs()).toBeCloseTo(10, 9);
  });
});

describe('createQualityLadder blobShadowsActive', () => {
  it('is false while shadows are still enabled, true only once the rock-bottom tier disables them', () => {
    const policy = createLadderPolicy(LOW, () => {}); // low: only one step (shadows off) exists
    expect(policy.blobShadowsActive()).toBe(false);
    feed(policy, 25, 120);
    expect(policy.tierIndex()).toBe(1);
    expect(policy.blobShadowsActive()).toBe(true);
  });
});
