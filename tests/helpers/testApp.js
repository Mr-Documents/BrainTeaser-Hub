'use strict';

const { createApp } = require('../../src/http/app');
const { createJsonRepository } = require('../../src/repositories/jsonRepository');
const { config } = require('../../src/config');
const { createLogger } = require('../../src/lib/logger');

/** A minimal, valid puzzle. Override any field per test. */
function makePuzzle(overrides = {}) {
  return {
    id: 'test-puzzle',
    question: 'What has keys but cannot open a lock?',
    type: 'word',
    difficulty: 'easy',
    answers: ['piano'],
    matchMode: 'exact',
    hints: ['It has 88 of them.', 'It is an instrument.'],
    explanation: 'A piano.',
    basePoints: 100,
    isPublished: true,
    tags: [],
    ...overrides,
  };
}

/**
 * Build an app wired to an in-memory repository - no files, no network, no shared state
 * between tests. Returns the app plus the pieces a test may want to assert against.
 *
 * @param {object} [options]
 * @param {object[]} [options.puzzles] seed catalogue
 * @param {boolean} [options.adminAuth] require an admin token (default false)
 */
function buildTestApp({ puzzles = [makePuzzle()], adminAuth = false, adminToken = 'test-token' } = {}) {
  const repository = createJsonRepository({ persist: false, seed: { puzzles } });

  const testConfig = {
    ...config,
    env: 'test',
    isProduction: false,
    isTest: true,
    logLevel: 'silent',
    admin: { ...config.admin, required: adminAuth, token: adminToken },
    rateLimit: { ...config.rateLimit, enabled: false },
    data: { ...config.data, driver: 'memory' },
  };

  const app = createApp({
    config: testConfig,
    repository,
    logger: createLogger({ level: 'silent' }),
  });

  return { app, repository, config: testConfig, adminToken };
}

module.exports = { buildTestApp, makePuzzle };
