'use strict';

const { createClient } = require('@supabase/supabase-js');
const { AppError, BadRequestError } = require('../lib/errors');

/**
 * Supabase Auth, driven entirely from the server.
 *
 * The browser never loads the Supabase SDK and never holds a Supabase JWT: we send the magic
 * link, verify the returned token here, and then issue our own signed session cookie. That keeps
 * the CSP tight (no third-party connect-src), keeps tokens out of reach of any XSS, and means the
 * rest of the app only ever deals with one notion of "session".
 */
function createSupabaseAuthProvider({ url, key, logger = console, client = null } = {}) {
  const db =
    client ||
    createClient(url, key, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    });

  const fail = (error, context) => {
    logger.error?.(`supabase auth ${context} failed`, { message: error.message, status: error.status });
    // Supabase surfaces both "you asked too often" and genuine faults here; the former is the
    // one a player can act on, so it keeps its own status.
    if (error.status === 429) {
      throw new AppError('Too many sign-in emails requested. Wait a minute and try again.', 429, 'rate_limited');
    }
    throw new AppError('Could not reach the sign-in service. Try again shortly.', 502, 'auth_unavailable');
  };

  return {
    name: 'supabase',

    /**
     * Email a one-time sign-in link. Creates the user on first use.
     * @param {string} email
     * @param {string} redirectTo absolute URL Supabase sends the user back to
     */
    async sendMagicLink(email, redirectTo) {
      const { error } = await db.auth.signInWithOtp({
        email,
        options: { emailRedirectTo: redirectTo, shouldCreateUser: true },
      });
      if (error) fail(error, 'sendMagicLink');
      return { sent: true };
    },

    /**
     * Exchange the token hash from the emailed link for a verified identity.
     * @param {string} tokenHash
     * @param {string} [type] Supabase OTP type - 'email' covers both sign-up and sign-in links
     * @returns {Promise<{ userId: string, email: string }>}
     */
    async verifyMagicLink(tokenHash, type = 'email') {
      if (!tokenHash) throw new BadRequestError('That sign-in link is missing its token.');

      const { data, error } = await db.auth.verifyOtp({ token_hash: tokenHash, type });
      if (error) {
        // An expired or already-used link is the common case and is the user's problem to fix,
        // not an outage - say so plainly rather than returning a 502.
        throw new BadRequestError('That sign-in link has expired or was already used. Request a new one.');
      }
      const user = data?.user;
      if (!user?.id) throw new BadRequestError('That sign-in link is no longer valid.');
      return { userId: user.id, email: user.email || '' };
    },

    /** @returns {Promise<{ userId: string, email: string }|null>} */
    async getUser(userId) {
      const { data, error } = await db.auth.admin.getUserById(userId);
      if (error || !data?.user) return null;
      return { userId: data.user.id, email: data.user.email || '' };
    },

    async deleteUser(userId) {
      const { error } = await db.auth.admin.deleteUser(userId);
      if (error) fail(error, 'deleteUser');
      return true;
    },
  };
}

module.exports = { createSupabaseAuthProvider };
