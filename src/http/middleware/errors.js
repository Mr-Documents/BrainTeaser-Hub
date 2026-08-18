'use strict';

const { AppError, NotFoundError } = require('../../lib/errors');

/** Requests under these prefixes get JSON errors; everything else gets an HTML error page. */
const wantsJson = (req) => req.path.startsWith('/api/') || req.get('accept')?.includes('application/json') || req.xhr;

/** 404 for anything no route claimed. Mounted last, before the error handler. */
function notFoundHandler() {
  return function notFound(req, res, next) {
    next(new NotFoundError(`No route for ${req.method} ${req.path}`));
  };
}

/**
 * The single place an error becomes a response.
 *
 * Expected errors (AppError subclasses) keep their message and status. Anything else is logged
 * with its stack and reported as a generic 500 — internal details never reach the client.
 */
function errorHandler({ logger }) {
  // Four parameters is what marks this as Express error middleware — do not trim `next`.
  return function handleError(err, req, res, next) {
    const expected = err instanceof AppError;
    const status = expected ? err.status : 500;
    const code = expected ? err.code : 'internal_error';
    const message = expected ? err.message : 'Something went wrong on our side.';

    const log = req.log || logger;
    if (status >= 500) log.error?.(err.message, { stack: err.stack, path: req.path });
    else log.warn?.(err.message, { path: req.path, code });

    if (res.headersSent) return next(err);

    if (wantsJson(req)) {
      // The stack is logged above but never serialised — it can name internal paths and secrets.
      return res.status(status).json({
        ok: false,
        error: message,
        code,
        ...(err.details ? { details: err.details } : {}),
      });
    }

    return res.status(status).render('error', {
      navActive: '',
      pageTitle: `${status} · Brain Teaser Hub`,
      status,
      message,
      detail: status === 404 ? 'The page or puzzle you asked for does not exist.' : null,
    });
  };
}

module.exports = { errorHandler, notFoundHandler };
