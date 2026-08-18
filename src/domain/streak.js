'use strict';

const DAY_MS = 24 * 60 * 60 * 1000;

const utcDayNumber = (value) => Math.floor(new Date(value).getTime() / DAY_MS);

/**
 * Daily streak: solving again on the same UTC day holds the streak, the next day extends it,
 * and any longer gap starts over at 1.
 *
 * @param {{ currentStreak?: number, lastSolvedAt?: string|null }|null} player
 * @param {Date|string} [now]
 * @returns {number} the streak value after this solve (always >= 1)
 */
function nextStreak(player, now = new Date()) {
  const current = Math.max(0, Number(player?.currentStreak) || 0);
  const last = player?.lastSolvedAt;
  if (!last || current === 0) return 1;

  const lastDay = utcDayNumber(last);
  const today = utcDayNumber(now);
  if (Number.isNaN(lastDay)) return 1;

  const gap = today - lastDay;
  if (gap <= 0) return Math.max(1, current); // already solved today — hold
  if (gap === 1) return current + 1; // solved yesterday — extend
  return 1; // missed a day — restart
}

/** True when the streak shown to a returning player has already lapsed. */
function isStreakStale(player, now = new Date()) {
  if (!player?.lastSolvedAt) return false;
  return utcDayNumber(now) - utcDayNumber(player.lastSolvedAt) > 1;
}

module.exports = { nextStreak, isStreakStale, utcDayNumber, DAY_MS };
