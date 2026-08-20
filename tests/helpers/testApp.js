'use strict';

const { createApp } = require('../../src/http/app');
const { createJsonRepository } = require('../../src/repositories/jsonRepository');
const { config } = require('../../src/config');
const { createLogger } = require('../../src/lib/logger');
const { createLocalAuthProvider } = require('../../src/auth/localAuthProvider');

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
function buildTestApp({
  puzzles = [makePuzzle()],
  adminAuth = false,
  adminToken = 'test-token',
  oauthProviders = ['google'],
} = {}) {
  const repository = createJsonRepository({ persist: false, seed: { puzzles } });
  // Captures the magic links this app issues, so a test can "click" one without an inbox.
  const issuedLinks = [];
  const authProvider = createLocalAuthProvider({
    logger: { warn() {}, info() {} },
    onLink: (link) => issuedLinks.push(link),
    oauthProviders,
  });

  const testConfig = {
    ...config,
    env: 'test',
    isProduction: false,
    isTest: true,
    logLevel: 'silent',
    admin: { ...config.admin, required: adminAuth, token: adminToken },
    auth: { ...config.auth, driver: 'local', sessionSecret: 'test-session-secret' },
    rateLimit: { ...config.rateLimit, enabled: false },
    data: { ...config.data, driver: 'memory' },
  };

  const app = createApp({
    config: testConfig,
    repository,
    authProvider,
    logger: createLogger({ level: 'silent' }),
  });

  return { app, repository, authProvider, issuedLinks, config: testConfig, adminToken };
}

/**
 * Drive the real sign-in flow end to end and return the session cookie.
 * Uses the same routes a browser would: request a link, then follow it.
 *
 * @returns {Promise<{ cookie: string, displayName: string }>}
 */
async function signIn(app, issuedLinks, email = 'ada@example.com') {
  const request = require('supertest');
  await request(app).post('/signin').send({ email }).expect(200);

  const issued = issuedLinks.at(-1);
  if (!issued) throw new Error('no sign-in link was issued');

  const callbackPath = issued.link.slice(issued.link.indexOf('/auth/callback'));
  const res = await request(app).get(callbackPath).expect(302);

  const cookie = (res.headers['set-cookie'] || []).find((c) => c.startsWith('bth_session='));
  if (!cookie) throw new Error('sign-in did not set a session cookie');

  return { cookie: cookie.split(';')[0], redirectedTo: res.headers.location };
}

/**
 * An app wired the way production wires it: trust proxy on, secure cookies, rate limiting
 * enabled, admin auth required.
 *
 * These paths never run under `npm test` otherwise, which is exactly why they are worth
 * covering - a misconfigured proxy or a shared rate-limit key breaks every user at once, and
 * only on the deployed site.
 */
function buildProductionApp({ puzzles = [makePuzzle()], rateLimit = {}, baseUrl = '' } = {}) {
  const repository = createJsonRepository({ persist: false, seed: { puzzles } });
  const issuedLinks = [];
  const authProvider = createLocalAuthProvider({
    logger: { warn() {}, info() {} },
    onLink: (link) => issuedLinks.push(link),
  });

  const productionConfig = {
    ...config,
    env: 'production',
    isProduction: true,
    logLevel: 'silent',
    auth: { ...config.auth, driver: 'local', sessionSecret: 'production-session-secret' },
    admin: { ...config.admin, required: true, token: 'production-admin-token' },
    rateLimit: { ...config.rateLimit, enabled: true, windowMs: 60_000, apiMax: 1000, submitMax: 5, ...rateLimit },
    data: { ...config.data, driver: 'memory' },
    site: { ...config.site, baseUrl },
  };

  const app = createApp({
    config: productionConfig,
    repository,
    authProvider,
    logger: createLogger({ level: 'silent' }),
  });

  return { app, repository, authProvider, issuedLinks, config: productionConfig };
}

module.exports = { buildTestApp, buildProductionApp, makePuzzle, signIn };
