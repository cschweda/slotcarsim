import { describe, expect, it } from 'vitest';
import type { LapEvent } from '../sim/types';
import {
  AI_CAR_INDEX,
  COUNTDOWN_BEATS,
  PLAYER_CAR_INDEX,
  type RaceConfig,
  createRace,
  defaultAssistsForMode,
  raceHasAiCar,
} from './race';

const DT = 1 / 120;

function raceConfig(overrides: Partial<RaceConfig> = {}): RaceConfig {
  return {
    mode: 'race',
    lapsToWin: 5,
    playerLane: 0,
    aiDifficulty: 0.65,
    trackId: 'oval',
    playerCar: 'p917',
    practiceCompanion: 'alone',
    stickiness: 'authentic',
    coach: false,
    ...overrides,
  };
}

function lap(carIndex: number, lapNumber: number, lapTimeSec: number): LapEvent {
  return { type: 'lap', carIndex, lapNumber, lapTimeSec };
}

/** Advance the machine `seconds`, collecting every countdown beep emitted. */
function advance(race: ReturnType<typeof createRace>, seconds: number) {
  const beeps: { number: number; final: boolean }[] = [];
  const steps = Math.round(seconds / DT);
  for (let i = 0; i < steps; i++) beeps.push(...race.tick(DT));
  return beeps;
}

describe('createRace — countdown', () => {
  it('starts idle and enters countdown on start()', () => {
    const race = createRace(raceConfig());
    expect(race.phase()).toBe('idle');
    race.start();
    expect(race.phase()).toBe('countdown');
  });

  it('emits one beep per beat (3, 2, 1, then a final GO) and lasts COUNTDOWN_BEATS seconds', () => {
    const race = createRace(raceConfig());
    race.start();
    const beeps = advance(race, COUNTDOWN_BEATS + 0.05);
    expect(beeps.map((b) => b.number)).toEqual([3, 2, 1, 0]);
    expect(beeps.filter((b) => b.final)).toEqual([{ number: 0, final: true }]);
    expect(race.phase()).toBe('racing');
  });

  it('shows the current countdown number while counting down', () => {
    const race = createRace(raceConfig());
    race.start();
    advance(race, 0.01);
    expect(race.countdownNumber()).toBe(3);
    advance(race, 1);
    expect(race.countdownNumber()).toBe(2);
    advance(race, 1);
    expect(race.countdownNumber()).toBe(1);
  });

  it('ignores lap events until racing has actually begun', () => {
    const race = createRace(raceConfig());
    race.start(); // countdown, not racing
    race.handleSimEvent(lap(PLAYER_CAR_INDEX, 1, 2.0));
    expect(race.laps(PLAYER_CAR_INDEX)).toBe(0);
  });
});

describe('createRace — racing + win detection', () => {
  function startedRace(config = raceConfig()) {
    const race = createRace(config);
    race.start();
    advance(race, COUNTDOWN_BEATS + 0.05); // into racing
    return race;
  }

  it('tallies laps per car once racing', () => {
    const race = startedRace();
    race.handleSimEvent(lap(PLAYER_CAR_INDEX, 1, 2.1));
    race.handleSimEvent(lap(AI_CAR_INDEX, 1, 2.0));
    race.handleSimEvent(lap(PLAYER_CAR_INDEX, 2, 2.0));
    expect(race.laps(PLAYER_CAR_INDEX)).toBe(2);
    expect(race.laps(AI_CAR_INDEX)).toBe(1);
    expect(race.phase()).toBe('racing');
  });

  it('finishes when the PLAYER reaches lapsToWin, player as winner', () => {
    const race = startedRace(raceConfig({ lapsToWin: 3 }));
    for (let l = 1; l <= 3; l++) race.handleSimEvent(lap(PLAYER_CAR_INDEX, l, 2.0));
    expect(race.phase()).toBe('finished');
    const results = race.results()!;
    expect(results.winnerCarIndex).toBe(PLAYER_CAR_INDEX);
    expect(results.order[0]!.carIndex).toBe(PLAYER_CAR_INDEX);
    expect(results.order[0]!.isPlayer).toBe(true);
  });

  it('finishes when the AI reaches lapsToWin first, AI as winner (player can lose)', () => {
    const race = startedRace(raceConfig({ lapsToWin: 3 }));
    race.handleSimEvent(lap(PLAYER_CAR_INDEX, 1, 2.0));
    for (let l = 1; l <= 3; l++) race.handleSimEvent(lap(AI_CAR_INDEX, l, 1.9));
    expect(race.phase()).toBe('finished');
    const results = race.results()!;
    expect(results.winnerCarIndex).toBe(AI_CAR_INDEX);
    expect(results.order[0]!.carIndex).toBe(AI_CAR_INDEX);
    expect(results.order[1]!.carIndex).toBe(PLAYER_CAR_INDEX);
    expect(results.order[1]!.laps).toBe(1);
  });

  it('ignores further lap events after the race has finished', () => {
    const race = startedRace(raceConfig({ lapsToWin: 2 }));
    for (let l = 1; l <= 2; l++) race.handleSimEvent(lap(AI_CAR_INDEX, l, 1.9));
    expect(race.phase()).toBe('finished');
    race.handleSimEvent(lap(PLAYER_CAR_INDEX, 1, 2.0));
    expect(race.laps(PLAYER_CAR_INDEX)).toBe(0);
  });

  it('tracks the player best lap across the race', () => {
    const race = startedRace();
    race.handleSimEvent(lap(PLAYER_CAR_INDEX, 1, 2.4));
    race.handleSimEvent(lap(PLAYER_CAR_INDEX, 2, 2.1));
    race.handleSimEvent(lap(PLAYER_CAR_INDEX, 3, 2.25));
    expect(race.playerBestLapSec()).toBeCloseTo(2.1, 9);
  });

  it('Esc aborts a race back to idle', () => {
    const race = startedRace();
    race.handleSimEvent(lap(PLAYER_CAR_INDEX, 1, 2.0));
    race.abort();
    expect(race.phase()).toBe('idle');
  });
});

