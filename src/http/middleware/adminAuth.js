'use strict';

const crypto = require('crypto');
const { UnauthorizedError } = require('../../lib/errors');

/** Constant-time string compare that tolerates differing lengths without leaking them. */
function safeEqual(a, b) {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  if (bufA.length !== bufB.length) {
    // Still burn a comparison so timing does not reveal the length mismatch.
    crypto.timingSafeEqual(bufA, bufA);
    return false;
  }
  return crypto.timingSafeEqual(bufA, bufB);
}

function parseCookies(header = '') {
  const jar = {};
  for (const part of String(header).split(';')) {
    const index = part.indexOf('=');
    if (index === -1) continue;
    const key = part.slice(0, index).trim();
    if (key) jar[key] = decodeURIComponent(part.slice(index + 1).trim());
  }
  return jar;
}

/**
 * Admin session handling.
 *
 * Auth is a single shared token (ADMIN_TOKEN) - right-sized for an MVP with one operator, and
 * swappable for Supabase Auth later without touching the routes. Presenting the token once
 * exchanges it for a signed, expiring cookie so it is not re-sent on every request.
 */
function createAdminAuth({ config, logger = console }) {
  const secret = config.admin.token || crypto.randomBytes(32).toString('hex');
  const { cookieName, sessionMaxAgeMs } = config.admin;

  const sign = (expiresAt) => crypto.createHmac('sha256', secret).update(String(expiresAt)).digest('hex');

  function issueSession(res) {
    const expiresAt = Date.now() + sessionMaxAgeMs;
    const value = `${expiresAt}.${sign(expiresAt)}`;
    res.cookie?.(cookieName, value, {
      httpOnly: true,
      sameSite: 'lax',
      secure: config.isProduction,
      maxAge: sessionMaxAgeMs,
      path: '/',
    });
    return value;
  }

  function clearSession(res) {
    res.clearCookie?.(cookieName, { path: '/' });
  }

  function hasValidSession(req) {
    const cookies = parseCookies(req.get?.('cookie'));
    const raw = cookies[cookieName];
    if (!raw) return false;
    const [expiresAt, signature] = raw.split('.');
    if (!expiresAt || !signature) return false;
    if (Number(expiresAt) < Date.now()) return false;
    return safeEqual(signature, sign(Number(expiresAt)));
  }

  function presentedToken(req) {
    const header = req.get?.('authorization') || '';
    if (header.toLowerCase().startsWith('bearer ')) return header.slice(7).trim();
    return req.get?.('x-admin-token') || req.body?.adminToken || '';
  }

  /** @returns {boolean} whether the request is allowed to perform admin actions. */
  function isAuthorized(req) {
    if (!config.admin.required) return true;
    if (!config.admin.token) return false;
    if (hasValidSession(req)) return true;
    const token = presentedToken(req);
    return Boolean(token) && safeEqual(token, config.admin.token);
  }

  return {
    isAuthorized,
    issueSession,
    clearSession,

    /** Verify a login attempt and start a session. */
    login(req, res, token) {
      if (!config.admin.token) {
        logger.warn?.('admin login attempted with no ADMIN_TOKEN configured');
        return false;
      }
      if (!safeEqual(String(token || ''), config.admin.token)) return false;
      issueSession(res);
      return true;
    },

    /** Guard for API routes - 401 JSON when unauthorized. */
    requireApi() {
      return function requireAdminApi(req, res, next) {
        if (isAuthorized(req)) return next();
        next(
          new UnauthorizedError(
            'Admin token required. Send it as "Authorization: Bearer <token>" or sign in at /admin/login.'
          )
        );
      };
    },

    /** Guard for pages - redirect to the login screen instead of a raw 401. */
    requirePage() {
      return function requireAdminPage(req, res, next) {
        if (isAuthorized(req)) return next();
        const next_ = encodeURIComponent(req.originalUrl);
        res.redirect(`/admin/login?next=${next_}`);
      };
    },
  };
}

module.exports = { createAdminAuth, safeEqual, parseCookies };
