'use strict';

const express = require('express');
const { asyncHandler } = require('../middleware/asyncHandler');

/** Only ever redirect to a path on this site - never to whatever a query string asked for. */
function safeNext(value, fallback = '/play') {
  const target = String(value || '');
  return target.startsWith('/') && !target.startsWith('//') ? target : fallback;
}

/**
 * Sign-in, sign-out, and the player account.
 *
 * With a magic link there is only one flow: the same email either signs you in or creates the
 * account. /signin and /signup therefore serve the same page and post to the same handler, and
 * differ only in the copy - which is what a visitor arriving from either link expects to read.
 *
 * Nothing here gates play. Every game route works signed out.
 */
function createAuthRouter({ accountService, session, config, limiters }) {
  const router = express.Router();
  const signInLimiter = limiters?.signIn || ((req, res, next) => next());

  const authLocals = (overrides = {}) => ({
    navActive: 'account',
    pageTitle: `Sign in · ${config.site.name}`,
    pageDescription: 'Sign in to claim your place on the leaderboard and keep your streak.',
    mode: 'signin',
    next: '/play',
    sent: false,
    email: '',
    error: null,
    devLink: null,
    oauthProviders: accountService.oauthProviders,
    ...overrides,
  });

  /** Absolute URL Supabase (or the local provider) sends the player back to. */
  const callbackUrl = (req, next) =>
    new URL(
      `/auth/callback?next=${encodeURIComponent(next)}`,
      config.site.baseUrl || `${req.protocol}://${req.get('host')}`
    ).href;

  function renderAuth(req, res, locals, status = 200) {
    const mode = locals.mode || 'signin';
    return res.status(status).render(
      'signin',
      authLocals({
        ...locals,
        pageTitle: `${mode === 'signup' ? 'Create an account' : 'Sign in'} · ${config.site.name}`,
      })
    );
  }

  // ------------------------------------------------------------------ sign in

  for (const [path, mode] of [
    ['/signin', 'signin'],
    ['/signup', 'signup'],
  ]) {
    router.get(path, (req, res) => {
      if (req.session?.userId) return res.redirect('/profile');
      return renderAuth(req, res, {
        mode,
        next: safeNext(req.query.next),
        email: typeof req.query.email === 'string' ? req.query.email : '',
        // An expired link bounces back here with a reason, so the dead end is recoverable.
        error: typeof req.query.error === 'string' ? req.query.error : null,
      });
    });
  }

  const handleSignInRequest = asyncHandler(async (req, res) => {
    const mode = req.body?.mode === 'signup' ? 'signup' : 'signin';
    const next = safeNext(req.body?.next);
    const email = String(req.body?.email || '');

    try {
      const result = await accountService.requestSignInLink({ email, redirectTo: callbackUrl(req, next) });
      return renderAuth(req, res, {
        mode,
        next,
        email,
        sent: true,
        // Only ever populated by the local driver, so a developer can sign in without email.
        devLink: result.devLink || null,
      });
    } catch (err) {
      return renderAuth(req, res, { mode, next, email, error: err.message }, err.status || 400);
    }
  });

  router.post('/signin', signInLimiter, handleSignInRequest);
  router.post('/signup', signInLimiter, handleSignInRequest);

  // -------------------------------------------------------------------- OAuth

  /**
   * Hand the visitor off to the provider.
   *
   * POST rather than GET: a link would let another site start a handshake on a visitor's
   * behalf, and browsers prefetch links. A form post cannot be triggered cross-site with
   * cookies attached under SameSite=lax.
   */
  router.post(
    '/auth/:provider/start',
    signInLimiter,
    asyncHandler(async (req, res) => {
      const next = safeNext(req.body?.next);
      const provider = req.params.provider;

      try {
        const { url, pkce } = await accountService.startOAuth({
          provider,
          redirectTo: callbackUrl(req, next),
        });
        // The verifier must survive the trip out and back, unreadable and unalterable.
        session.startHandshake(res, { pkce, provider, next });
        return res.redirect(url);
      } catch (err) {
        return renderAuth(req, res, { next, error: err.message }, err.status || 400);
      }
    })
  );

  /**
   * The single way in. Handles both arrivals:
   *   ?token_hash=  a magic link from email
   *   ?code=        a return trip from an OAuth provider
   * Both end at the same place, so account creation and redirect behaviour cannot drift apart.
   */
  router.get(
    '/auth/callback',
    asyncHandler(async (req, res) => {
      const handshake = session.readHandshake(req);
      const next = safeNext(req.query.next || handshake?.next);
      const code = typeof req.query.code === 'string' ? req.query.code : '';
      const tokenHash = String(req.query.token_hash || req.query.token || '');

      const bounce = (message) =>
        res.redirect(`/signin?next=${encodeURIComponent(next)}&error=${encodeURIComponent(message)}`);

      // The provider reports its own failures (a cancelled consent screen, most often) here.
      if (req.query.error) {
        session.endHandshake(res);
        const description = String(req.query.error_description || 'Sign-in was cancelled.');
        return bounce(description);
      }

      try {
        let result;
        if (code) {
          if (!handshake?.pkce) {
            // No handshake cookie means this callback did not start in this browser.
            return bounce('That sign-in could not be completed. Please start again.');
          }
          result = await accountService.completeOAuth({ code, pkce: handshake.pkce });
          session.endHandshake(res);
        } else {
          result = await accountService.completeSignIn({ tokenHash, type: String(req.query.type || 'email') });
        }

        session.issue(res, result.userId);
        // A brand new account lands on the profile so they can choose a display name right away.
        return res.redirect(result.isNewAccount ? '/profile?welcome=1' : next);
      } catch (err) {
        session.endHandshake(res);
        // Send them back to a form they can actually act on rather than a dead error page.
        return bounce(err.message);
      }
    })
  );

  router.post('/signout', (req, res) => {
    session.clear(res);
    res.redirect('/');
  });

  // ------------------------------------------------------------------ account

  const renderProfile = async (req, res, extra = {}, status = 200) => {
    const profile = await accountService.getProfile(req.session.userId);
    return res.status(status).render('profile', {
      navActive: 'account',
      pageTitle: `${profile.displayName} · ${config.site.name}`,
      pageDescription: 'Your points, solves and streak.',
      profile,
      welcome: false,
      saved: false,
      error: null,
      ...extra,
    });
  };

  router.get(
    '/profile',
    session.requireSession(),
    asyncHandler(async (req, res) =>
      renderProfile(req, res, { welcome: req.query.welcome === '1', saved: req.query.saved === '1' })
    )
  );

  router.post(
    '/profile/name',
    session.requireSession(),
    asyncHandler(async (req, res) => {
      try {
        await accountService.changeDisplayName(req.session.userId, req.body?.displayName);
        return res.redirect('/profile?saved=1');
      } catch (err) {
        return renderProfile(req, res, { error: err.message }, err.status || 400);
      }
    })
  );

  router.post(
    '/profile/delete',
    session.requireSession(),
    asyncHandler(async (req, res) => {
      // Typing the display name is the confirmation step - a destructive action should take
      // more than one careless click.
      const profile = await accountService.getProfile(req.session.userId);
      const typed = String(req.body?.confirm || '').trim();

      if (typed.toLowerCase() !== profile.displayName.toLowerCase()) {
        return renderProfile(req, res, { error: `Type "${profile.displayName}" exactly to confirm deletion.` }, 400);
      }

      await accountService.deleteAccount(req.session.userId);
      session.clear(res);
      return res.redirect('/?deleted=1');
    })
  );

  return router;
}

module.exports = { createAuthRouter, safeNext };
