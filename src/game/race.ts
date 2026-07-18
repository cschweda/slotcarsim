// The race state machine: idle → countdown(3 beats) → racing → finished.
// DOM-free and sim-agnostic — main.ts owns the Three/audio/sim and drives this
// with dt (for the countdown) and sim lap events (for tallies + win
// detection), then reads phase/countdown/results back to steer the HUD, the
// countdown beeps, and the AI/player gating. Unit-tested in race.test.ts.
//
// `CarStyleId` is a pure string-union type import (erased at build/test time),
// so pulling it from render/carMesh introduces no Three or DOM dependency.
// `StickinessId` (config/tuning.ts) is likewise a type-only import.
import type { StickinessId } from '../config/tuning';
import type { CarStyleId } from '../render/carMesh';
import type { SimEvent } from '../sim/types';

/**
 * M10: 'practice' is a beginner-friendly, pressure-free mode — the same
 * "unlimited, no winner" semantics as 'timetrial' (see createRace below), but
 * a distinct value so UI/config can branch on it (default assists, an
 * optional AI pace companion instead of a fixed opponent, a different HUD
 * header). Only 'race' can ever produce a winner/'finished' phase.
 */
export type RaceMode = 'practice' | 'timetrial' | 'race';
export type RacePhase = 'idle' | 'countdown' | 'racing' | 'finished';
export type TrackId = 'oval' | 'figure8' | 'daytonaSweep';
/** Practice-only: an optional AI car circulating alongside the player, purely as company — never a win condition. Ignored outside practice. */
export type PracticeCompanion = 'alone' | 'ai';

/** The two sim car indices a race uses. Player is always car 0; the AI (race mode, or a practice companion) is car 1. */
export const PLAYER_CAR_INDEX = 0;
export const AI_CAR_INDEX = 1;
/** Countdown length in whole-second beats: "3", "2", "1", then "GO". */
export const COUNTDOWN_BEATS = 3;

export interface RaceConfig {
  mode: RaceMode;
  lapsToWin: number;
  playerLane: 0 | 1;
  aiDifficulty: number;
  trackId: TrackId;
  playerCar: CarStyleId;
  /** Practice-only choice of whether an AI pace companion joins — outside practice this field is ignored; raceHasAiCar() below is the sole source of truth for whether a session actually has one ('race' always does, 'timetrial' never does). */
  practiceCompanion: PracticeCompanion;
  /** M10: beginner grip assist multiplier, shared by every car in the session — see config/tuning.ts's STICKINESS_LEVELS. */
  stickiness: StickinessId;
  /** M10: whether the real-time throttle coach HUD widget is shown this session (player's own lane only). */
  coach: boolean;
}

/**
 * Whether this config's session has a second, AI-driven car: always for
 * 'race', never for 'timetrial', and for 'practice' only when the player
 * picked an AI companion. The single source of truth for "how many cars"
 * shared by createRace (below), main.ts's session build, and ui/menus.ts's
 * Difficulty-row visibility — so the three can never disagree.
 */
export function raceHasAiCar(config: Pick<RaceConfig, 'mode' | 'practiceCompanion'>): boolean {
  return config.mode === 'race' || (config.mode === 'practice' && config.practiceCompanion === 'ai');
}

export interface AssistDefaults {
  stickiness: StickinessId;
  coach: boolean;
  practiceCompanion: PracticeCompanion;
}

/**
 * Per-mode default assists, applied by the menu whenever the player switches
 * the Mode row (freely overridable afterward via the Stickiness/Coach/Company
 * rows themselves): Practice defaults to the most forgiving learning setup
 * (Sticky grip, coach on, no AI company — the beginner path); Time Trial
 * defaults to the purist setup (Authentic grip, coach off); Race vs AI
 * defaults to Off/Authentic — a fair, unassisted contest against an AI that
 * shares the exact same cfg.
 */
export function defaultAssistsForMode(mode: RaceMode): AssistDefaults {
  if (mode === 'practice') return { stickiness: 'sticky', coach: true, practiceCompanion: 'alone' };
  return { stickiness: 'authentic', coach: false, practiceCompanion: 'alone' };
}

/** One countdown tick — a beep + the number to flash. `final` is the GO tone. */
export interface CountdownEvent {
  number: number; // 3, 2, 1, or 0 (GO)
  final: boolean;
}

export interface RaceResultEntry {
  carIndex: number;
  isPlayer: boolean;
  laps: number;
}

