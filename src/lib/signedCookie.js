'use strict';

const crypto = require('crypto');

/**
 * Stateless signed cookies.
 *
 * A cookie carries its own payload and expiry, authenticated by an HMAC, so verifying a session
 * costs no storage and no round trip. The signature covers the expiry as well as the payload,
 * so neither can be edited without invalidating the whole thing.
 *
 * Format: base64url(JSON payload).expiresAtMs.hexHmac
 */

const b64url = {
  encode: (value) => Buffer.from(JSON.stringify(value), 'utf8').toString('base64url'),
  decode: (text) => JSON.parse(Buffer.from(text, 'base64url').toString('utf8')),
};

/** Constant-time compare that tolerates differing lengths without leaking them via timing. */
function safeEqual(a, b) {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  if (bufA.length !== bufB.length) {
    crypto.timingSafeEqual(bufA, bufA); // burn an equivalent comparison
    return false;
  }
  return crypto.timingSafeEqual(bufA, bufB);
}

/**
 * @param {string} secret signing key - must be stable across restarts or every session drops
 * @param {string} [namespace] mixed into the key so an admin cookie can never be replayed as a
 *   player cookie, even though both are signed by the same secret
 */
function createCookieSigner(secret, namespace = 'default') {
  if (!secret) throw new Error('createCookieSigner requires a secret');
  const key = crypto.createHmac('sha256', secret).update(`ns:${namespace}`).digest();

  const sign = (body, expiresAt) => crypto.createHmac('sha256', key).update(`${body}.${expiresAt}`).digest('hex');

  return {
    /**
     * @param {object} payload serialisable claims, e.g. { userId }
     * @param {number} maxAgeMs
     * @returns {string} the cookie value
     */
    pack(payload, maxAgeMs) {
      const expiresAt = Date.now() + maxAgeMs;
      const body = b64url.encode(payload);
      return `${body}.${expiresAt}.${sign(body, expiresAt)}`;
    },

    /**
     * @param {string|undefined} value
     * @returns {object|null} the payload, or null if absent, malformed, expired or tampered with
     */
    unpack(value) {
      if (typeof value !== 'string' || !value) return null;
      const parts = value.split('.');
      if (parts.length !== 3) return null;

      const [body, expiresAt, signature] = parts;
      const expiry = Number(expiresAt);
      if (!Number.isFinite(expiry) || expiry < Date.now()) return null;
      if (!safeEqual(signature, sign(body, expiry))) return null;

      try {
        return b64url.decode(body);
      } catch {
        return null;
      }
    },
  };
}

/** Parse a Cookie header into a plain object. */
function parseCookies(header = '') {
  const jar = {};
  for (const part of String(header).split(';')) {
    const index = part.indexOf('=');
    if (index === -1) continue;
    const key = part.slice(0, index).trim();
    if (!key) continue;
    try {
      jar[key] = decodeURIComponent(part.slice(index + 1).trim());
    } catch {
      jar[key] = part.slice(index + 1).trim();
    }
  }
  return jar;
}

module.exports = { createCookieSigner, parseCookies, safeEqual };
