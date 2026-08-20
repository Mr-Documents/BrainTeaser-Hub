'use strict';

/**
 * Where crashes go.
 *
 * Deliberately not a Sentry dependency. An MVP does not need a vendor SDK in its lockfile, but
 * it does need one obvious place that every unexpected error passes through - so that adding
 * Sentry (or Rollbar, or Better Stack) later is a ten-line change here rather than a hunt
 * through every catch block.
 *
 * The default implementation logs. That is genuinely enough on a host that retains stdout
 * (Fly, Render, Railway, Cloud Run all do).
 */

/** Strip anything that must never leave the process, whatever the sink turns out to be. */
const REDACTED_KEYS = /token|secret|key|password|cookie|authorization|session/i;

function redact(value, depth = 0, seen = new WeakSet()) {
  if (value == null || typeof value !== 'object') return value;

  // A depth cap alone would stop the recursion but leave a cycle in the result, which then
  // throws inside whichever sink tries to serialise it. Tracking seen objects means the output
  // is always safe to JSON.stringify.
  if (seen.has(value)) return '[circular]';
  if (depth > 6) return '[truncated]';
  seen.add(value);

  if (Array.isArray(value)) return value.map((item) => redact(item, depth + 1, seen));
  if (value instanceof Error) return { name: value.name, message: value.message };

  const out = {};
  for (const [key, val] of Object.entries(value)) {
    out[key] = REDACTED_KEYS.test(key) ? '[redacted]' : redact(val, depth + 1, seen);
  }
  return out;
}

/**
 * @param {object} options
 * @param {object} options.logger
 * @param {(event: object) => void} [options.sink] where to forward a report; defaults to logging
 * @param {string} [options.release] a build identifier, so a report can be tied to a deploy
 */
function createErrorReporter({ logger, sink = null, release = null, env = 'development' } = {}) {
  let reported = 0;

  /**
   * @param {Error} error
   * @param {object} [context] request id, route, user - never credentials
   */
  function report(error, context = {}) {
    reported += 1;
    const event = {
      message: error?.message || String(error),
      stack: error?.stack,
      name: error?.name,
      release,
      env,
      context: redact(context),
      at: new Date().toISOString(),
    };

    if (sink) {
      try {
        sink(event);
      } catch (sinkError) {
        // A broken reporter must never become the thing that takes the process down.
        logger.error?.('error reporter sink failed', { error: sinkError.message });
      }
    }

    logger.error?.(event.message, { stack: event.stack, ...event.context });
    return event;
  }

  return {
    report,
    get count() {
      return reported;
    },
  };
}

module.exports = { createErrorReporter, redact };
