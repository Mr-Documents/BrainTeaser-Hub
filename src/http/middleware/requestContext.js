'use strict';

const crypto = require('crypto');

/**
 * Give every request an id and a child logger, and log how it finished. Makes a
 * production error report traceable back to a single line in the access log.
 */
function requestContext({ logger }) {
  return function requestContextMiddleware(req, res, next) {
    const id = req.get('x-request-id') || crypto.randomUUID();
    const startedAt = process.hrtime.bigint();
    req.id = id;
    req.log = logger.child ? logger.child({ requestId: id }) : logger;
    res.setHeader('x-request-id', id);

    res.on('finish', () => {
      const durationMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
      const level = res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'debug';
      req.log[level]?.(`${req.method} ${req.originalUrl}`, {
        status: res.statusCode,
        durationMs: Math.round(durationMs),
      });
    });

    next();
  };
}

module.exports = { requestContext };
