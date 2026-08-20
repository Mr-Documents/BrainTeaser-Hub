'use strict';

const { config } = require('../config');
const { createJsonRepository } = require('./jsonRepository');
const { createSupabaseRepository } = require('./supabaseRepository');

/**
 * Build the repository for the configured driver.
 *
 * Everything above this line (services, routes, views) is written against one contract, so
 * swapping storage is a config change - not a code change.
 *
 * @param {object} [options]
 * @param {'supabase'|'json'|'memory'} [options.driver]
 * @returns {object} repository
 */
function createRepository({ driver = config.data.driver, logger = console, seed = null } = {}) {
  assertSafeUnderTest(driver);

  switch (driver) {
    case 'supabase':
      return createSupabaseRepository({
        url: config.supabase.url,
        key: config.supabase.key,
        schema: config.supabase.schema,
        logger,
      });
    case 'memory':
      return createJsonRepository({ dataDir: config.dataDir, persist: false, seed: seed || { puzzles: [] } });
    case 'json':
    default:
      return createJsonRepository({ dataDir: config.dataDir, persist: true });
  }
}

/**
 * Refuse to hand a test run a connection to the real database.
 *
 * Once a developer has a .env with live credentials, `config.data.driver` resolves to
 * "supabase" for everything they run - including `npm test`. The suite is safe today only
 * because every test injects its own repository; a single test that forgot to would quietly
 * read and write production data.
 *
 * The live suite (tests/supabase/*.live.test.js) is unaffected: it calls
 * createSupabaseRepository directly, which is the explicit, deliberate way in.
 */
function assertSafeUnderTest(driver) {
  if (driver !== 'supabase') return;
  if (process.env.NODE_ENV !== 'test') return;
  if (process.env.ALLOW_SUPABASE_IN_TESTS === '1') return;

  throw new Error(
    'Refusing to build a Supabase repository while NODE_ENV=test - this would run tests against the real database. ' +
      'Tests should inject their own repository (see tests/helpers/testApp.js), or set DATA_DRIVER=memory. ' +
      'The live integration suite builds its client directly and is not affected.'
  );
}

module.exports = { createRepository, createJsonRepository, createSupabaseRepository };
