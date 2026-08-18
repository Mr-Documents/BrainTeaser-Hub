'use strict';

const { createCookieSigner, parseCookies } = require('../../lib/signedCookie');
const { UnauthorizedError } = require('../../lib/errors');

/**
 * Player sessions.
 *
 * The cookie carries nothing but a user id and an expiry, signed. It is not a Supabase JWT -
 * the browser never sees one - so a leaked cookie grants access to this app only, and revoking
 * it is a matter of rotating SESSION_SECRET.
 *
 * Every request gets `req.session` (null when signed out) and `res.locals.currentPlayer`, so a
 * template can render the signed-in state without any route having to fetch it.
 */
function createSessionMiddleware({ config, repository, logger = console }) {
  const { cookieName, sessionMaxAgeMs } = config.auth;
  // In development a missing secret must not crash the app; a random per-boot key simply means
  // sessions do not survive a restart. Production refuses to boot without one (see validateConfig).
  const secret = config.auth.sessionSecret || require('crypto').randomBytes(32).toString('hex');
  const signer = createCookieSigner(secret, 'player-session');

  const cookieOptions = {
    httpOnly: true,
    sameSite: 'lax',
    secure: config.isProduction,
    path: '/',
  };

  function issue(res, userId) {
    res.cookie(cookieName, signer.pack({ userId }, sessionMaxAgeMs), {
      ...cookieOptions,
      maxAge: sessionMaxAgeMs,
    });
  }

  function clear(res) {
    res.clearCookie(cookieName, cookieOptions);
  }

  /**
   * Resolve the session on every request. Attaches the player row too, because almost every
   * consumer needs the display name, and a signed-out request costs nothing.
   */
  function attach() {
    return async function attachSession(req, res, next) {
      req.session = null;
      res.locals.currentPlayer = null;
      res.locals.isSignedIn = false;

      const raw = parseCookies(req.get('cookie'))[cookieName];
      const payload = signer.unpack(raw);
      if (!payload?.userId) return next();

      try {
        const player = await repository.getPlayer(payload.userId);
        if (!player) {
          // The account was deleted while the cookie was still valid - drop it rather than
          // leaving the browser in a half-signed-in state.
          clear(res);
          return next();
        }
        req.session = { userId: payload.userId };
        req.player = player;
        res.locals.currentPlayer = {
          displayName: player.displayName,
          totalScore: player.totalScore,
          currentStreak: player.currentStreak,
        };
        res.locals.isSignedIn = true;
      } catch (err) {
        // A storage blip must not sign everyone out of a page they could otherwise read.
        logger.warn?.('could not resolve session', { error: err.message });
      }
      return next();
    };
  }

  /** Guard for routes that genuinely need an account (profile, name changes). */
  function require$() {
    return function requireSession(req, res, next) {
      if (req.session?.userId) return next();
      if (req.path.startsWith('/api/')) return next(new UnauthorizedError('Sign in to do that.'));
      return res.redirect(`/signin?next=${encodeURIComponent(req.originalUrl)}`);
    };
  }

  return { attach, issue, clear, requireSession: require$ };
}

module.exports = { createSessionMiddleware };