export interface RaceResults {
  /** The car that reached lapsToWin, or null in time trial (no winner). */
  winnerCarIndex: number | null;
  /** Finish order, winner first. */
  order: RaceResultEntry[];
  playerBestLapSec: number | null;
  playerLastLapSec: number | null;
}

export interface RaceMachine {
  readonly config: RaceConfig;
  phase(): RacePhase;
  /** The number to flash while counting down (3→1), 0 once racing/GO. */
  countdownNumber(): number;
  laps(carIndex: number): number;
  /** Populated only once phase is 'finished' (race mode); null otherwise. */
  results(): RaceResults | null;
  playerBestLapSec(): number | null;
  playerLastLapSec(): number | null;
  /** idle → countdown. */
  start(): void;
  /** Advance the countdown by dt; returns any beep(s) crossed this tick. */
  tick(dt: number): CountdownEvent[];
  /** Feed a sim event (only lap events, only while racing, are acted on). */
  handleSimEvent(event: SimEvent): void;
  /** Esc: abandon the race and return to idle. */
  abort(): void;
}

export function createRace(config: RaceConfig): RaceMachine {
  const carIndices = raceHasAiCar(config) ? [PLAYER_CAR_INDEX, AI_CAR_INDEX] : [PLAYER_CAR_INDEX];

  let phase: RacePhase = 'idle';
  let countdownElapsed = 0;
  let lastBeatNumber = -1;
  const lapCounts = new Map<number, number>(carIndices.map((i) => [i, 0]));
  let playerBest: number | null = null;
  let playerLast: number | null = null;
  let winnerCarIndex: number | null = null;

  function countdownNumber(): number {
    if (phase !== 'countdown') return 0;
    return Math.max(0, COUNTDOWN_BEATS - Math.floor(countdownElapsed));
  }

  function buildResults(): RaceResults {
    const order: RaceResultEntry[] = carIndices
      .map((carIndex) => ({
        carIndex,
        isPlayer: carIndex === PLAYER_CAR_INDEX,
        laps: lapCounts.get(carIndex) ?? 0,
      }))
      // Winner first, then by laps completed. A car reaching lapsToWin is
      // pinned to the front (it crossed the line first even if a tie in count).
      .sort((a, b) => {
        if (a.carIndex === winnerCarIndex) return -1;
        if (b.carIndex === winnerCarIndex) return 1;
        return b.laps - a.laps;
      });
    return { winnerCarIndex, order, playerBestLapSec: playerBest, playerLastLapSec: playerLast };
  }

  function start(): void {
    phase = 'countdown';
    countdownElapsed = 0;
    lastBeatNumber = -1;
  }

  function tick(dt: number): CountdownEvent[] {
    if (phase !== 'countdown') return [];
    const events: CountdownEvent[] = [];
    countdownElapsed += dt;

    // Emit a beep each time the displayed number changes: 3 (at 0s), 2, 1, then
    // 0 = GO at COUNTDOWN_BEATS seconds, which also starts the race.
    const number =
      countdownElapsed >= COUNTDOWN_BEATS ? 0 : COUNTDOWN_BEATS - Math.floor(countdownElapsed);
    if (number !== lastBeatNumber) {
      lastBeatNumber = number;
      events.push({ number, final: number === 0 });
      if (number === 0) phase = 'racing';
    }
    return events;
  }

  function handleSimEvent(event: SimEvent): void {
    if (phase !== 'racing' || event.type !== 'lap') return;
    if (!lapCounts.has(event.carIndex)) return; // not a competitor in this race

    const laps = (lapCounts.get(event.carIndex) ?? 0) + 1;
    lapCounts.set(event.carIndex, laps);

    if (event.carIndex === PLAYER_CAR_INDEX) {
      playerLast = event.lapTimeSec;
      if (playerBest === null || event.lapTimeSec < playerBest) playerBest = event.lapTimeSec;
    }

    // Time trial is unlimited; only a real race can be won.
    if (config.mode === 'race' && laps >= config.lapsToWin) {
      winnerCarIndex = event.carIndex;
      phase = 'finished';
    }
  }

  function abort(): void {
    phase = 'idle';
  }

  return {
    config,
    phase: () => phase,
    countdownNumber,
    laps: (carIndex) => lapCounts.get(carIndex) ?? 0,
    results: () => (phase === 'finished' ? buildResults() : null),
    playerBestLapSec: () => playerBest,
    playerLastLapSec: () => playerLast,
    start,
    tick,
    handleSimEvent,
    abort,
  };
}
