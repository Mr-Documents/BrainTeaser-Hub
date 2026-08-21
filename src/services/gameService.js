'use strict';

const { matchAnswer } = require('../domain/answerMatcher');
const { computeScore } = require('../domain/scoring');
const { nextStreak } = require('../domain/streak');
const { toPublicPuzzle } = require('../domain/puzzleSchema');
const { AttemptExpiredError, BadRequestError, NotFoundError } = require('../lib/errors');

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
        if (!attempt) throw new AttemptExpiredError();
        throw new BadRequestError('No hints left for this puzzle');
      }
      return { hint: hint.text, step: hint.step, total: hint.total, remaining: hint.total - hint.step };
    },

    /**
     * Grade an answer, and on a correct first solve award points and update the leaderboard.
     * @returns {Promise<object>} always resolves; `correct` says how it went.
     */
    async submitAnswer({ puzzleId, answer, attemptToken, player = null }) {
      if (!puzzleId) throw new BadRequestError('puzzleId is required');
      if (answer === undefined || answer === null) throw new BadRequestError('answer is required');

      const puzzle = await puzzleService.getById(puzzleId).catch(() => null);
      if (!puzzle) throw new NotFoundError(`No puzzle with id "${puzzleId}"`);

      const attempt = attemptStore.get(attemptToken, puzzleId);
      if (!attempt) {
        throw new AttemptExpiredError();
      }

      // `player` is the session's account or null. A name can no longer be claimed in the body,
      // so a score always belongs to whoever actually signed in.
      const userId = player?.userId || null;
      const { correct } = matchAnswer(String(answer), puzzle);

      if (!correct) {
        const wrongSubmissions = attemptStore.recordWrong(attemptToken, puzzleId);
        await repository.recordAttempt({ correct: false, puzzle, userId });
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
          message: 'You already solved this one - load a new puzzle to score again.',
        };
      }

      // A streak only means something when it belongs to an account; an anonymous solve is
      // always treated as a first solve so it cannot inflate anybody's multiplier.
      const streak = player ? nextStreak(player) : 0;
      const score = computeScore({
        basePoints: puzzle.basePoints,
        hintsRevealed,
        wrongSubmissions,
        durationMs,
        streak,
      });

      const recordAttempt = repository
        .recordAttempt({
          correct: true,
          puzzle,
          pointsEarned: score.total,
          userId,
          hintsUsed: hintsRevealed,
          wrongAttempts: wrongSubmissions,
          durationMs,
        })
        .catch((err) => logger.warn?.('failed to record attempt stats', { error: err.message }));

      // Only a signed-in solve is banked to a profile and the leaderboard. Anonymous players
      // still get their points back for the session tally, and still move the global stats.
      const savedPlayer = player
        ? await repository.recordSolve({
            userId: player.userId,
            displayName: player.displayName,
            pointsEarned: score.total,
            streak,
          })
        : null;
      await recordAttempt;

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
        ranked: Boolean(savedPlayer),
        explanation: puzzle.explanation || null,
        message: buildSolveMessage(score, streak, Boolean(player)),
        leaderboard,
        stats,
      };
    },

    normalizeUsername,
  };
}

function encourage(wrongSubmissions) {
  if (wrongSubmissions === 1) return 'Not quite - have another go.';
  if (wrongSubmissions === 2) return 'Still not it. Try a hint?';
  if (wrongSubmissions >= 5) return 'Close one? A hint costs 15 points and might unstick you.';
  return 'Nope - think it through once more.';
}

function buildSolveMessage(score, streak, isRanked) {
  if (score.total === 0) return 'Correct - but hints and wrong guesses left this one at 0 points.';
  const parts = [`Correct! +${score.total} points`];
  if (score.speedBonus > 0) parts.push(`${score.speedBonus} speed bonus`);
  if (streak > 1) parts.push(`${streak}-day streak (x${score.streakMultiplier})`);
  if (!isRanked) parts.push('sign in to keep it');
  return parts.join(' · ');
}

module.exports = { createGameService, normalizeUsername };
