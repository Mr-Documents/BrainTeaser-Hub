'use strict';

const { config } = require('../config');
const { createSupabaseAuthProvider } = require('./supabaseAuthProvider');
const { createLocalAuthProvider } = require('./localAuthProvider');

/**
 * Build the auth provider for the configured driver.
 *
 * Mirrors createRepository(): the routes and services above this line know only the contract
 * (sendMagicLink / verifyMagicLink / getUser / deleteUser), so the test suite exercises the real
 * sign-in flow against the local provider without a network call.
 *
 * @param {object} [options]
 * @param {'supabase'|'local'} [options.driver]
 */
function createAuthProvider({ driver = config.auth.driver, logger = console } = {}) {
  if (driver === 'supabase') {
    return createSupabaseAuthProvider({
      url: config.supabase.url,
      key: config.supabase.key,
      logger,
    });
  }
  return createLocalAuthProvider({ logger });
}

module.exports = { createAuthProvider, createSupabaseAuthProvider, createLocalAuthProvider };
