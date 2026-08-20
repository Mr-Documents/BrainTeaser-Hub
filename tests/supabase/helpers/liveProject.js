'use strict';

const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');
const { config } = require('../../../src/config');
const { createSupabaseRepository } = require('../../../src/repositories/supabaseRepository');
const { createSupabaseAuthProvider } = require('../../../src/auth/supabaseAuthProvider');

/**
 * Test harness for the live Supabase integration suite.
 *
 * These tests run against a REAL project, so the guiding rule is that they must be safe to run
 * against one that has data in it:
 *
 *  - Every row is created with an id/name carrying a per-run prefix (`zzt-<run>-`), so nothing
 *    can collide with real content and everything is identifiable if cleanup ever fails.
 *  - Cleanup deletes strictly by that prefix. There is no "delete everything" path anywhere.
 *  - Nothing reads or asserts on pre-existing rows, so a populated project and an empty one
 *    both pass.
 *  - Auth users are created through the admin API and deleted in teardown.
 */

/** Unique per process run. Short enough to keep inside the 64-char slug limit. */
const RUN_ID = crypto.randomBytes(4).toString('hex');

/** Everything this suite creates starts with this. Cleanup keys off it exclusively. */
const PREFIX = `zzt-${RUN_ID}-`;

const isConfigured = Boolean(config.supabase.url && config.supabase.key);

/** A raw admin client, for setup/teardown that bypasses the repository under test. */
function adminClient() {
  return createClient(config.supabase.url, config.supabase.key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

function repository(logger = silentLogger()) {
  return createSupabaseRepository({ url: config.supabase.url, key: config.supabase.key, logger });
}

function authProvider(logger = silentLogger()) {
  return createSupabaseAuthProvider({
    url: config.supabase.url,
    key: config.supabase.key,
    oauthProviders: ['google'],
    logger,
  });
}

const silentLogger = () => ({ error() {}, warn() {}, info() {}, debug() {} });

/** A prefixed puzzle id, guaranteed not to collide with catalogue content. */
const testId = (name) => `${PREFIX}${name}`;

/** A valid puzzle payload in the repository's camelCase shape. */
function makePuzzle(overrides = {}) {
  return {
    id: testId('puzzle'),
    question: 'What has keys but cannot open a single lock?',
    type: 'word',
    difficulty: 'easy',
    answers: ['piano', 'a piano'],
    matchMode: 'exact',
    hints: ['It has 88 of them.', 'It is an instrument.'],
    explanation: 'A piano.',
    basePoints: 100,
    isPublished: true,
    tags: ['test'],
    ...overrides,
  };
}

/**
 * Create a real auth user for the run.
 * Uses the admin API so no email is ever sent to a real inbox.
 */
async function createTestUser(db, label = 'player') {
  const email = `${PREFIX}${label}@brainteaser-test.invalid`;
  const { data, error } = await db.auth.admin.createUser({
    email,
    email_confirm: true,
    user_metadata: { test_run: RUN_ID },
  });
  if (error) throw new Error(`could not create test user: ${error.message}`);
  return { userId: data.user.id, email };
}

/**
 * The highest attempt id that existed before this run started.
 *
 * Needed because a test may delete its own puzzle mid-run (proving that `on delete set null`
 * preserves the attempt), which nulls `puzzle_id` and makes the row unmatchable by prefix
 * afterwards. Those orphans are not harmless: they feed v_stats_summary, which the live site
 * displays. Watermarking lets cleanup find them again.
 */
let attemptWatermark = null;

/** Call before the first test writes anything. Safe to call more than once. */
async function markStartingPoint(db) {
  if (attemptWatermark !== null) return attemptWatermark;
  const { data } = await db.from('attempts').select('id').order('id', { ascending: false }).limit(1).maybeSingle();
  attemptWatermark = data?.id ?? 0;
  return attemptWatermark;
}

/**
 * Remove everything this run created, in dependency order.
 * Deliberately tolerant: a failure here must report loudly but not mask a test failure.
 */
async function cleanup(db) {
  const problems = [];

  // attempts -> players -> puzzles -> auth users
  const { error: attemptsError } = await db.from('attempts').delete().like('puzzle_id', `${PREFIX}%`);
  if (attemptsError) problems.push(`attempts: ${attemptsError.message}`);

  // Then the orphans this run created. Scoped two ways so a real player's attempt can never be
  // caught by it: newer than the watermark AND detached from any puzzle.
  if (attemptWatermark !== null) {
    const { error: orphanError } = await db
      .from('attempts')
      .delete()
      .gt('id', attemptWatermark)
      .is('puzzle_id', null);
    if (orphanError) problems.push(`orphaned attempts: ${orphanError.message}`);
  }

  const { error: playersError } = await db.from('players').delete().like('display_name', `${PREFIX}%`);
  if (playersError) problems.push(`players: ${playersError.message}`);

  const { error: puzzlesError } = await db.from('puzzles').delete().like('id', `${PREFIX}%`);
  if (puzzlesError) problems.push(`puzzles: ${puzzlesError.message}`);

  const { data: users, error: listError } = await db.auth.admin.listUsers({ perPage: 200 });
  if (listError) {
    problems.push(`listUsers: ${listError.message}`);
  } else {
    for (const user of users.users) {
      if (user.email?.startsWith(PREFIX) || user.user_metadata?.test_run === RUN_ID) {
        const { error } = await db.auth.admin.deleteUser(user.id);
        if (error) problems.push(`deleteUser(${user.email}): ${error.message}`);
      }
    }
  }

  return problems;
}

module.exports = {
  RUN_ID,
  PREFIX,
  isConfigured,
  adminClient,
  repository,
  authProvider,
  silentLogger,
  testId,
  makePuzzle,
  createTestUser,
  cleanup,
  markStartingPoint,
};
