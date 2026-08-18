'use strict';

const crypto = require('crypto');
const { BadRequestError } = require('../lib/errors');

/**
 * An in-process implementation of the same auth contract.
 *
 * Two jobs:
 *  - it is what the test suite runs against, so the whole sign-in flow is exercised for real
 *    (link issued -> link verified -> session cookie -> ranked solve) with no network;
 *  - it lets the app run end to end on a fresh clone with no Supabase project, by printing the
 *    magic link to the log instead of emailing it.
 *
 * It is refused in production by validateConfig(), because it will sign in anyone who can read
 * the server log.
 */
function createLocalAuthProvider({ logger = console, onLink = null, oauthProviders = ['google'] } = {}) {
  /** @type {Map<string, { userId: string, email: string, expiresAt: number, used: boolean }>} */
  const pendingLinks = new Map();
  /** @type {Map<string, { userId: string, email: string }>} keyed by lowercased email */
  const users = new Map();

  const LINK_TTL_MS = 15 * 60 * 1000;

  const normalizeEmail = (email) =>
    String(email || '')
      .trim()
      .toLowerCase();

  function upsertUser(email) {
    const key = normalizeEmail(email);
    let user = users.get(key);
    if (!user) {
      user = { userId: crypto.randomUUID(), email: key };
      users.set(key, user);
    }
    return user;
  }

  /** @type {Map<string, { provider: string, email: string, verifier: string }>} */
  const pendingOAuth = new Map();

  return {
    name: 'local',
    oauthProviders,

    async sendMagicLink(email, redirectTo) {
      const user = upsertUser(email);
      const tokenHash = crypto.randomBytes(24).toString('hex');
      pendingLinks.set(tokenHash, {
        userId: user.userId,
        email: user.email,
        expiresAt: Date.now() + LINK_TTL_MS,
        used: false,
      });

      const separator = redirectTo.includes('?') ? '&' : '?';
      const link = `${redirectTo}${separator}token_hash=${tokenHash}&type=email`;

      logger.warn?.('LOCAL AUTH - no email was sent. Open this link to sign in:', { email: user.email, link });
      onLink?.({ email: user.email, link, tokenHash });

      return { sent: true, link, tokenHash };
    },

    async verifyMagicLink(tokenHash) {
      const pending = pendingLinks.get(tokenHash);
      const expired = new BadRequestError('That sign-in link has expired or was already used. Request a new one.');
      if (!pending) throw expired;
      if (pending.used || pending.expiresAt < Date.now()) {
        pendingLinks.delete(tokenHash);
        throw expired;
      }
      // Single use: a link that leaks from an inbox or a log cannot be replayed.
      pending.used = true;
      pendingLinks.delete(tokenHash);
      return { userId: pending.userId, email: pending.email, name: '' };
    },

    /**
     * Simulates a provider handshake without leaving the machine: hands back a URL that points
     * straight at our own callback with a fake code. Exercises exactly the same route, cookie
     * and error handling as the real thing.
     */
    async startOAuth(provider, redirectTo) {
      const code = crypto.randomBytes(18).toString('hex');
      const verifier = crypto.randomBytes(32).toString('hex');
      const email = `${provider}-user@example.com`;
      pendingOAuth.set(code, { provider, email, verifier });

      const separator = redirectTo.includes('?') ? '&' : '?';
      const url = `${redirectTo}${separator}code=${code}`;
      logger.warn?.(`LOCAL AUTH - simulating ${provider} sign-in`, { email });
      return { url, pkce: { 'local-code-verifier': verifier } };
    },

    async completeOAuth(code, pkce = {}) {
      const pending = pendingOAuth.get(code);
      // The verifier check is what proves the callback belongs to the browser that started the
      // flow - the same property PKCE gives us against the real provider.
      if (!pending || pkce['local-code-verifier'] !== pending.verifier) {
        throw new BadRequestError('That sign-in could not be completed. Please try again.');
      }
      pendingOAuth.delete(code);

      const user = upsertUser(pending.email);
      return { userId: user.userId, email: user.email, name: '' };
    },

    async getUser(userId) {
      for (const user of users.values()) if (user.userId === userId) return { ...user };
      return null;
    },

    async deleteUser(userId) {
      for (const [key, user] of users) if (user.userId === userId) users.delete(key);
      return true;
    },

    /** Test seam: register a user without going through the email round trip. */
    _seedUser(email) {
      return upsertUser(email);
    },
  };
}

module.exports = { createLocalAuthProvider };
