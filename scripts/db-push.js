#!/usr/bin/env node
'use strict';

/**
 * Print the migration SQL, and verify whether the configured Supabase project already has it.
 *
 * Supabase's JS client cannot execute arbitrary DDL, so applying the schema is a deliberate,
 * visible step: `supabase db push`, or paste the printed SQL into the dashboard SQL editor.
 * This script tells you which of those you still need to do.
 */

const fs = require('fs');
const path = require('path');
const { config } = require('../src/config');
const { createLogger } = require('../src/lib/logger');

const logger = createLogger({ level: 'info', pretty: true });
const MIGRATIONS_DIR = path.join(config.rootDir, 'supabase', 'migrations');
const MIGRATIONS = ['0001_init.sql', '0002_auth.sql'];

/**
 * Does this table/view genuinely exist?
 *
 * A HEAD request with count:'exact' is not a reliable existence probe on every PostgREST
 * version - some return 200/null-count for a table that is not in the schema cache instead of
 * erroring. A plain GET with limit(1) does not have that failure mode, so that is what this
 * script uses, at the cost of one row of real network traffic per check.
 */
async function exists(db, relation) {
  const { error } = await db.from(relation).select('*').limit(1);
  if (!error) return { ok: true };
  // PGRST205: "Could not find the table/view X in the schema cache" - the one error that
  // specifically means "this relation does not exist", as opposed to a permissions or
  // connectivity problem, which should be surfaced rather than read as "missing".
  if (error.code === 'PGRST205') return { ok: false, message: error.message };
  return { ok: false, message: error.message, unexpected: true };
}

async function rpcExists(db, name, args) {
  const { error } = await db.rpc(name, args);
  if (!error) return { ok: true };
  if (error.code === 'PGRST202') return { ok: false, message: error.message };
  // Any other error (e.g. a constraint violation from the probe args) still proves the
  // function exists and was reachable - only "not found" means the migration is missing.
  return { ok: true, message: `reachable (probe call errored as expected: ${error.message})` };
}

async function checkSchema() {
  const { createClient } = require('@supabase/supabase-js');
  const db = createClient(config.supabase.url, config.supabase.key, {
    auth: { persistSession: false },
  });

  const checks = [
    ['0001_init.sql', 'puzzles table', () => exists(db, 'puzzles')],
    ['0001_init.sql', 'attempts table', () => exists(db, 'attempts')],
    ['0001_init.sql', 'v_puzzles_public view', () => exists(db, 'v_puzzles_public')],
    ['0002_auth.sql', 'players table (identity-keyed)', () => exists(db, 'players')],
    ['0002_auth.sql', 'v_leaderboard view', () => exists(db, 'v_leaderboard')],
    ['0002_auth.sql', 'v_stats_summary view', () => exists(db, 'v_stats_summary')],
    ['0002_auth.sql', 'v_solves_by_type view', () => exists(db, 'v_solves_by_type')],
    ['0002_auth.sql', 'v_solves_by_difficulty view', () => exists(db, 'v_solves_by_difficulty')],
    [
      '0002_auth.sql',
      'record_solve(uuid, text, integer, integer) function',
      () =>
        rpcExists(db, 'record_solve', {
          p_user_id: '00000000-0000-0000-0000-000000000000',
          p_display_name: '__schema_probe__',
          p_points: 0,
          p_streak: null,
        }),
    ],
  ];

  let allPresent = true;
  const missingByMigration = new Set();

  for (const [migration, label, run] of checks) {
    const result = await run();
    if (result.ok) {
      logger.info(`present: ${label}`, result.message ? { note: result.message } : undefined);
    } else {
      allPresent = false;
      missingByMigration.add(migration);
      const level = result.unexpected ? 'error' : 'warn';
      logger[level](`missing: ${label}`, { migration, message: result.message });
    }
  }

  return { allPresent, missingByMigration };
}

async function main() {
  for (const file of MIGRATIONS) {
    if (!fs.existsSync(path.join(MIGRATIONS_DIR, file))) {
      logger.error(`Migration not found: ${file}`);
      process.exit(1);
    }
  }

  if (!config.data.hasSupabaseCreds) {
    logger.warn('No SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY found - cannot check the remote schema.');
    logger.info('Copy .env.example to .env and fill in your project credentials, then re-run.');
    logger.info(`Migrations to apply, in order: ${MIGRATIONS.join(', ')}`);
    return;
  }

  logger.info('Checking the Supabase schema...', { url: config.supabase.url });
  const { allPresent, missingByMigration } = await checkSchema();

  if (allPresent) {
    logger.info('Schema is up to date. Run `npm run db:seed` to load the puzzle catalogue.');
    return;
  }

  logger.warn('Schema is incomplete. Apply the missing migration(s), in order, with either:');
  logger.warn('  1. supabase db push          (Supabase CLI, linked project)');
  logger.warn('  2. Dashboard -> SQL Editor -> paste the file below -> Run');
  for (const file of MIGRATIONS) {
    if (missingByMigration.has(file)) {
      logger.warn(`     - supabase/migrations/${file}`);
    }
  }
  process.exitCode = 1;
}

main().catch((err) => {
  logger.error('db:push failed', { error: err.message });
  process.exit(1);
});
