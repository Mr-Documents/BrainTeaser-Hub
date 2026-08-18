'use strict';

const { parsePuzzle, toPublicPuzzle } = require('../domain/puzzleSchema');
const { pickRandomPuzzle, pickDailyPuzzle, dayKey } = require('../domain/puzzlePicker');
const { NotFoundError } = require('../lib/errors');

/**
 * Everything the app does *to* puzzles: browsing, admin CRUD, and choosing which one to serve.
 * Holds no HTTP concepts, so it is exercised directly in unit tests.
 */
function createPuzzleService({ repository }) {
  /** Small cache so serving a random puzzle is not a full table scan on every request. */
  const cache = { rows: null, expiresAt: 0 };
  const CACHE_TTL_MS = 15_000;

  async function publishedPuzzles({ force = false } = {}) {
    if (!force && cache.rows && cache.expiresAt > Date.now()) return cache.rows;
    const { puzzles } = await repository.listPuzzles({ includeUnpublished: false });
    cache.rows = puzzles;
    cache.expiresAt = Date.now() + CACHE_TTL_MS;
    return puzzles;
  }

  const invalidate = () => {
    cache.rows = null;
    cache.expiresAt = 0;
  };

  return {
    invalidate,

    /** Admin listing — includes drafts and full answer/hint text. */
    async list(options = {}) {
      return repository.listPuzzles({ includeUnpublished: true, ...options });
    },

    /** Player-facing catalogue — published only, answers stripped. */
    async listPublic(options = {}) {
      const { puzzles, total } = await repository.listPuzzles({ includeUnpublished: false, ...options });
      return { puzzles: puzzles.map(toPublicPuzzle), total };
    },

    async getById(id, { includeUnpublished = false } = {}) {
      const puzzle = await repository.getPuzzle(id);
      if (!puzzle) throw new NotFoundError(`No puzzle with id "${id}"`);
      if (!includeUnpublished && puzzle.isPublished === false) {
        throw new NotFoundError(`No puzzle with id "${id}"`);
      }
      return puzzle;
    },

    /**
     * @returns {Promise<object|null>} null when the filters match nothing, or the player has
     * already seen every match this session.
     */
    async pickRandom({ type, difficulty, exclude = [], tag } = {}) {
      const puzzles = await publishedPuzzles();
      return pickRandomPuzzle(puzzles, { type, difficulty, exclude, tag });
    },

    /** The same puzzle for everyone, all UTC day. */
    async pickDaily(date = new Date()) {
      const puzzles = await publishedPuzzles();
      const puzzle = pickDailyPuzzle(puzzles, date);
      return puzzle ? { puzzle, dayKey: dayKey(date) } : null;
    },

    async create(payload) {
      const puzzle = parsePuzzle(payload);
      const created = await repository.createPuzzle(puzzle);
      invalidate();
      return created;
    },

    async update(id, payload) {
      const existing = await repository.getPuzzle(id);
      if (!existing) throw new NotFoundError(`No puzzle with id "${id}"`);
      // Merge so a partial form submit cannot silently blank fields it did not include.
      const puzzle = parsePuzzle({ ...existing, ...payload, id: payload.id || id });
      const updated = await repository.updatePuzzle(id, puzzle);
      invalidate();
      return updated;
    },

    async remove(id) {
      await repository.deletePuzzle(id);
      invalidate();
      return { deleted: id };
    },

    async importMany(puzzles) {
      const parsed = puzzles.map((p) => parsePuzzle(p));
      const result = await repository.upsertPuzzles(parsed);
      invalidate();
      return result;
    },

    /** Counts per type and difficulty, for the admin dashboard tiles. */
    async catalogueSummary() {
      const { puzzles } = await repository.listPuzzles({ includeUnpublished: true });
      const summary = { total: puzzles.length, published: 0, drafts: 0, byType: {}, byDifficulty: {}, withHints: 0 };
      for (const p of puzzles) {
        if (p.isPublished === false) summary.drafts += 1;
        else summary.published += 1;
        summary.byType[p.type] = (summary.byType[p.type] || 0) + 1;
        summary.byDifficulty[p.difficulty] = (summary.byDifficulty[p.difficulty] || 0) + 1;
        if ((p.hints || []).length > 0) summary.withHints += 1;
      }
      return summary;
    },
  };
}

module.exports = { createPuzzleService };
