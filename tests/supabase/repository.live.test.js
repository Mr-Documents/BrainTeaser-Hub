'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  isConfigured,
  adminClient,
  repository,
  testId,
  makePuzzle,
  createTestUser,
  cleanup,
  PREFIX,
} = require('./helpers/liveProject');

/**
 * The Supabase repository, against a real Postgres.
 *
 * This is the suite that closes the gap the rest of the tests cannot: every other test runs on
 * the in-memory driver, so a wrong column name, a mismatched RPC signature or a broken view
 * would only surface in production. Here it surfaces on `npm run test:supabase`.
 *
 * Skips cleanly when no credentials are configured, so CI and a fresh clone are unaffected.
 */
const describe = isConfigured ? test.describe : test.describe.skip;

if (!isConfigured) {
  test('supabase integration tests skipped - no SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY', () => {
    assert.ok(true);
  });
}

describe('supabase repository (live)', () => {
  const db = isConfigured ? adminClient() : null;
  const repo = isConfigured ? repository() : null;

  test.after(async () => {
    const problems = await cleanup(db);
    if (problems.length) {
      // Loud, but not a test failure - a cleanup fault must not be mistaken for a code fault.
      console.warn('\n  cleanup left rows behind:\n   - ' + problems.join('\n   - '));
    }
  });

  // ------------------------------------------------------------------ health

  test('healthCheck reports the real puzzle count', async () => {
    const health = await repo.healthCheck();
    assert.equal(health.ok, true);
    assert.equal(health.driver, 'supabase');
    assert.equal(typeof health.puzzles, 'number');
  });

  // ----------------------------------------------------------------- puzzles

  test('a puzzle round-trips through Postgres with every field intact', async () => {
    const puzzle = makePuzzle({ id: testId('roundtrip') });
    const created = await repo.createPuzzle(puzzle);

    // The camelCase <-> snake_case mapping is the most likely thing to be silently wrong.
    assert.equal(created.id, puzzle.id);
    assert.equal(created.question, puzzle.question);
    assert.equal(created.matchMode, 'exact', 'match_mode -> matchMode');
    assert.equal(created.basePoints, 100, 'base_points -> basePoints');
    assert.equal(created.isPublished, true, 'is_published -> isPublished');
    assert.deepEqual(created.answers, ['piano', 'a piano'], 'text[] survives the round trip');
    assert.deepEqual(created.hints, puzzle.hints);
    assert.deepEqual(created.tags, ['test']);
    assert.equal(created.explanation, 'A piano.');
    assert.ok(created.createdAt, 'created_at is populated by the default');
    assert.ok(created.updatedAt);

    const fetched = await repo.getPuzzle(puzzle.id);
    assert.deepEqual(fetched, created, 'reading back matches what was written');
  });

  test('a duplicate id is rejected as a ConflictError, not a raw Postgres error', async () => {
    const puzzle = makePuzzle({ id: testId('dupe') });
    await repo.createPuzzle(puzzle);

    await assert.rejects(
      () => repo.createPuzzle(puzzle),
      (err) => err.status === 409 && err.code === 'conflict',
      'the 23505 unique violation must be translated'
    );
  });

  test('the database enforces its own constraints, not just the app', async () => {
    // If validation were ever bypassed, Postgres is the last line of defence.
    const { error: badType } = await db.from('puzzles').insert({
      id: testId('badtype'),
      question: 'A question long enough to pass the length check.',
      type: 'philosophy',
      difficulty: 'easy',
      answers: ['x'],
    });
    assert.ok(badType, 'an unknown type must violate the check constraint');
    assert.match(badType.message, /violates check constraint/i);

    const { error: badId } = await db.from('puzzles').insert({
      id: 'Not A Valid Slug!',
      question: 'A question long enough to pass the length check.',
      type: 'logic',
      difficulty: 'easy',
      answers: ['x'],
    });
    assert.ok(badId, 'the slug pattern must be enforced');

    const { error: noAnswers } = await db.from('puzzles').insert({
      id: testId('noanswers'),
      question: 'A question long enough to pass the length check.',
      type: 'logic',
      difficulty: 'easy',
      answers: [],
    });
    assert.ok(noAnswers, 'cardinality(answers) >= 1 must be enforced');
  });

  test('updating a puzzle changes updated_at via the trigger', async () => {
    const puzzle = makePuzzle({ id: testId('touch') });
    const created = await repo.createPuzzle(puzzle);

    await new Promise((r) => setTimeout(r, 1100));
    const updated = await repo.updatePuzzle(puzzle.id, { ...puzzle, difficulty: 'hard' });

    assert.equal(updated.difficulty, 'hard');
    assert.equal(updated.createdAt, created.createdAt, 'created_at is immutable');
    assert.ok(
      new Date(updated.updatedAt) > new Date(created.updatedAt),
      'the puzzles_touch_updated_at trigger must fire'
    );
  });

  test('updating or deleting an unknown puzzle raises NotFound', async () => {
    await assert.rejects(
      () => repo.updatePuzzle(testId('ghost'), makePuzzle({ id: testId('ghost') })),
      (err) => err.status === 404
    );
    await assert.rejects(
      () => repo.deletePuzzle(testId('ghost')),
      (err) => err.status === 404
    );
  });

  test('listPuzzles filters, counts and paginates in SQL', async () => {
    await repo.upsertPuzzles([
      makePuzzle({ id: testId('f-logic-easy'), type: 'logic', difficulty: 'easy' }),
      makePuzzle({ id: testId('f-logic-hard'), type: 'logic', difficulty: 'hard' }),
      makePuzzle({ id: testId('f-math-hard'), type: 'math', difficulty: 'hard' }),
      makePuzzle({ id: testId('f-draft'), type: 'math', difficulty: 'hard', isPublished: false }),
    ]);

    // Scoped to this test's own fixtures, not the whole run: other tests in the suite also
    // create prefixed puzzles (one of them ends up 'hard'), which would inflate these counts.
    const mine = (rows) => rows.filter((p) => p.id.startsWith(testId('f-')));

    const logic = await repo.listPuzzles({ includeUnpublished: true, type: 'logic' });
    assert.equal(mine(logic.puzzles).length, 2);

    const hard = await repo.listPuzzles({ includeUnpublished: true, difficulty: 'hard' });
    assert.equal(mine(hard.puzzles).length, 3);

    const published = await repo.listPuzzles({ includeUnpublished: false, difficulty: 'hard' });
    assert.equal(mine(published.puzzles).length, 2, 'drafts are excluded by default');

    const searched = await repo.listPuzzles({ includeUnpublished: true, search: 'f-math-hard' });
    assert.equal(mine(searched.puzzles).length, 1, 'ilike search works');

    const paged = await repo.listPuzzles({ includeUnpublished: true, limit: 2, offset: 0 });
    assert.equal(paged.puzzles.length, 2, 'range() limits the rows');
    assert.ok(paged.total > 2, 'count:exact reports the full total, not the page size');
  });

  test('upsertPuzzles distinguishes created from updated', async () => {
    const rows = [makePuzzle({ id: testId('up-a') }), makePuzzle({ id: testId('up-b') })];

    const first = await repo.upsertPuzzles(rows);
    assert.deepEqual(first, { created: 2, updated: 0 });

    const second = await repo.upsertPuzzles([{ ...rows[0], difficulty: 'hard' }]);
    assert.deepEqual(second, { created: 0, updated: 1 });

    assert.equal((await repo.getPuzzle(testId('up-a'))).difficulty, 'hard');
  });

  test('a search term containing PostgREST syntax cannot break the query', async () => {
    // `or=(...)` filters are string-built, so punctuation is the obvious injection surface.
    for (const term of ['a,b', 'x)y(', '%_%', "it's"]) {
      const result = await repo.listPuzzles({ includeUnpublished: true, search: term });
      assert.ok(Array.isArray(result.puzzles), `search "${term}" should not throw`);
    }
  });

  // ----------------------------------------------------------------- players

  test('upsertPlayer creates then updates a profile', async () => {
    const { userId, email } = await createTestUser(db, 'upsert');

    const created = await repo.upsertPlayer({ userId, email, displayName: `${PREFIX}ada` });
    assert.equal(created.userId, userId, 'user_id -> userId');
    assert.equal(created.displayName, `${PREFIX}ada`, 'display_name -> displayName');
    assert.equal(created.email, email);
    assert.equal(created.totalScore, 0);
    assert.equal(created.currentStreak, 0);

    const renamed = await repo.upsertPlayer({ userId, displayName: `${PREFIX}grace` });
    assert.equal(renamed.displayName, `${PREFIX}grace`);
    assert.equal(renamed.email, email, 'an omitted email must not blank the stored one');
  });

  test('the players foreign key refuses an id that is not a real auth user', async () => {
    await assert.rejects(
      () =>
        repo.upsertPlayer({
          userId: '00000000-0000-0000-0000-000000000000',
          displayName: `${PREFIX}ghost`,
        }),
      (err) => err.status >= 400,
      'players.user_id -> auth.users(id) must be enforced'
    );
  });

  test('display names are unique case-insensitively', async () => {
    const a = await createTestUser(db, 'name-a');
    const b = await createTestUser(db, 'name-b');

    await repo.upsertPlayer({ userId: a.userId, displayName: `${PREFIX}Unique` });

    await assert.rejects(
      () => repo.upsertPlayer({ userId: b.userId, displayName: `${PREFIX}UNIQUE` }),
      (err) => err.status >= 400,
      'the lower(display_name) unique index must reject a case variant'
    );
  });

  test('findPlayerByDisplayName matches case-insensitively', async () => {
    const { userId } = await createTestUser(db, 'find');
    await repo.upsertPlayer({ userId, displayName: `${PREFIX}FindMe` });

    const found = await repo.findPlayerByDisplayName(`${PREFIX}findme`);
    assert.ok(found, 'ilike lookup must find a differently-cased name');
    assert.equal(found.userId, userId);

    assert.equal(await repo.findPlayerByDisplayName(`${PREFIX}nobody`), null);
  });

  // ------------------------------------------------- record_solve (the RPC)

  test('record_solve creates the player row on a first solve', async () => {
    const { userId } = await createTestUser(db, 'solve-new');

    const player = await repo.recordSolve({
      userId,
      displayName: `${PREFIX}solver`,
      pointsEarned: 120,
      streak: 1,
    });

    assert.equal(player.userId, userId);
    assert.equal(player.totalScore, 120);
    assert.equal(player.solves, 1);
    assert.equal(player.currentStreak, 1);
    assert.equal(player.bestStreak, 1);
    assert.ok(player.lastSolvedAt);
  });

  test('record_solve accumulates on conflict rather than overwriting', async () => {
    const { userId } = await createTestUser(db, 'solve-acc');
    const name = `${PREFIX}accumulator`;

    await repo.recordSolve({ userId, displayName: name, pointsEarned: 100, streak: 1 });
    await repo.recordSolve({ userId, displayName: name, pointsEarned: 50, streak: 2 });
    const third = await repo.recordSolve({ userId, displayName: name, pointsEarned: 25, streak: 3 });

    assert.equal(third.totalScore, 175, 'scores add up');
    assert.equal(third.solves, 3);
    assert.equal(third.currentStreak, 3);
    assert.equal(third.bestStreak, 3);
  });

  test('best_streak keeps the high-water mark when a streak breaks', async () => {
    const { userId } = await createTestUser(db, 'solve-streak');
    const name = `${PREFIX}streaker`;

    await repo.recordSolve({ userId, displayName: name, pointsEarned: 10, streak: 5 });
    const broken = await repo.recordSolve({ userId, displayName: name, pointsEarned: 10, streak: 1 });

    assert.equal(broken.currentStreak, 1, 'the current streak resets');
    assert.equal(broken.bestStreak, 5, 'the best is never lowered');
  });

  test('record_solve is atomic under concurrent writes', async () => {
    const { userId } = await createTestUser(db, 'solve-race');
    const name = `${PREFIX}concurrent`;

    // The whole reason this is an RPC: read-modify-write from the app would lose increments.
    const writes = Array.from({ length: 10 }, () =>
      repo.recordSolve({ userId, displayName: name, pointsEarned: 10, streak: 1 })
    );
    await Promise.all(writes);

    const player = await repo.getPlayer(userId);
    assert.equal(player.totalScore, 100, 'no increment may be lost');
    assert.equal(player.solves, 10);
  });

  test('negative points cannot drain a score', async () => {
    const { userId } = await createTestUser(db, 'solve-neg');
    const name = `${PREFIX}negative`;

    await repo.recordSolve({ userId, displayName: name, pointsEarned: 100, streak: 1 });
    const after = await repo.recordSolve({ userId, displayName: name, pointsEarned: -500, streak: 1 });

    assert.equal(after.totalScore, 100, 'greatest(p_points, 0) must clamp');
  });

  test('resetStreak zeroes the current streak but keeps the best', async () => {
    const { userId } = await createTestUser(db, 'reset');
    const name = `${PREFIX}resetme`;

    await repo.recordSolve({ userId, displayName: name, pointsEarned: 10, streak: 4 });
    const reset = await repo.resetStreak(userId);

    assert.equal(reset.currentStreak, 0);
    assert.equal(reset.bestStreak, 4);
  });

  // ------------------------------------------------------------ leaderboard

  test('the leaderboard reads the view and never exposes an email or user id', async () => {
    const { userId } = await createTestUser(db, 'board');
    await repo.recordSolve({
      userId,
      displayName: `${PREFIX}boarder`,
      pointsEarned: 999999,
      streak: 1,
    });

    const board = await repo.getLeaderboard(100);
    const mine = board.find((row) => row.displayName === `${PREFIX}boarder`);

    assert.ok(mine, 'the player appears on the board');
    assert.equal(mine.totalScore, 999999);
    assert.equal(mine.email, undefined, 'v_leaderboard must not carry the email');
    assert.equal(mine.userId, undefined, 'nor the user id');

    const serialised = JSON.stringify(board);
    assert.doesNotMatch(serialised, /@brainteaser-test\.invalid/, 'no test email may leak');
  });

  test('the leaderboard is ordered by score descending', async () => {
    const board = await repo.getLeaderboard(50);
    const scores = board.map((row) => row.totalScore);
    const sorted = [...scores].sort((a, b) => b - a);
    assert.deepEqual(scores, sorted);
  });

  test('deletePlayer removes the row', async () => {
    const { userId } = await createTestUser(db, 'delete');
    await repo.upsertPlayer({ userId, displayName: `${PREFIX}deleteme` });

    assert.equal(await repo.deletePlayer(userId), true);
    assert.equal(await repo.getPlayer(userId), null);
    assert.equal(await repo.deletePlayer(userId), false, 'deleting twice reports false');
  });

  test('deleting an auth user cascades to the player row', async () => {
    const { userId } = await createTestUser(db, 'cascade');
    await repo.upsertPlayer({ userId, displayName: `${PREFIX}cascader` });

    await db.auth.admin.deleteUser(userId);
    assert.equal(await repo.getPlayer(userId), null, 'on delete cascade must fire');
  });

  // ------------------------------------------------------ attempts and stats

  test('recordAttempt writes both correct and wrong rows', async () => {
    const puzzleId = testId('stats-puzzle');
    await repo.createPuzzle(makePuzzle({ id: puzzleId, type: 'math', difficulty: 'hard' }));
    const { userId } = await createTestUser(db, 'attempts');

    await repo.recordAttempt({ correct: false, puzzle: { id: puzzleId }, userId });
    await repo.recordAttempt({
      correct: true,
      puzzle: { id: puzzleId },
      userId,
      pointsEarned: 42,
      hintsUsed: 1,
      wrongAttempts: 1,
      durationMs: 5000,
    });

    const { data, error } = await db.from('attempts').select('*').eq('puzzle_id', puzzleId);
    assert.equal(error, null);
    assert.equal(data.length, 2);

    const solved = data.find((row) => row.is_correct);
    assert.equal(solved.points_earned, 42);
    assert.equal(solved.hints_used, 1);
    assert.equal(solved.wrong_attempts, 1);
    assert.equal(solved.duration_ms, 5000);
    assert.equal(solved.user_id, userId, 'user_id -> attempts.user_id');
  });

  test('an anonymous attempt is recorded with a null owner', async () => {
    const puzzleId = testId('anon-puzzle');
    await repo.createPuzzle(makePuzzle({ id: puzzleId }));

    await repo.recordAttempt({ correct: true, puzzle: { id: puzzleId }, pointsEarned: 10 });

    const { data } = await db.from('attempts').select('user_id').eq('puzzle_id', puzzleId);
    assert.equal(data.length, 1);
    assert.equal(data[0].user_id, null, 'anonymous play must still be counted');
  });

  test('the stats views aggregate in SQL and match the rows written', async () => {
    const before = await repo.getStats();

    const puzzleId = testId('agg-puzzle');
    await repo.createPuzzle(makePuzzle({ id: puzzleId, type: 'lateral', difficulty: 'medium' }));

    await repo.recordAttempt({ correct: true, puzzle: { id: puzzleId }, pointsEarned: 30 });
    await repo.recordAttempt({ correct: true, puzzle: { id: puzzleId }, pointsEarned: 20 });
    await repo.recordAttempt({ correct: false, puzzle: { id: puzzleId } });

    const after = await repo.getStats();

    assert.equal(after.totalAttempts - before.totalAttempts, 3);
    assert.equal(after.totalSolves - before.totalSolves, 2);
    assert.equal(after.correctVsWrong.correct - before.correctVsWrong.correct, 2);
    assert.equal(after.correctVsWrong.wrong - before.correctVsWrong.wrong, 1);
    assert.equal(after.totalPoints - before.totalPoints, 50);
    assert.equal(
      after.completionsByType.lateral - before.completionsByType.lateral,
      2,
      'v_solves_by_type must group by the joined puzzle type'
    );
    assert.equal(
      after.completionsByDifficulty.medium - before.completionsByDifficulty.medium,
      2,
      'v_solves_by_difficulty must group by the joined difficulty'
    );
  });

  test('getStats always returns every type and difficulty key, even at zero', async () => {
    const stats = await repo.getStats();
    for (const type of ['logic', 'math', 'word', 'lateral', 'trivia']) {
      assert.equal(typeof stats.completionsByType[type], 'number', `${type} must be present`);
    }
    for (const level of ['easy', 'medium', 'hard']) {
      assert.equal(typeof stats.completionsByDifficulty[level], 'number');
    }
  });

  test('deleting a puzzle leaves its attempts in the totals, unattributed', async () => {
    const puzzleId = testId('orphan-puzzle');
    await repo.createPuzzle(makePuzzle({ id: puzzleId }));
    await repo.recordAttempt({ correct: true, puzzle: { id: puzzleId }, pointsEarned: 10 });

    const before = await repo.getStats();
    await repo.deletePuzzle(puzzleId);
    const after = await repo.getStats();

    assert.equal(after.totalAttempts, before.totalAttempts, 'on delete set null must preserve the attempt row');
  });
});
