'use strict';

const path = require('path');
const express = require('express');
const helmet = require('helmet');
const compression = require('compression');
const rateLimit = require('express-rate-limit');

const { config: defaultConfig } = require('../config');
const { createLogger } = require('../lib/logger');
const { createAttemptStore } = require('../lib/attemptStore');
const { createRepository } = require('../repositories');
const { createPuzzleService } = require('../services/puzzleService');
const { createGameService } = require('../services/gameService');
const { createStatsService } = require('../services/statsService');
const { createAdminAuth } = require('./middleware/adminAuth');
const { createSessionMiddleware } = require('./middleware/session');
const { createAuthProvider } = require('../auth');
const { createAccountService } = require('../services/accountService');
const { createAuthRouter } = require('./routes/auth');
const { respond } = require('./middleware/respond');
const { requestContext } = require('./middleware/requestContext');
const { errorHandler, notFoundHandler } = require('./middleware/errors');
const { PUZZLE_TYPES, DIFFICULTIES, TYPE_LABELS, DIFFICULTY_LABELS } = require('../domain/constants');
const { createPagesRouter } = require('./routes/pages');
const { createApiRouter } = require('./routes/api');
const { createAdminApiRouter } = require('./routes/adminApi');

/**
 * Compose the application.
 *
 * Every dependency is created here and injected downward, so a test can hand in an in-memory
 * repository or a fake clock without a single module-level mock.
 *
 * @param {object} [overrides] repository/logger/config replacements for tests
 * @returns {import('express').Express} app, with `app.locals.container` holding the wiring
 */
