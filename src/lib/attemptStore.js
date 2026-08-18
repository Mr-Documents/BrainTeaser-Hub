'use strict';

const crypto = require('crypto');

/**
 * Server-side play sessions.
 *
 * The client never receives the answers or the hint texts up front, so hint counts, wrong-guess
 * counts and solve timing cannot be forged by editing the page - they only exist here, keyed by
 * an opaque token the server hands out with each puzzle.
 *
 * In-memory by design for the MVP (single instance). Swap this module for a Redis-backed one with
 * the same surface to run more than one process.
 */
function createAttemptStore({ ttlMs = 4 * 60 * 60 * 1000, maxEntries = 20000, now = () => Date.now() } = {}) {
  /** @type {Map<string, {puzzleId: string, hintStep: number, wrongSubmissions: number, solved: boolean, startedAt: number, createdAt: number}>} */
  const attempts = new Map();

  function prune() {
    const cutoff = now() - ttlMs;
    for (const [token, meta] of attempts) {
      if (meta.createdAt < cutoff) attempts.delete(token);
    }
    // Map preserves insertion order, so the oldest tokens are evicted first.
    while (attempts.size > maxEntries) {
      const oldest = attempts.keys().next().value;
      if (oldest === undefined) break;
      attempts.delete(oldest);
    }
  }

  function get(token, puzzleId) {
    if (!token) return null;
    const attempt = attempts.get(token);
    if (!attempt) return null;
    if (attempt.createdAt < now() - ttlMs) {
      attempts.delete(token);
      return null;
    }
    if (puzzleId !== undefined && attempt.puzzleId !== puzzleId) return null;
    return attempt;
  }

  return {
    /** Issue a token for a freshly served puzzle and start its clock. */
    create(puzzleId) {
      prune();
      const token = crypto.randomUUID();
      const timestamp = now();
      attempts.set(token, {
        puzzleId,
        hintStep: 0,
        wrongSubmissions: 0,
        solved: false,
        startedAt: timestamp,
        createdAt: timestamp,
      });
      return token;
    },

    get,

    /**
     * Reveal the next hint for this attempt.
     * @returns {{ text: string, step: number, total: number }|null} null when the token is
     * invalid or every hint has already been shown.
     */
    takeNextHint(token, puzzleId, hints) {
      const attempt = get(token, puzzleId);
      if (!attempt || !Array.isArray(hints) || hints.length === 0) return null;
      if (attempt.hintStep >= hints.length) return null;
      const text = hints[attempt.hintStep];
      attempt.hintStep += 1;
      return { text, step: attempt.hintStep, total: hints.length };
    },

    hintsRevealed(token, puzzleId) {
      return get(token, puzzleId)?.hintStep ?? 0;
    },

    wrongCount(token, puzzleId) {
      return get(token, puzzleId)?.wrongSubmissions ?? 0;
    },

    recordWrong(token, puzzleId) {
      const attempt = get(token, puzzleId);
      if (!attempt || attempt.solved) return 0;
      attempt.wrongSubmissions += 1;
      return attempt.wrongSubmissions;
    },

    /** @returns {{ alreadySolved: boolean, durationMs: number|null }} */
    markSolved(token, puzzleId) {
      const attempt = get(token, puzzleId);
      if (!attempt) return { alreadySolved: false, durationMs: null };
      if (attempt.solved) return { alreadySolved: true, durationMs: null };
      attempt.solved = true;
      return { alreadySolved: false, durationMs: now() - attempt.startedAt };
    },

    size: () => attempts.size,
    clear: () => attempts.clear(),
  };
}

module.exports = { createAttemptStore };
