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

module.exports = { createRepository, createJsonRepository, createSupabaseRepository };
