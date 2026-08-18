'use strict';

const { createClient } = require('@supabase/supabase-js');
const { ConflictError, NotFoundError, AppError } = require('../lib/errors');
const { PUZZLE_TYPES, DIFFICULTIES } = require('../domain/constants');

const PUZZLE_COLUMNS =
  'id, question, type, difficulty, answers, match_mode, hints, explanation, base_points, is_published, tags, created_at, updated_at';

/** Postgres error codes we translate into domain errors instead of leaking. */
const PG_UNIQUE_VIOLATION = '23505';

const toCamel = (row) =>
  row && {
    id: row.id,
    question: row.question,
    type: row.type,
    difficulty: row.difficulty,
    answers: row.answers || [],
    matchMode: row.match_mode,
    hints: row.hints || [],
    explanation: row.explanation ?? null,
    basePoints: row.base_points,
    isPublished: row.is_published,
    tags: row.tags || [],
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };

const toSnake = (puzzle) => ({
  id: puzzle.id,
  question: puzzle.question,
  type: puzzle.type,
  difficulty: puzzle.difficulty,
  answers: puzzle.answers,
  match_mode: puzzle.matchMode,
  hints: puzzle.hints,
  explanation: puzzle.explanation ?? null,
  base_points: puzzle.basePoints,
  is_published: puzzle.isPublished !== false,
  tags: puzzle.tags || [],
});

const playerToCamel = (row) =>
  row && {
    userId: row.user_id,
    displayName: row.display_name,
    email: row.email ?? null,
    totalScore: row.total_score ?? 0,
    solves: row.solves ?? 0,
    currentStreak: row.current_streak ?? 0,
    bestStreak: row.best_streak ?? 0,
    lastSolvedAt: row.last_solved_at ?? null,
    createdAt: row.created_at ?? null,
  };

/** The public shape - no user id, no email. */
const leaderboardToCamel = (row) =>
  row && {
    displayName: row.display_name,
    totalScore: row.total_score ?? 0,
    solves: row.solves ?? 0,
    currentStreak: row.current_streak ?? 0,
    bestStreak: row.best_streak ?? 0,
    lastSolvedAt: row.last_solved_at ?? null,
  };

/**
 * Supabase (Postgres) implementation of the repository contract.
 *
 * Aggregates live in SQL - `record_attempt` is a single RPC so a solve is one atomic round trip
 * (player upsert + streak logic + attempt row), and stats read from views rather than pulling
 * every attempt row into Node.
 */
