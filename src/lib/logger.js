'use strict';

const LEVELS = { silent: 100, error: 40, warn: 30, info: 20, debug: 10 };

/**
 * A dependency-free structured logger. One JSON line per event in production so a log
 * shipper can parse it; a readable single line in development.
 */
function createLogger({ level = 'info', pretty = true, sink = console } = {}) {
  const threshold = LEVELS[level] ?? LEVELS.info;

  const write = (levelName, message, fields) => {
    if ((LEVELS[levelName] ?? 0) < threshold) return;
    const entry = { level: levelName, time: new Date().toISOString(), message, ...fields };
    const target = levelName === 'error' ? sink.error : sink.log;
    if (pretty) {
      const extras = fields && Object.keys(fields).length ? ` ${JSON.stringify(fields)}` : '';
      target.call(sink, `${levelName.toUpperCase().padEnd(5)} ${message}${extras}`);
    } else {
      target.call(sink, JSON.stringify(entry));
    }
  };

  return {
    level,
    error: (message, fields) => write('error', message, fields),
    warn: (message, fields) => write('warn', message, fields),
    info: (message, fields) => write('info', message, fields),
    debug: (message, fields) => write('debug', message, fields),
    child: (bound) => {
      const base = createLogger({ level, pretty, sink });
      return {
        level,
        error: (m, f) => base.error(m, { ...bound, ...f }),
        warn: (m, f) => base.warn(m, { ...bound, ...f }),
        info: (m, f) => base.info(m, { ...bound, ...f }),
        debug: (m, f) => base.debug(m, { ...bound, ...f }),
        child: (more) => base.child({ ...bound, ...more }),
      };
    },
  };
}

module.exports = { createLogger, LEVELS };
