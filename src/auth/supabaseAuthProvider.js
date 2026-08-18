'use strict';

const { createClient } = require('@supabase/supabase-js');
const { AppError, BadRequestError } = require('../lib/errors');

/**
 * Supabase Auth, driven entirely from the server.
 *
 * The browser never loads the Supabase SDK and never holds a Supabase JWT: we start the flow,
 * verify what comes back, and then issue our own signed session cookie. That keeps the CSP tight
 * (no third-party connect-src), keeps tokens out of reach of any XSS, and means the rest of the
 * app only ever deals with one notion of "session".
 */
function createSupabaseAuthProvider({ url, key, oauthProviders = [], logger = console, client = null } = {}) {
  /**
   * supabase-js keeps the PKCE code verifier in its `storage`. In a browser that is
   * localStorage; on a server there is nowhere durable to put it, and it must survive the
   * round trip to Google anyway. So: back it with a plain Map we can read out after starting
   * the flow, hand the contents to the caller to store in a signed cookie, and load them back
   * before exchanging the code.
   */
  function createMemoryStorage() {
    const map = new Map();
    return {
      map,
      getItem: (k) => (map.has(k) ? map.get(k) : null),
      setItem: (k, v) => map.set(k, v),
      removeItem: (k) => map.delete(k),
    };
  }

  const storage = createMemoryStorage();

  const db =
    client ||
    createClient(url, key, {
      auth: {
        persistSession: true, // required for PKCE - the verifier has to be written somewhere
        autoRefreshToken: false,
        detectSessionInUrl: false,
        flowType: 'pkce',
        storage,
      },
    });

  const fail = (error, context) => {
    logger.error?.(`supabase auth ${context} failed`, { message: error.message, status: error.status });
    // Supabase surfaces both "you asked too often" and genuine faults here; the former is the
    // one a player can act on, so it keeps its own status.
    if (error.status === 429) {
      throw new AppError('Too many sign-in attempts. Wait a minute and try again.', 429, 'rate_limited');
    }
    throw new AppError('Could not reach the sign-in service. Try again shortly.', 502, 'auth_unavailable');
  };

  const identityFrom = (user) => {
    if (!user?.id) throw new BadRequestError('That sign-in is no longer valid.');
    return {
      userId: user.id,
      email: user.email || '',
      // Google supplies a name and avatar; a magic link supplies neither.
      name: user.user_metadata?.full_name || user.user_metadata?.name || '',
    };
  };

  return {
    name: 'supabase',
    oauthProviders,

    // ------------------------------------------------------------ magic link

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
     * @returns {Promise<{ userId: string, email: string, name: string }>}
     */
    async verifyMagicLink(tokenHash, type = 'email') {
      if (!tokenHash) throw new BadRequestError('That sign-in link is missing its token.');

      const { data, error } = await db.auth.verifyOtp({ token_hash: tokenHash, type });
      if (error) {
        // An expired or already-used link is the common case and is the visitor's to fix, not
        // an outage - say so plainly rather than returning a 502.
        throw new BadRequestError('That sign-in link has expired or was already used. Request a new one.');
      }
      return identityFrom(data?.user);
    },

    // ----------------------------------------------------------------- OAuth

    /**
     * Begin an OAuth handshake.
     * @returns {Promise<{ url: string, pkce: Record<string,string> }>} `pkce` must be handed
     *   back to completeOAuth; the caller is responsible for storing it somewhere the visitor
     *   cannot read or alter (we use a signed, httpOnly cookie).
     */
    async startOAuth(provider, redirectTo) {
      storage.map.clear();

      const { data, error } = await db.auth.signInWithOAuth({
        provider,
        options: { redirectTo, skipBrowserRedirect: true },
      });
      if (error) fail(error, 'startOAuth');
      if (!data?.url) throw new AppError('The sign-in provider did not return a URL.', 502, 'auth_unavailable');

      // Snapshot whatever supabase-js wrote rather than guessing its key names, so an internal
      // rename in the SDK cannot silently break the exchange.
      return { url: data.url, pkce: Object.fromEntries(storage.map) };
    },

    /**
     * Finish an OAuth handshake.
     * @param {string} code the ?code= value the provider redirected back with
     * @param {Record<string,string>} pkce whatever startOAuth returned
     */
    async completeOAuth(code, pkce = {}) {
      if (!code) throw new BadRequestError('That sign-in is missing its code.');

      storage.map.clear();
      for (const [k, v] of Object.entries(pkce)) storage.map.set(k, v);

      const { data, error } = await db.auth.exchangeCodeForSession(code);
      storage.map.clear();

      if (error) {
        throw new BadRequestError('That sign-in could not be completed. Please try again.');
      }
      return identityFrom(data?.user);
    },

    // ----------------------------------------------------------------- admin

    async getUser(userId) {
      const { data, error } = await db.auth.admin.getUserById(userId);
      if (error || !data?.user) return null;
      return identityFrom(data.user);
    },

    async deleteUser(userId) {
      const { error } = await db.auth.admin.deleteUser(userId);
      if (error) fail(error, 'deleteUser');
      return true;
    },
  };
}

module.exports = { createSupabaseAuthProvider };
