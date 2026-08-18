'use strict';

const { createApp } = require('./http/app');
const { config, validateConfig } = require('./config');
const { createLogger } = require('./lib/logger');

const logger = createLogger({ level: config.logLevel, pretty: !config.isProduction });

function start() {
  let warnings;
  try {
    warnings = validateConfig(config);
  } catch (err) {
    logger.error(`Configuration error: ${err.message}`);
    process.exit(1);
    return;
  }
  warnings.forEach((w) => logger.warn(w));

  const app = createApp({ logger });
  const server = app.listen(config.port, () => {
    logger.info(`${config.site.name} listening`, {
      url: `http://localhost:${config.port}`,
      env: config.env,
      driver: config.data.driver,
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

  // Drain in-flight requests before exiting so a deploy never truncates a response mid-write.
  const shutdown = (signal) => async () => {
    logger.info(`${signal} received - shutting down`);
    server.close(async () => {
      await app.locals.container.repository.flush?.().catch(() => {});
      process.exit(0);
    });
    setTimeout(() => process.exit(1), 10_000).unref();
  };
  process.on('SIGTERM', shutdown('SIGTERM'));
  process.on('SIGINT', shutdown('SIGINT'));

  return server;
}

if (require.main === module) start();

module.exports = { start };
