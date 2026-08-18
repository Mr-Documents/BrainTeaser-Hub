'use strict';

const { matchAnswer } = require('../domain/answerMatcher');
const { computeScore } = require('../domain/scoring');
const { nextStreak } = require('../domain/streak');
const { toPublicPuzzle } = require('../domain/puzzleSchema');
const { BadRequestError, NotFoundError } = require('../lib/errors');

const MAX_USERNAME_LENGTH = 32;

/** Trim, cap and default a display name. Never returns an empty string. */
function normalizeUsername(input) {
  const name = String(input ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_USERNAME_LENGTH);
  return name || 'Anonymous';
}

/**
 * The rules of play: hand out a puzzle with an attempt token, drip hints, grade submissions,
 * and award points. Anything that could be cheated by editing the page lives here, server-side.
 */
function createGameService({ repository, puzzleService, attemptStore, logger = console }) {
  /** Serve a puzzle and open a scored attempt for it. */
  function startAttempt(puzzle) {
    const attemptToken = attemptStore.create(puzzle.id);
    return { puzzle: toPublicPuzzle(puzzle), attemptToken, startedAt: new Date().toISOString() };
  }

  return {
    async startRandom(filters = {}) {
      const puzzle = await puzzleService.pickRandom(filters);
      if (!puzzle) return null;
      return startAttempt(puzzle);
    },

    async startById(id) {
      const puzzle = await puzzleService.getById(id);
      return startAttempt(puzzle);
    },

    async startDaily(date = new Date()) {
      const daily = await puzzleService.pickDaily(date);
      if (!daily) return null;
      return { ...startAttempt(daily.puzzle), dayKey: daily.dayKey, isDaily: true };
    },

    /**
     * Reveal the next hint. Each reveal is recorded against the attempt and costs points at solve time.
     * @throws {BadRequestError} on a stale/foreign token or when hints are exhausted.
     */
    async revealHint({ puzzleId, attemptToken }) {
      const puzzle = await puzzleService.getById(puzzleId);
      const hints = puzzle.hints || [];
      if (hints.length === 0) throw new BadRequestError('This puzzle has no hints');

      const hint = attemptStore.takeNextHint(attemptToken, puzzleId, hints);
      if (!hint) {
        const attempt = attemptStore.get(attemptToken, puzzleId);
        if (!attempt) throw new BadRequestError('Your session for this puzzle expired — load it again');
        throw new BadRequestError('No hints left for this puzzle');
      }
      return { hint: hint.text, step: hint.step, total: hint.total, remaining: hint.total - hint.step };
    },

    /**
     * Grade an answer, and on a correct first solve award points and update the leaderboard.
     * @returns {Promise<object>} always resolves; `correct` says how it went.
     */
    async submitAnswer({ puzzleId, answer, username, attemptToken }) {
      if (!puzzleId) throw new BadRequestError('puzzleId is required');
      if (answer === undefined || answer === null) throw new BadRequestError('answer is required');

      const puzzle = await puzzleService.getById(puzzleId).catch(() => null);
      if (!puzzle) throw new NotFoundError(`No puzzle with id "${puzzleId}"`);

      const attempt = attemptStore.get(attemptToken, puzzleId);
      if (!attempt) {
        throw new BadRequestError('Your session for this puzzle expired — load the puzzle again');
      }

      const player = normalizeUsername(username);
      const { correct } = matchAnswer(String(answer), puzzle);

      if (!correct) {
        const wrongSubmissions = attemptStore.recordWrong(attemptToken, puzzleId);
        await repository.recordAttempt({ correct: false, puzzle, username: player });
        return {
          correct: false,
          message: encourage(wrongSubmissions),
          hintsRevealed: attemptStore.hintsRevealed(attemptToken, puzzleId),
          wrongSubmissions,
          hintsAvailable: (puzzle.hints || []).length,
        };
      }

      const { alreadySolved, durationMs } = attemptStore.markSolved(attemptToken, puzzleId);
      const hintsRevealed = attemptStore.hintsRevealed(attemptToken, puzzleId);
      const wrongSubmissions = attemptStore.wrongCount(attemptToken, puzzleId);

      if (alreadySolved) {
        return {
          correct: true,
          alreadySolved: true,
          pointsEarned: 0,
          hintsRevealed,
          wrongSubmissions,
          explanation: puzzle.explanation || null,
          message: 'You already solved this one — load a new puzzle to score again.',
        };
      }

      const existingPlayer = await repository.getPlayer(player);
      const streak = nextStreak(existingPlayer);
      const score = computeScore({
        basePoints: puzzle.basePoints,
        hintsRevealed,
        wrongSubmissions,
        durationMs,
        streak,
      });

      const [savedPlayer] = await Promise.all([
        repository.recordSolve({ username: player, pointsEarned: score.total, streak }),
        repository
          .recordAttempt({
            correct: true,
            puzzle,
            pointsEarned: score.total,
            username: player,
            hintsUsed: hintsRevealed,
            wrongAttempts: wrongSubmissions,
            durationMs,
          })
          .catch((err) => logger.warn?.('failed to record attempt stats', { error: err.message })),
      ]);

      const [leaderboard, stats] = await Promise.all([repository.getLeaderboard(10), repository.getStats()]);

      return {
        correct: true,
        alreadySolved: false,
        pointsEarned: score.total,
        breakdown: score,
        hintsRevealed,
        wrongSubmissions,
        durationMs,
        streak,
        player: savedPlayer,
        explanation: puzzle.explanation || null,
        message: buildSolveMessage(score, streak),
        leaderboard,
        stats,
      };
    },

    normalizeUsername,
  };
}

function encourage(wrongSubmissions) {
  if (wrongSubmissions === 1) return 'Not quite — have another go.';
  if (wrongSubmissions === 2) return 'Still not it. Try a hint?';
  if (wrongSubmissions >= 5) return 'Close one? A hint costs 15 points and might unstick you.';
  return 'Nope — think it through once more.';
}

function buildSolveMessage(score, streak) {
  if (score.total === 0) return 'Correct — but hints and wrong guesses left this one at 0 points.';
  const parts = [`Correct! +${score.total} points`];
  if (score.speedBonus > 0) parts.push(`${score.speedBonus} speed bonus`);
  if (streak > 1) parts.push(`${streak}-day streak (x${score.streakMultiplier})`);
  return parts.join(' · ');
}

module.exports = { createGameService, normalizeUsername };
