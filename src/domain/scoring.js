'use strict';

/** Points removed for every hint the player reveals. */
const PENALTY_PER_HINT = 15;
/** Points removed for every wrong submission before the correct one. */
const PENALTY_PER_WRONG = 10;
/** A solve faster than this (ms) earns the full speed bonus, tapering to zero at SPEED_BONUS_CUTOFF_MS. */
const SPEED_BONUS_WINDOW_MS = 20_000;
const SPEED_BONUS_CUTOFF_MS = 120_000;
/** Maximum bonus, as a fraction of base points, for a very fast solve. */
const SPEED_BONUS_MAX_RATIO = 0.25;
/** Multiplier applied per consecutive solve, capped at STREAK_MAX_MULTIPLIER. */
const STREAK_BONUS_PER_SOLVE = 0.05;
const STREAK_MAX_MULTIPLIER = 1.5;

const clampNonNegative = (n) => Math.max(0, Number(n) || 0);

/**
 * Bonus for solving quickly: full ratio inside the window, linear taper to 0 at the cutoff.
 * @param {number} basePoints
 * @param {number|null|undefined} durationMs time between receiving the puzzle and solving it
 */
function computeSpeedBonus(basePoints, durationMs) {
  const base = clampNonNegative(basePoints);
  if (durationMs === null || durationMs === undefined) return 0;
  const ms = Number(durationMs);
  if (!Number.isFinite(ms) || ms < 0 || ms >= SPEED_BONUS_CUTOFF_MS) return 0;
  const maxBonus = base * SPEED_BONUS_MAX_RATIO;
  if (ms <= SPEED_BONUS_WINDOW_MS) return Math.round(maxBonus);
  const remaining = SPEED_BONUS_CUTOFF_MS - ms;
  const span = SPEED_BONUS_CUTOFF_MS - SPEED_BONUS_WINDOW_MS;
  return Math.round(maxBonus * (remaining / span));
}

/**
 * Streak multiplier. A streak of 0 or 1 is neutral (1.0); each further solve adds 5%, capped at 1.5x.
 * @param {number} streak number of consecutive solves *including* the current one
 */
function computeStreakMultiplier(streak) {
  const s = clampNonNegative(streak);
  if (s <= 1) return 1;
  return Math.min(STREAK_MAX_MULTIPLIER, 1 + (s - 1) * STREAK_BONUS_PER_SOLVE);
}

/**
 * The single source of truth for what a solve is worth.
 *
 * base - hint penalties - wrong penalties, floored at 0, then speed bonus, then streak multiplier.
 * Penalties are applied before bonuses so a heavily hinted solve can never out-earn a clean one.
 *
 * @param {object} input
 * @param {number} input.basePoints
 * @param {number} [input.hintsRevealed]
 * @param {number} [input.wrongSubmissions]
 * @param {number|null} [input.durationMs]
 * @param {number} [input.streak]
 * @returns {{ total: number, base: number, hintPenalty: number, wrongPenalty: number, speedBonus: number, streakMultiplier: number }}
 */
function computeScore({ basePoints, hintsRevealed = 0, wrongSubmissions = 0, durationMs = null, streak = 0 }) {
  const base = clampNonNegative(basePoints);
  const hintPenalty = clampNonNegative(hintsRevealed) * PENALTY_PER_HINT;
  const wrongPenalty = clampNonNegative(wrongSubmissions) * PENALTY_PER_WRONG;
  const afterPenalties = Math.max(0, base - hintPenalty - wrongPenalty);

  // No penalty-free points left means no bonuses either - bonuses scale a real score, not a zero.
  const speedBonus = afterPenalties > 0 ? computeSpeedBonus(base, durationMs) : 0;
  const streakMultiplier = afterPenalties > 0 ? computeStreakMultiplier(streak) : 1;

  return {
    total: Math.max(0, Math.round((afterPenalties + speedBonus) * streakMultiplier)),
    base,
    hintPenalty,
    wrongPenalty,
    speedBonus,
    streakMultiplier: Number(streakMultiplier.toFixed(2)),
  };
}

/** Back-compat shorthand used by the simple scoring path and by tests. */
function computePointsEarned(basePoints, hintsRevealed, wrongSubmissions) {
  return computeScore({ basePoints, hintsRevealed, wrongSubmissions }).total;
}

module.exports = {
  computeScore,
  computePointsEarned,
  computeSpeedBonus,
  computeStreakMultiplier,
  PENALTY_PER_HINT,
  PENALTY_PER_WRONG,
  SPEED_BONUS_MAX_RATIO,
  STREAK_MAX_MULTIPLIER,
};
