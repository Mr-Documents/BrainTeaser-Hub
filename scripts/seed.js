#!/usr/bin/env node
'use strict';

/**
 * Load data/puzzles.seed.json into whichever storage driver is configured.
 *
 * Idempotent: puzzles are upserted by id, so running it twice changes nothing and running it
 * after editing the seed file republishes the edits.
 *
 *   npm run db:seed                 # into the configured driver (Supabase if credentials exist)
 *   DATA_DRIVER=json npm run db:seed
 *   npm run db:seed -- --file other.json --dry-run
 */

const fs = require('fs');
const path = require('path');
const { config } = require('../src/config');
const { createRepository } = require('../src/repositories');
const { safeParsePuzzle } = require('../src/domain/puzzleSchema');
const { createLogger } = require('../src/lib/logger');

const logger = createLogger({ level: 'info', pretty: true });

function parseArgs(argv) {
  const args = { file: path.join(config.rootDir, 'data', 'puzzles.seed.json'), dryRun: false };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--file' && argv[i + 1]) args.file = path.resolve(argv[(i += 1)]);
    else if (argv[i] === '--dry-run') args.dryRun = true;
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (!fs.existsSync(args.file)) {
    logger.error(`Seed file not found: ${args.file}`);
    process.exitCode = 1;
    return;
  }

  const raw = JSON.parse(fs.readFileSync(args.file, 'utf8'));
  const incoming = Array.isArray(raw) ? raw : raw.puzzles || [];
  logger.info(`Read ${incoming.length} puzzles from ${path.relative(config.rootDir, args.file)}`);

  const valid = [];
  const rejected = [];
  const seen = new Set();

  for (const [index, entry] of incoming.entries()) {
    const parsed = safeParsePuzzle(entry);
    if (!parsed.ok) {
      rejected.push({ index, id: entry?.id, issues: parsed.issues });
      continue;
    }
    if (seen.has(parsed.data.id)) {
      rejected.push({ index, id: parsed.data.id, issues: [{ path: 'id', message: 'duplicate id in seed file' }] });
      continue;
    }
    seen.add(parsed.data.id);
    valid.push(parsed.data);
  }

  for (const bad of rejected) {
    logger.warn(`Skipped puzzle #${bad.index} (${bad.id ?? 'no id'})`, {
      issues: bad.issues.map((i) => `${i.path}: ${i.message}`),
    });
  }

  if (args.dryRun) {
    logger.info(`Dry run - ${valid.length} valid, ${rejected.length} rejected. Nothing written.`);
    return;
  }

  const repository = createRepository({ logger });
  logger.info(`Writing to the "${repository.driver}" driver…`);

  const { created, updated } = await repository.upsertPuzzles(valid);
  await repository.flush?.();

  logger.info('Seed complete', { created, updated, rejected: rejected.length, driver: repository.driver });

  if (rejected.length) process.exitCode = 1;
}

main().catch((err) => {
  logger.error('Seeding failed', { error: err.message, stack: err.stack });
  process.exit(1);
});