function createApp(overrides = {}) {
  const config = overrides.config || defaultConfig;
  const logger = overrides.logger || createLogger({ level: config.logLevel, pretty: !config.isProduction });
  const repository = overrides.repository || createRepository({ logger });

  const attemptStore =
    overrides.attemptStore ||
    createAttemptStore({ ttlMs: config.play.attemptTtlMs, maxEntries: config.play.maxAttempts });

  const authProvider = overrides.authProvider || createAuthProvider({ driver: config.auth.driver, logger });

  const puzzleService = createPuzzleService({ repository });
  const statsService = createStatsService({ repository, logger });
  const gameService = createGameService({ repository, puzzleService, attemptStore, logger });
  const accountService = createAccountService({ repository, authProvider, logger });
  const adminAuth = createAdminAuth({ config, logger });
  const session = createSessionMiddleware({ config, repository, logger });

  const app = express();
  app.set('view engine', 'ejs');
  app.set('views', config.viewsDir);
  app.set('trust proxy', config.isProduction ? 1 : false);
  app.disable('x-powered-by');

  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'", 'https://cdn.jsdelivr.net'],
          styleSrc: ["'self'", "'unsafe-inline'"],
          imgSrc: ["'self'", 'data:'],
          connectSrc: ["'self'"],
          fontSrc: ["'self'", 'data:'],
          objectSrc: ["'none'"],
          frameAncestors: ["'self'"],
        },
      },
      // Charts are loaded from a CDN; the default same-origin policy would block them.
      crossOriginEmbedderPolicy: false,
    })
  );
  app.use(compression());
  app.use(express.json({ limit: '1mb' }));
  app.use(express.urlencoded({ extended: true, limit: '1mb' }));
  app.use(requestContext({ logger }));
  app.use(respond());

  app.use(
    express.static(config.publicDir, {
      maxAge: config.isProduction ? '7d' : 0,
      etag: true,
    })
  );

  const limiters = buildLimiters(config);
  if (limiters.api) app.use('/api/', limiters.api);

  // Defaults for every render: a view (notably the error page) can be reached from a code path
  // that never went through the pages router, so these must never be undefined in a template.
  app.locals.site = config.site;
  app.locals.driver = config.data.driver;
  app.locals.pageTitle = config.site.name;
  app.locals.pageDescription = 'Curated logic, math, word and lateral-thinking brain teasers.';
  app.locals.navActive = '';
  app.locals.types = PUZZLE_TYPES;
  app.locals.difficulties = DIFFICULTIES;
  app.locals.typeLabels = TYPE_LABELS;
  app.locals.difficultyLabels = DIFFICULTY_LABELS;

  // Resolves the player session before anything renders, so every template and route can read
  // res.locals.currentPlayer without asking for it.
  app.use(session.attach());

  app.use((req, res, next) => {
    // Templates need to know whether to show the admin nav item and the sign-out button.
    res.locals.isAdmin = adminAuth.isAuthorized(req);
    res.locals.currentPath = req.path;
    next();
  });

  app.use('/api/admin', createAdminApiRouter({ puzzleService, statsService, adminAuth }));
  app.use(
    '/api',
    createApiRouter({ puzzleService, gameService, statsService, accountService, repository, limiters })
  );
  app.use('/', createAuthRouter({ accountService, session, config, limiters }));
  app.use('/', createPagesRouter({ puzzleService, statsService, adminAuth, config }));

  /**
   * Liveness: is the process alive and able to answer?
   *
   * Deliberately checks nothing external. An orchestrator uses this to decide whether to KILL
   * the container, so a database blip must never fail it - that would turn a brief storage
   * outage into a restart loop that makes the outage worse.
   */
  app.get('/healthz', (req, res) => {
    res.json({ ok: true, status: 'up', uptimeSec: Math.round(process.uptime()) });
  });

  /**
   * Readiness: should this instance be sent traffic?
   *
   * This one does check storage, because an instance that cannot reach its database should be
   * pulled from the rotation - but not restarted.
   */
  app.get('/readyz', async (req, res) => {
    try {
      const health = await repository.healthCheck();
      if (!health.ok) {
        return res.status(503).json({ ok: false, status: 'not-ready', reason: 'storage unavailable' });
      }
      return res.json({ ok: true, status: 'ready', driver: health.driver });
    } catch (err) {
      return res.status(503).json({ ok: false, status: 'not-ready', reason: err.message });
    }
  });

  const publicOrigin = (req) => (config.site.baseUrl || `${req.protocol}://${req.get('host')}`).replace(/\/+$/, '');

  app.get('/robots.txt', (req, res) => {
    res
      .type('text/plain')
      .send(
        [
          'User-agent: *',
          'Disallow: /admin',
          'Disallow: /profile',
          'Disallow: /signin',
          'Disallow: /signup',
          'Disallow: /auth/',
          'Allow: /',
          '',
          `Sitemap: ${publicOrigin(req)}/sitemap.xml`,
          '',
        ].join('\n')
      );
  });

  app.get('/sitemap.xml', (req, res) => {
    // Only pages worth indexing: play surfaces are dynamic, account pages are private.
    const base = publicOrigin(req);
    const urls = ['/', '/play', '/daily', '/leaderboard', '/how-it-works']
      .map((path) => `  <url><loc>${base}${path}</loc><changefreq>daily</changefreq></url>`)
      .join('\n');

    res
      .type('application/xml')
      .send(
        `<?xml version="1.0" encoding="UTF-8"?>\n` +
          `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>\n`
      );
  });

  app.use(notFoundHandler());
  app.use(errorHandler({ logger }));

  app.locals.container = {
    repository,
    puzzleService,
    gameService,
    statsService,
    accountService,
    authProvider,
    attemptStore,
    session,
    logger,
    config,
  };

  return app;
}

/** Rate limits protect the scoring endpoint from brute-forcing answers. Off by default outside production. */
function buildLimiters(config) {
  if (!config.rateLimit.enabled) return { api: null, submit: null };
  const common = { standardHeaders: 'draft-7', legacyHeaders: false };
  return {
    api: rateLimit({
      ...common,
      windowMs: config.rateLimit.windowMs,
      limit: config.rateLimit.apiMax,
      message: { ok: false, error: 'Too many requests - slow down a moment.', code: 'rate_limited' },
    }),
    submit: rateLimit({
      ...common,
      windowMs: config.rateLimit.windowMs,
      limit: config.rateLimit.submitMax,
      message: { ok: false, error: 'Too many answers too fast - take a breath.', code: 'rate_limited' },
    }),
    // Sending email costs money and can be used to harass an inbox - keep this one tight.
    signIn: rateLimit({
      ...common,
      windowMs: 15 * 60 * 1000,
      limit: 5,
      message: { ok: false, error: 'Too many sign-in requests. Try again in a few minutes.', code: 'rate_limited' },
    }),
  };
}

module.exports = { createApp, PUBLIC_DIR: path.join(__dirname, '..', '..', 'public') };
