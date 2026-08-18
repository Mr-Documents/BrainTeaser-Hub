'use strict';

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const { ConflictError, NotFoundError } = require('../lib/errors');
const { PUZZLE_TYPES, DIFFICULTIES } = require('../domain/constants');

/**
 * File-backed implementation of the repository contract.
 *
 * It is the zero-setup driver: a fresh clone runs against data/*.json with no Supabase project.
 * Pass `{ persist: false }` for the in-memory driver used by tests.
 *
 * Writes are serialised through a promise chain and land via write-to-temp-then-rename, so a
 * crash mid-write cannot leave a truncated JSON file behind.
 */
function createJsonRepository({ dataDir, persist = true, seed = null } = {}) {
  const files = {
    puzzles: path.join(dataDir || '.', 'puzzles.json'),
    players: path.join(dataDir || '.', 'players.json'),
    attempts: path.join(dataDir || '.', 'attempts.json'),
  };

  const state = {
    puzzles: [],
    players: [],
    attemptTotals: emptyTotals(),
  };

  let writeChain = Promise.resolve();

  function emptyTotals() {
    return {
      totalSolves: 0,
      totalAttempts: 0,
      correct: 0,
      wrong: 0,
      totalPoints: 0,
      byType: Object.fromEntries(PUZZLE_TYPES.map((t) => [t, 0])),
      byDifficulty: Object.fromEntries(DIFFICULTIES.map((d) => [d, 0])),
    };
  }

  function readJsonSync(file, fallback) {
    try {
      return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      return fallback;
    }
  }

  function queueWrite(file, data) {
    if (!persist) return writeChain;
    writeChain = writeChain.then(async () => {
      const tmp = `${file}.${process.pid}.tmp`;
      await fsp.mkdir(path.dirname(file), { recursive: true });
      await fsp.writeFile(tmp, JSON.stringify(data, null, 2), 'utf8');
      await fsp.rename(tmp, file);
    });
    return writeChain.catch(() => {
      /* surfaced by flush(); a failed persist must not crash a request */
    });
  }

  function load() {
    if (seed) {
      state.puzzles = (seed.puzzles || []).map(normalizeStored);
      state.players = seed.players || [];
      state.attemptTotals = { ...emptyTotals(), ...(seed.totals || {}) };
      return;
    }
    if (!persist) return;
    const puzzleFile = readJsonSync(files.puzzles, { puzzles: [] });
    state.puzzles = (Array.isArray(puzzleFile) ? puzzleFile : puzzleFile.puzzles || []).map(normalizeStored);
    const playerFile = readJsonSync(files.players, { players: [] });
    state.players = Array.isArray(playerFile) ? playerFile : playerFile.players || playerFile.entries || [];
    const attemptFile = readJsonSync(files.attempts, null);
    state.attemptTotals = attemptFile ? { ...emptyTotals(), ...attemptFile } : emptyTotals();
  }

  /** Tolerate rows written by older versions (snake_case, missing fields). */
  function normalizeStored(p) {
    return {
      id: p.id,
      question: p.question || '',
      type: p.type || 'logic',
      difficulty: p.difficulty || 'medium',
      answers: Array.isArray(p.answers) ? p.answers : [],
      matchMode: p.matchMode || p.match_mode || 'exact',
      hints: Array.isArray(p.hints) ? p.hints : [],
      explanation: p.explanation ?? null,
      basePoints: Number(p.basePoints ?? p.base_points ?? 100),
      isPublished: p.isPublished ?? p.is_published ?? true,
      tags: Array.isArray(p.tags) ? p.tags : [],
      createdAt: p.createdAt || p.created_at || null,
      updatedAt: p.updatedAt || p.updated_at || null,
    };
  }

  load();

  const savePuzzles = () => queueWrite(files.puzzles, { puzzles: state.puzzles });
  const savePlayers = () => queueWrite(files.players, { players: state.players });
  const saveAttempts = () => queueWrite(files.attempts, state.attemptTotals);

  const clone = (v) => (v == null ? v : JSON.parse(JSON.stringify(v)));

  return {
    driver: persist ? 'json' : 'memory',

    async healthCheck() {
      return { ok: true, driver: persist ? 'json' : 'memory', puzzles: state.puzzles.length };
    },

    /** Waits for every queued write to land. Call before asserting on files, or on shutdown. */
    async flush() {
      await writeChain;
    },

    // ---------------------------------------------------------------- puzzles

    async listPuzzles({
      includeUnpublished = false,
      search = '',
      type = '',
      difficulty = '',
      limit = 0,
      offset = 0,
    } = {}) {
      const needle = String(search || '')
        .trim()
        .toLowerCase();
      let rows = state.puzzles.filter((p) => {
        if (!includeUnpublished && p.isPublished === false) return false;
        if (type && p.type !== type) return false;
        if (difficulty && p.difficulty !== difficulty) return false;
        if (needle) {
          const haystack = `${p.id} ${p.question} ${(p.tags || []).join(' ')}`.toLowerCase();
          if (!haystack.includes(needle)) return false;
        }
        return true;
      });
      rows = rows.sort((a, b) => String(a.id).localeCompare(String(b.id)));
      const total = rows.length;
      if (offset) rows = rows.slice(offset);
      if (limit) rows = rows.slice(0, limit);
      return { puzzles: clone(rows), total };
    },

    async getPuzzle(id) {
      return clone(state.puzzles.find((p) => p.id === id) || null);
    },

    async createPuzzle(puzzle) {
      if (state.puzzles.some((p) => p.id === puzzle.id)) {
        throw new ConflictError(`A puzzle with id "${puzzle.id}" already exists`);
      }
      const now = new Date().toISOString();
      const row = { ...puzzle, createdAt: now, updatedAt: now };
      state.puzzles.push(row);
      savePuzzles();
      return clone(row);
    },

    async updatePuzzle(id, puzzle) {
      const index = state.puzzles.findIndex((p) => p.id === id);
      if (index === -1) throw new NotFoundError(`No puzzle with id "${id}"`);
      if (puzzle.id !== id && state.puzzles.some((p) => p.id === puzzle.id)) {
        throw new ConflictError(`A puzzle with id "${puzzle.id}" already exists`);
      }
      const row = { ...puzzle, createdAt: state.puzzles[index].createdAt, updatedAt: new Date().toISOString() };
      state.puzzles[index] = row;
      savePuzzles();
      return clone(row);
    },

    async deletePuzzle(id) {
      const before = state.puzzles.length;
      state.puzzles = state.puzzles.filter((p) => p.id !== id);
      if (state.puzzles.length === before) throw new NotFoundError(`No puzzle with id "${id}"`);
      savePuzzles();
      return true;
    },

    async upsertPuzzles(puzzles) {
      let created = 0;
      let updated = 0;
      const now = new Date().toISOString();
      for (const puzzle of puzzles) {
        const index = state.puzzles.findIndex((p) => p.id === puzzle.id);
        if (index === -1) {
          state.puzzles.push({ ...puzzle, createdAt: now, updatedAt: now });
          created += 1;
        } else {
          state.puzzles[index] = { ...state.puzzles[index], ...puzzle, updatedAt: now };
          updated += 1;
        }
      }
      savePuzzles();
      return { created, updated };
    },

    // ---------------------------------------------------------------- players
    // Keyed on the authenticated user id. Anonymous play never reaches this table.

    async getPlayer(userId) {
      return clone(state.players.find((p) => p.userId === userId) || null);
    },

    async findPlayerByDisplayName(displayName) {
      const needle = String(displayName || '').toLowerCase();
      return clone(state.players.find((p) => String(p.displayName).toLowerCase() === needle) || null);
    },

    /** Create the player row on first sign-in, or refresh the profile on later ones. */
    async upsertPlayer({ userId, email = null, displayName }) {
      let player = state.players.find((p) => p.userId === userId);
      if (!player) {
        player = {
          userId,
          email,
          displayName,
          totalScore: 0,
          solves: 0,
          currentStreak: 0,
          bestStreak: 0,
          lastSolvedAt: null,
          createdAt: new Date().toISOString(),
        };
        state.players.push(player);
      } else {
        if (email) player.email = email;
        if (displayName) player.displayName = displayName;
      }
      savePlayers();
      return clone(player);
    },

    async recordSolve({ userId, displayName, pointsEarned, solvedAt = new Date().toISOString(), streak = null }) {
      let player = state.players.find((p) => p.userId === userId);
      if (!player) {
        player = await this.upsertPlayer({ userId, displayName });
        player = state.players.find((p) => p.userId === userId);
      }
      player.totalScore = (player.totalScore || 0) + Math.max(0, pointsEarned);
      player.solves = (player.solves || 0) + 1;
      player.currentStreak = streak ?? (player.currentStreak || 0) + 1;
      player.bestStreak = Math.max(player.bestStreak || 0, player.currentStreak);
      player.lastSolvedAt = solvedAt;
      savePlayers();
      return clone(player);
    },

    async deletePlayer(userId) {
      const before = state.players.length;
      state.players = state.players.filter((p) => p.userId !== userId);
      if (state.players.length === before) return false;
      savePlayers();
      return true;
    },

    async resetStreak(userId) {
      const player = state.players.find((p) => p.userId === userId);
      if (!player) return null;
      player.currentStreak = 0;
      savePlayers();
      return clone(player);
    },

    async getLeaderboard(limit = 10) {
      const rows = [...state.players]
        .sort((a, b) => {
          const diff = (b.totalScore || 0) - (a.totalScore || 0);
          return diff !== 0 ? diff : String(a.displayName).localeCompare(String(b.displayName));
        })
        .slice(0, limit)
        // The email is never part of a public read model.
        .map(({ email, userId, ...publicFields }) => publicFields);
      return clone(rows);
    },

    // ------------------------------------------------------------------ stats

    async recordAttempt({ correct, puzzle, pointsEarned = 0 }) {
      // userId is accepted by the contract but the file driver only keeps running totals.
      const totals = state.attemptTotals;
      totals.totalAttempts += 1;
      if (correct) {
        totals.correct += 1;
        totals.totalSolves += 1;
        totals.totalPoints += Math.max(0, pointsEarned);
        if (puzzle?.type && totals.byType[puzzle.type] !== undefined) totals.byType[puzzle.type] += 1;
        if (puzzle?.difficulty && totals.byDifficulty[puzzle.difficulty] !== undefined) {
          totals.byDifficulty[puzzle.difficulty] += 1;
        }
      } else {
        totals.wrong += 1;
      }
      saveAttempts();
      return clone(totals);
    },

    async getStats() {
      const totals = state.attemptTotals;
      return {
        totalSolves: totals.totalSolves,
        totalAttempts: totals.totalAttempts,
        totalPoints: totals.totalPoints,
        completionsByType: { ...totals.byType },
        completionsByDifficulty: { ...totals.byDifficulty },
        correctVsWrong: { correct: totals.correct, wrong: totals.wrong },
        players: state.players.length,
        puzzles: state.puzzles.filter((p) => p.isPublished !== false).length,
      };
    },
  };
}

module.exports = { createJsonRepository };
