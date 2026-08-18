'use strict';

const { PUZZLE_TYPES, DIFFICULTIES } = require('../domain/constants');

const emptyStats = () => ({
  totalSolves: 0,
  totalAttempts: 0,
  totalPoints: 0,
  completionsByType: Object.fromEntries(PUZZLE_TYPES.map((t) => [t, 0])),
  completionsByDifficulty: Object.fromEntries(DIFFICULTIES.map((d) => [d, 0])),
  correctVsWrong: { correct: 0, wrong: 0 },
  players: 0,
  puzzles: 0,
});

/**
 * Read models for the leaderboard and the charts.
 *
 * Stats are short-cached: they are read on every page load but only change on a solve, and a
 * few seconds of staleness in a chart is invisible while the saved round trips are not.
 */
function createStatsService({ repository, cacheTtlMs = 5_000, logger = console }) {
  const cache = { stats: null, expiresAt: 0 };

  return {
    async getStats({ fresh = false } = {}) {
      if (!fresh && cache.stats && cache.expiresAt > Date.now()) return cache.stats;
      try {
        const stats = { ...emptyStats(), ...(await repository.getStats()) };
        cache.stats = stats;
        cache.expiresAt = Date.now() + cacheTtlMs;
        return stats;
      } catch (err) {
        logger.warn?.('stats unavailable, serving zeros', { error: err.message });
        return cache.stats || emptyStats();
      }
    },

    invalidate() {
      cache.stats = null;
      cache.expiresAt = 0;
    },

    async getLeaderboard(limit = 10) {
      const bounded = Math.min(100, Math.max(1, Number(limit) || 10));
      try {
        const entries = await repository.getLeaderboard(bounded);
        return entries.map((entry, index) => ({ rank: index + 1, ...entry }));
      } catch (err) {
        logger.warn?.('leaderboard unavailable', { error: err.message });
        return [];
      }
    },

    /** The profile card: rank plus totals for one display name. */
    async getPlayerProfile(username) {
      const player = await repository.getPlayer(username);
      if (!player) return null;
      const top = await repository.getLeaderboard(100);
      const index = top.findIndex((p) => p.username === username);
      return { ...player, rank: index === -1 ? null : index + 1 };
    },
  };
}

module.exports = { createStatsService, emptyStats };
