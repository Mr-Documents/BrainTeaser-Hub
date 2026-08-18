'use strict';

/**
 * Attach the two response shapes every API route uses, so no handler hand-rolls an envelope.
 * Success: { ok: true, data }.  Failure: { ok: false, error, code, details? }.
 */
function respond() {
  return function respondMiddleware(req, res, next) {
    res.ok = (data, status = 200) => res.status(status).json({ ok: true, data });
    res.fail = (status, error, code = 'error', details) =>
      res.status(status).json({ ok: false, error, code, ...(details ? { details } : {}) });
    next();
  };
}

module.exports = { respond };
