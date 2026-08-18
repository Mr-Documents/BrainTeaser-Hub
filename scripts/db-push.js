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
const MIGRATION = path.join(config.rootDir, 'supabase', 'migrations', '0001_init.sql');

async function checkSchema() {
  const { createClient } = require('@supabase/supabase-js');
  const db = createClient(config.supabase.url, config.supabase.key, {
    auth: { persistSession: false },
  });

  const checks = [
    ['puzzles table', () => db.from('puzzles').select('id', { head: true, count: 'exact' })],
    ['players table', () => db.from('players').select('username', { head: true, count: 'exact' })],
    ['attempts table', () => db.from('attempts').select('id', { head: true, count: 'exact' })],
    ['v_stats_summary view', () => db.from('v_stats_summary').select('*').limit(1)],
  ];

  let allPresent = true;
  for (const [label, run] of checks) {
    const { error } = await run();
    if (error) {
      allPresent = false;
      logger.warn(`missing: ${label}`, { message: error.message });
    } else {
      logger.info(`present: ${label}`);
    }
  }
  return allPresent;
}

async function main() {
  if (!fs.existsSync(MIGRATION)) {
    logger.error(`Migration not found at ${MIGRATION}`);
    process.exit(1);
  }

  if (!config.data.hasSupabaseCreds) {
    logger.warn('No SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY found — cannot check the remote schema.');
    logger.info('Copy .env.example to .env and fill in your project credentials, then re-run.');
    logger.info(`Migration to apply: ${path.relative(config.rootDir, MIGRATION)}`);
    return;
  }

  logger.info('Checking the Supabase schema…', { url: config.supabase.url });
  const ready = await checkSchema();

  if (ready) {
    logger.info('Schema is up to date. Run `npm run db:seed` to load the puzzle catalogue.');
    return;
  }

  logger.warn('Schema is incomplete. Apply the migration with either:');
  logger.warn('  1. supabase db push          (Supabase CLI, linked project)');
  logger.warn('  2. Dashboard → SQL Editor → paste supabase/migrations/0001_init.sql → Run');
  process.exitCode = 1;
}

main().catch((err) => {
  logger.error('db:push failed', { error: err.message });
  process.exit(1);
});