function createSupabaseRepository({ url, key, schema = 'public', logger = console, client = null } = {}) {
  const db =
    client ||
    createClient(url, key, {
      auth: { persistSession: false, autoRefreshToken: false },
      db: { schema },
      global: { headers: { 'x-application-name': 'brain-teaser-hub' } },
    });

  /** Unwrap a supabase result, mapping known Postgres failures onto domain errors. */
  function unwrap({ data, error }, context) {
    if (!error) return data;
    if (error.code === PG_UNIQUE_VIOLATION) throw new ConflictError('That id is already taken');
    logger.error?.(`supabase ${context} failed`, { code: error.code, message: error.message });
    throw new AppError(`Database error while ${context}`, 502, 'database_error');
  }

  return {
    driver: 'supabase',
    client: db,

    async healthCheck() {
      const { error, count } = await db.from('puzzles').select('id', { count: 'exact', head: true });
      if (error) return { ok: false, driver: 'supabase', error: error.message };
      return { ok: true, driver: 'supabase', puzzles: count ?? 0 };
    },

    async flush() {
      /* writes are synchronous round trips - nothing to drain */
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
      let query = db.from('puzzles').select(PUZZLE_COLUMNS, { count: 'exact' }).order('id', { ascending: true });
      if (!includeUnpublished) query = query.eq('is_published', true);
      if (type) query = query.eq('type', type);
      if (difficulty) query = query.eq('difficulty', difficulty);
      if (search) {
        const escaped = String(search)
          .replace(/[%_,()]/g, ' ')
          .trim();
        if (escaped) query = query.or(`id.ilike.%${escaped}%,question.ilike.%${escaped}%`);
      }
      if (limit) query = query.range(offset, offset + limit - 1);
      else if (offset) query = query.range(offset, offset + 999);

      const result = await query;
      const rows = unwrap(result, 'listing puzzles') || [];
      return { puzzles: rows.map(toCamel), total: result.count ?? rows.length };
    },

    async getPuzzle(id) {
      const result = await db.from('puzzles').select(PUZZLE_COLUMNS).eq('id', id).maybeSingle();
      return toCamel(unwrap(result, 'loading a puzzle')) || null;
    },

    async createPuzzle(puzzle) {
      const result = await db.from('puzzles').insert(toSnake(puzzle)).select(PUZZLE_COLUMNS).single();
      return toCamel(unwrap(result, 'creating a puzzle'));
    },

    async updatePuzzle(id, puzzle) {
      const result = await db
        .from('puzzles')
        .update({ ...toSnake(puzzle), updated_at: new Date().toISOString() })
        .eq('id', id)
        .select(PUZZLE_COLUMNS)
        .maybeSingle();
      const row = unwrap(result, 'updating a puzzle');
      if (!row) throw new NotFoundError(`No puzzle with id "${id}"`);
      return toCamel(row);
    },

    async deletePuzzle(id) {
      const result = await db.from('puzzles').delete().eq('id', id).select('id').maybeSingle();
      const row = unwrap(result, 'deleting a puzzle');
      if (!row) throw new NotFoundError(`No puzzle with id "${id}"`);
      return true;
    },

    async upsertPuzzles(puzzles) {
      if (!puzzles.length) return { created: 0, updated: 0 };
      const existing = unwrap(
        await db
          .from('puzzles')
          .select('id')
          .in(
            'id',
            puzzles.map((p) => p.id)
          ),
        'checking existing puzzles'
      );
      const existingIds = new Set((existing || []).map((r) => r.id));
      unwrap(
        await db.from('puzzles').upsert(puzzles.map(toSnake), { onConflict: 'id' }).select('id'),
        'seeding puzzles'
      );
      const updated = puzzles.filter((p) => existingIds.has(p.id)).length;
      return { created: puzzles.length - updated, updated };
    },

    // ---------------------------------------------------------------- players

    async getPlayer(userId) {
      const result = await db.from('players').select('*').eq('user_id', userId).maybeSingle();
      return playerToCamel(unwrap(result, 'loading a player'));
    },

    async findPlayerByDisplayName(displayName) {
      const result = await db.from('players').select('*').ilike('display_name', String(displayName)).maybeSingle();
      return playerToCamel(unwrap(result, 'checking a display name'));
    },

    async upsertPlayer({ userId, email = null, displayName }) {
      const patch = { user_id: userId, display_name: displayName };
      if (email) patch.email = email;
      const result = await db.from('players').upsert(patch, { onConflict: 'user_id' }).select('*').single();
      return playerToCamel(unwrap(result, 'saving a player profile'));
    },

    async recordSolve({ userId, displayName, pointsEarned, streak = null }) {
      const result = await db.rpc('record_solve', {
        p_user_id: userId,
        p_display_name: displayName,
        p_points: Math.max(0, Math.round(pointsEarned)),
        p_streak: streak,
      });
      const row = unwrap(result, 'recording a solve');
      return playerToCamel(Array.isArray(row) ? row[0] : row);
    },

    async deletePlayer(userId) {
      const result = await db.from('players').delete().eq('user_id', userId).select('user_id').maybeSingle();
      return Boolean(unwrap(result, 'deleting a player'));
    },

    async resetStreak(userId) {
      const result = await db
        .from('players')
        .update({ current_streak: 0 })
        .eq('user_id', userId)
        .select('*')
        .maybeSingle();
      return playerToCamel(unwrap(result, 'resetting a streak'));
    },

    async getLeaderboard(limit = 10) {
      // Reads the view, not the table, so an email can never leak into a public response.
      const result = await db.from('v_leaderboard').select('*').limit(limit);
      return (unwrap(result, 'loading the leaderboard') || []).map(leaderboardToCamel);
    },

    // ------------------------------------------------------------------ stats

    async recordAttempt({
      correct,
      puzzle,
      pointsEarned = 0,
      userId = null,
      hintsUsed = 0,
      wrongAttempts = 0,
      durationMs = null,
    }) {
      unwrap(
        await db.from('attempts').insert({
          puzzle_id: puzzle?.id ?? null,
          user_id: userId,
          is_correct: !!correct,
          points_earned: Math.max(0, Math.round(pointsEarned)),
          hints_used: hintsUsed,
          wrong_attempts: wrongAttempts,
          duration_ms: durationMs,
        }),
        'recording an attempt'
      );
      return null;
    },

    async getStats() {
      const [summary, byType, byDifficulty] = await Promise.all([
        db.from('v_stats_summary').select('*').maybeSingle(),
        db.from('v_solves_by_type').select('*'),
        db.from('v_solves_by_difficulty').select('*'),
      ]);

      const s = unwrap(summary, 'loading stats') || {};
      const typeRows = unwrap(byType, 'loading stats by type') || [];
      const diffRows = unwrap(byDifficulty, 'loading stats by difficulty') || [];

      const completionsByType = Object.fromEntries(PUZZLE_TYPES.map((t) => [t, 0]));
      for (const row of typeRows) {
        if (completionsByType[row.type] !== undefined) completionsByType[row.type] = Number(row.solves) || 0;
      }
      const completionsByDifficulty = Object.fromEntries(DIFFICULTIES.map((d) => [d, 0]));
      for (const row of diffRows) {
        if (completionsByDifficulty[row.difficulty] !== undefined) {
          completionsByDifficulty[row.difficulty] = Number(row.solves) || 0;
        }
      }

      return {
        totalSolves: Number(s.total_solves) || 0,
        totalAttempts: Number(s.total_attempts) || 0,
        totalPoints: Number(s.total_points) || 0,
        completionsByType,
        completionsByDifficulty,
        correctVsWrong: { correct: Number(s.correct_count) || 0, wrong: Number(s.wrong_count) || 0 },
        players: Number(s.player_count) || 0,
        puzzles: Number(s.puzzle_count) || 0,
      };
    },
  };
}

module.exports = { createSupabaseRepository };