describe('createRace — time trial', () => {
  it('has a single (player) car, never auto-finishes, and tracks session best lap', () => {
    const race = createRace(raceConfig({ mode: 'timetrial' }));
    race.start();
    advance(race, COUNTDOWN_BEATS + 0.05);
    expect(race.phase()).toBe('racing');
    for (let l = 1; l <= 12; l++) race.handleSimEvent(lap(PLAYER_CAR_INDEX, l, l === 7 ? 1.8 : 2.2));
    // Way past any race's lapsToWin, but time trial is unlimited.
    expect(race.phase()).toBe('racing');
    expect(race.playerBestLapSec()).toBeCloseTo(1.8, 9);
    expect(race.laps(PLAYER_CAR_INDEX)).toBe(12);
  });
});

describe('createRace — practice (alone)', () => {
  function startedPractice(overrides: Partial<RaceConfig> = {}) {
    const race = createRace(raceConfig({ mode: 'practice', practiceCompanion: 'alone', ...overrides }));
    race.start();
    advance(race, COUNTDOWN_BEATS + 0.05);
    return race;
  }

  it('has a single (player) car — same semantics as time trial: never finishes, tracks best lap', () => {
    const race = startedPractice();
    for (let l = 1; l <= 20; l++) race.handleSimEvent(lap(PLAYER_CAR_INDEX, l, l === 5 ? 1.5 : 2.0));
    // Way past any race's lapsToWin (5), but practice is unlimited — never 'finished' at ANY lap count.
    expect(race.phase()).toBe('racing');
    expect(race.results()).toBeNull();
    expect(race.playerBestLapSec()).toBeCloseTo(1.5, 9);
    expect(race.laps(PLAYER_CAR_INDEX)).toBe(20);
  });

  it('ignores lap events for the AI car index (no companion present)', () => {
    const race = startedPractice();
    race.handleSimEvent(lap(AI_CAR_INDEX, 1, 2.0));
    expect(race.laps(AI_CAR_INDEX)).toBe(0);
  });
});

describe('createRace — practice (AI companion)', () => {
  function startedPracticeWithAi(overrides: Partial<RaceConfig> = {}) {
    const race = createRace(
      raceConfig({ mode: 'practice', practiceCompanion: 'ai', aiDifficulty: 0.9, ...overrides }),
    );
    race.start();
    advance(race, COUNTDOWN_BEATS + 0.05);
    return race;
  }

  it('tallies BOTH cars laps, and never finishes regardless of how many laps either car completes', () => {
    const race = startedPracticeWithAi();
    for (let l = 1; l <= 50; l++) race.handleSimEvent(lap(AI_CAR_INDEX, l, 1.9));
    for (let l = 1; l <= 50; l++) race.handleSimEvent(lap(PLAYER_CAR_INDEX, l, 2.0));
    expect(race.phase()).toBe('racing'); // never 'finished' — practice has no win condition, AI or no AI
    expect(race.results()).toBeNull();
    expect(race.laps(AI_CAR_INDEX)).toBe(50);
    expect(race.laps(PLAYER_CAR_INDEX)).toBe(50);
    expect(race.playerBestLapSec()).toBeCloseTo(2.0, 9);
  });

  it('plumbs the chosen aiDifficulty through unchanged (config passthrough)', () => {
    const race = startedPracticeWithAi({ aiDifficulty: 0.35 });
    expect(race.config.aiDifficulty).toBe(0.35);
  });
});

describe('raceHasAiCar(config)', () => {
  it('true for race vs AI', () => {
    expect(raceHasAiCar(raceConfig({ mode: 'race' }))).toBe(true);
  });

  it('false for time trial', () => {
    expect(raceHasAiCar(raceConfig({ mode: 'timetrial' }))).toBe(false);
  });

  it('practice: true only when practiceCompanion is "ai"', () => {
    expect(raceHasAiCar(raceConfig({ mode: 'practice', practiceCompanion: 'alone' }))).toBe(false);
    expect(raceHasAiCar(raceConfig({ mode: 'practice', practiceCompanion: 'ai' }))).toBe(true);
  });
});

describe('defaultAssistsForMode(mode) — per-mode menu defaults', () => {
  it('practice defaults to the most forgiving learning setup: Sticky, coach on, alone', () => {
    expect(defaultAssistsForMode('practice')).toEqual({
      stickiness: 'sticky',
      coach: true,
      practiceCompanion: 'alone',
    });
  });

  it('time trial defaults to the purist setup: Authentic, coach off', () => {
    expect(defaultAssistsForMode('timetrial')).toEqual({
      stickiness: 'authentic',
      coach: false,
      practiceCompanion: 'alone',
    });
  });

  it('race vs AI defaults to Off/Authentic — a fair, unassisted contest', () => {
    expect(defaultAssistsForMode('race')).toEqual({
      stickiness: 'authentic',
      coach: false,
      practiceCompanion: 'alone',
    });
  });
});
