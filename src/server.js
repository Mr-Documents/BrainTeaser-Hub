'use strict';

const { createApp } = require('./http/app');
const { config, validateConfig } = require('./config');
const { createLogger } = require('./lib/logger');
const { createErrorReporter } = require('./lib/errorReporter');

const logger = createLogger({ level: config.logLevel, pretty: !config.isProduction });
const reporter = createErrorReporter({
  logger,
  env: config.env,
  // Most hosts expose the deployed commit under some name; whichever exists ties a crash
  // report back to an actual build.
  release: process.env.RELEASE || process.env.RAILWAY_GIT_COMMIT_SHA || process.env.RENDER_GIT_COMMIT || null,
});

/** How long to let in-flight requests finish before exiting anyway. */
const SHUTDOWN_GRACE_MS = Number(process.env.SHUTDOWN_GRACE_MS) || 10_000;

function start() {
  let warnings;
  try {
    warnings = validateConfig(config);
  } catch (err) {
    logger.error(`Configuration error: ${err.message}`);
    process.exit(1);
    return undefined;
  }
  warnings.forEach((w) => logger.warn(w));

  const app = createApp({ logger });
  const server = app.listen(config.port, () => {
    logger.info(`${config.site.name} listening`, {
      url: config.site.baseUrl || `http://localhost:${config.port}`,
      env: config.env,
      driver: config.data.driver,
      auth: config.auth.driver,
      node: process.version,
    });
  });

  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      logger.error(
        `Port ${config.port} is already in use. Stop the other process, or start with PORT=3001 npm run dev`
      );
    } else {
      logger.error('Server failed to start', { error: err.message });
    }
    process.exit(1);
  });

  // ---------------------------------------------------------------- shutdown

  let shuttingDown = false;

  /**
   * Drain in-flight requests before exiting, so a rolling deploy never truncates a response
   * mid-write. A second signal exits immediately - if an operator asks twice, they mean it.
   */
  const shutdown = (signal) => async () => {
    if (shuttingDown) {
      logger.warn(`${signal} received again - exiting now`);
      process.exit(1);
      return;
    }
    shuttingDown = true;
    logger.info(`${signal} received - draining connections`);

    const forceExit = setTimeout(() => {
      logger.error(`Did not finish draining within ${SHUTDOWN_GRACE_MS}ms - forcing exit`);
      process.exit(1);
    }, SHUTDOWN_GRACE_MS);
    forceExit.unref();

    server.close(async () => {
      try {
        await app.locals.container.repository.flush?.();
      } catch (err) {
        logger.warn('flush failed during shutdown', { error: err.message });
      }
      logger.info('Shutdown complete');
      process.exit(0);
    });
  };

  process.on('SIGTERM', shutdown('SIGTERM'));
  process.on('SIGINT', shutdown('SIGINT'));

  // ----------------------------------------------------- last-resort handlers

  /**
   * An uncaught exception leaves the process in an unknown state, so the only safe response is
   * to report it and let the orchestrator start a clean one. Staying alive risks serving
   * corrupted state to real players.
   */
  process.on('uncaughtException', (err) => {
    reporter.report(err, { fatal: true, source: 'uncaughtException' });
    setTimeout(() => process.exit(1), 100).unref();
  });

  /**
   * A rejected promise nobody handled is a bug, but not necessarily a corrupted process - so it
   * is reported loudly and the server keeps serving. Node's default here is to crash, which
   * would let one stray rejection take down an otherwise healthy instance.
   */
  process.on('unhandledRejection', (reason) => {
    const err = reason instanceof Error ? reason : new Error(String(reason));
    reporter.report(err, { fatal: false, source: 'unhandledRejection' });
  });

  return server;
}

if (require.main === module) start();

module.exports = { start };
