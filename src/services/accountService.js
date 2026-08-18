'use strict';

const { BadRequestError, ConflictError, NotFoundError } = require('../lib/errors');

// Deliberately permissive: the magic link is what actually proves the address works, so this
// only needs to catch typos before we spend a send on them.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

const DISPLAY_NAME_MIN = 2;
const DISPLAY_NAME_MAX = 32;
const DISPLAY_NAME_RE = /^[\p{L}\p{N}][\p{L}\p{N} _.'-]*$/u;

const RESERVED_NAMES = new Set(['anonymous', 'admin', 'administrator', 'moderator', 'system', 'null', 'undefined']);

function normalizeEmail(email) {
  return String(email || '')
    .trim()
    .toLowerCase();
}

/** @throws {BadRequestError} */
function assertValidEmail(email) {
  const value = normalizeEmail(email);
  if (!value || !EMAIL_RE.test(value) || value.length > 254) {
    throw new BadRequestError('That does not look like an email address.');
  }
  return value;
}

/** @throws {BadRequestError} */
function assertValidDisplayName(name) {
  const value = String(name || '')
    .replace(/\s+/g, ' ')
    .trim();
  if (value.length < DISPLAY_NAME_MIN || value.length > DISPLAY_NAME_MAX) {
    throw new BadRequestError(`Pick a name between ${DISPLAY_NAME_MIN} and ${DISPLAY_NAME_MAX} characters.`);
  }
  if (!DISPLAY_NAME_RE.test(value)) {
    throw new BadRequestError(
      "Names can use letters, numbers, spaces and . _ - ' only, and must start with a letter or number."
    );
  }
  if (RESERVED_NAMES.has(value.toLowerCase())) {
    throw new BadRequestError('That name is reserved. Pick another.');
  }
  return value;
}

/** @returns {string|null} the name if it passes validation, null if not - never throws. */
function assertValidDisplayNameOrNull(name) {
  try {
    return assertValidDisplayName(name);
  } catch {
    return null;
  }
}

/** Turn an email into a first-guess display name: "ada.lovelace@x.com" -> "ada.lovelace". */
function suggestDisplayName(email) {
  const local = normalizeEmail(email).split('@')[0] || 'player';
  const cleaned = local.replace(/[^\p{L}\p{N} _.'-]/gu, '').slice(0, DISPLAY_NAME_MAX);
  return cleaned.length >= DISPLAY_NAME_MIN ? cleaned : 'player';
}

/**
 * Accounts and sign-in.
 *
 * Sign-in is optional by design: nothing here is required to play. It exists so a leaderboard
 * entry and a streak belong to somebody, rather than to whoever last typed the name.
 */
function createAccountService({ repository, authProvider, logger = console }) {
  /** Find a free display name near the requested one: "ada", "ada2", "ada3", … */
  async function findAvailableDisplayName(preferred) {
    const base = preferred.slice(0, DISPLAY_NAME_MAX - 3);
    for (let suffix = 0; suffix < 50; suffix += 1) {
      const candidate = suffix === 0 ? preferred : `${base}${suffix + 1}`;
      const taken = await repository.findPlayerByDisplayName(candidate);
      if (!taken) return candidate;
    }
    return `${base}${Date.now().toString(36).slice(-4)}`;
  }

  return {
    /**
     * Send a sign-in link. Always reports success to the caller: telling an anonymous visitor
     * whether an address is registered would turn this into an account-enumeration oracle.
     * @returns {Promise<{ sent: true, devLink?: string }>} devLink only on the local driver
     */
    async requestSignInLink({ email, redirectTo }) {
      const address = assertValidEmail(email);
      const result = await authProvider.sendMagicLink(address, redirectTo);
      logger.info?.('sign-in link requested', { provider: authProvider.name });
      return { sent: true, ...(result.link ? { devLink: result.link } : {}) };
    },

    /** Which OAuth providers should be offered. Empty means email only. */
    get oauthProviders() {
      return authProvider.oauthProviders || [];
    },

    /**
     * Begin an OAuth handshake.
     * @returns {Promise<{ url: string, pkce: object }>}
     * @throws {BadRequestError} for a provider that is not enabled
     */
    async startOAuth({ provider, redirectTo }) {
      const name = String(provider || '').toLowerCase();
      if (!(authProvider.oauthProviders || []).includes(name)) {
        throw new BadRequestError('That sign-in method is not available.');
      }
      return authProvider.startOAuth(name, redirectTo);
    },

    /**
     * Turn a verified identity into a session, creating the player profile on first sight.
     * Shared by both routes in, so a magic link and an OAuth return land in exactly the same place.
     * @returns {Promise<{ userId: string, player: object, isNewAccount: boolean }>}
     */
    async establishAccount({ userId, email, name = '' }) {
      const existing = await repository.getPlayer(userId);
      if (existing) return { userId, player: existing, isNewAccount: false };

      // A provider-supplied name is a better first guess than the local part of an address.
      const preferred = name ? assertValidDisplayNameOrNull(name) : null;
      const displayName = await findAvailableDisplayName(preferred || suggestDisplayName(email));
      const player = await repository.upsertPlayer({ userId, email, displayName });
      logger.info?.('player account created', { displayName });
      return { userId, player, isNewAccount: true };
    },

    /** Complete sign-in from the emailed link. */
    async completeSignIn({ tokenHash, type }) {
      const identity = await authProvider.verifyMagicLink(tokenHash, type);
      return this.establishAccount(identity);
    },

    /** Complete sign-in from an OAuth redirect. */
    async completeOAuth({ code, pkce }) {
      const identity = await authProvider.completeOAuth(code, pkce);
      return this.establishAccount(identity);
    },

    async getProfile(userId) {
      const player = await repository.getPlayer(userId);
      if (!player) throw new NotFoundError('No account for this session.');
      const board = await repository.getLeaderboard(100);
      const rank = board.findIndex((row) => row.displayName === player.displayName);
      return { ...player, rank: rank === -1 ? null : rank + 1 };
    },

    /** @throws {ConflictError} when another player already holds the name */
    async changeDisplayName(userId, requested) {
      const displayName = assertValidDisplayName(requested);
      const holder = await repository.findPlayerByDisplayName(displayName);
      if (holder && holder.userId !== userId) {
        throw new ConflictError('Somebody already plays under that name. Try another.');
      }
      return repository.upsertPlayer({ userId, displayName });
    },

    /**
     * Is this display name free for this player to take?
     * Names are public on the leaderboard, so answering this leaks nothing.
     * @returns {Promise<{ available: boolean, reason: string|null, name: string|null }>}
     */
    async checkDisplayName(userId, requested) {
      let displayName;
      try {
        displayName = assertValidDisplayName(requested);
      } catch (err) {
        return { available: false, reason: err.message, name: null };
      }
      const holder = await repository.findPlayerByDisplayName(displayName);
      if (holder && holder.userId !== userId) {
        return { available: false, reason: 'Somebody already plays under that name.', name: displayName };
      }
      return { available: true, reason: null, name: displayName };
    },

    /**
     * Delete the account: the player row first, then the identity.
     *
     * Order matters - if the identity went first and the row delete then failed, the session
     * would resolve to a player with no account behind it. Solved puzzles stay in `attempts`
     * with a null owner, so the global statistics do not develop a hole.
     */
    async deleteAccount(userId) {
      await repository.deletePlayer(userId);
      await authProvider.deleteUser(userId).catch((err) => {
        // The profile is already gone from the player's point of view; a dangling auth user is
        // recoverable by an operator, so this must not fail the request.
        logger.warn?.('auth provider could not delete the user', { error: err.message });
      });
      logger.info?.('player account deleted');
      return { deleted: true };
    },

    assertValidDisplayName,
    assertValidEmail,
    suggestDisplayName,
  };
}

module.exports = {
  createAccountService,
  assertValidDisplayName,
  assertValidEmail,
  suggestDisplayName,
  normalizeEmail,
};
