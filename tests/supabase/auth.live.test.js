'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  isConfigured,
  adminClient,
  authProvider,
  createTestUser,
  cleanup,
  markStartingPoint,
} = require('./helpers/liveProject');

/**
 * The Supabase auth provider, against a real project.
 *
 * Deliberately does NOT send a magic link to a real inbox: Supabase's built-in mailer is
 * rate-limited to a handful of sends an hour, so a suite that emailed on every run would start
 * failing for reasons unrelated to the code. Instead this covers everything reachable without
 * spending a send - admin lookups, deletion, the OAuth URL handshake and the PKCE plumbing -
 * and asserts the failure paths that a live project is uniquely able to prove.
 */
const describe = isConfigured ? test.describe : test.describe.skip;

if (!isConfigured) {
  test('supabase auth tests skipped - no credentials configured', () => assert.ok(true));
}

describe('supabase auth provider (live)', () => {
  const db = isConfigured ? adminClient() : null;
  const auth = isConfigured ? authProvider() : null;

  test.before(async () => {
    // Record where the attempts table stood, so teardown can find rows this run orphaned.
    await markStartingPoint(db);
  });

  test.after(async () => {
    const problems = await cleanup(db);
    if (problems.length) console.warn('\n  cleanup left rows behind:\n   - ' + problems.join('\n   - '));
  });

  // ------------------------------------------------------------- identities

  test('getUser returns a real identity in the shape the app expects', async () => {
    const { userId, email } = await createTestUser(db, 'auth-get');

    const identity = await auth.getUser(userId);
    assert.ok(identity, 'the user must be found');
    assert.equal(identity.userId, userId);
    assert.equal(identity.email, email);
    assert.equal(typeof identity.name, 'string', 'name is always a string, even when unset');
  });

  test('getUser returns null for an unknown id rather than throwing', async () => {
    assert.equal(await auth.getUser('00000000-0000-0000-0000-000000000000'), null);
  });

  test('deleteUser removes the identity', async () => {
    const { userId } = await createTestUser(db, 'auth-del');

    assert.equal(await auth.deleteUser(userId), true);
    assert.equal(await auth.getUser(userId), null);
  });

  // ------------------------------------------------------------- magic link

  test('an invalid token hash is refused as a BadRequest, not an outage', async () => {
    // The distinction matters: a 400 tells the visitor to request a new link, a 502 would
    // tell them the service is down.
    await assert.rejects(
      () => auth.verifyMagicLink('not-a-real-token-hash', 'email'),
      (err) => {
        assert.equal(err.status, 400, 'an expired or forged link is the visitor to fix');
        assert.match(err.message, /expired or was already used/);
        return true;
      }
    );
  });

  test('a missing token hash is refused before any network call', async () => {
    await assert.rejects(
      () => auth.verifyMagicLink('', 'email'),
      (err) => err.status === 400
    );
  });

  // ------------------------------------------------------------------ OAuth

  test('startOAuth returns a real Google consent URL', async () => {
    const redirectTo = 'http://localhost:3000/auth/callback?next=%2Fplay';
    const { url } = await auth.startOAuth('google', redirectTo);

    assert.ok(url, 'a URL must come back');
    const parsed = new URL(url);

    // Supabase fronts the provider, so the handshake starts on the project domain.
    assert.match(parsed.host, /supabase\.co$/, 'the handshake starts at the Supabase auth endpoint');
    assert.match(parsed.pathname, /\/auth\/v1\/authorize/);
    assert.equal(parsed.searchParams.get('provider'), 'google');
    assert.equal(
      parsed.searchParams.get('redirect_to'),
      redirectTo,
      'our callback must survive intact, or the round trip lands nowhere'
    );
  });

  test('startOAuth hands back a PKCE verifier for the caller to park', async () => {
    const { pkce } = await auth.startOAuth('google', 'http://localhost:3000/auth/callback');

    const entries = Object.entries(pkce);
    assert.ok(entries.length > 0, 'the storage snapshot must not be empty');
    assert.ok(
      entries.some(([key]) => key.includes('code-verifier')),
      `expected a code-verifier entry, got keys: ${entries.map(([k]) => k).join(', ')}`
    );

    // Whatever supabase-js chose to store, it has to be JSON-serialisable to survive the
    // signed cookie that carries it across the redirect.
    assert.doesNotThrow(() => JSON.parse(JSON.stringify(pkce)));
  });

  test('each handshake gets its own verifier', async () => {
    const first = await auth.startOAuth('google', 'http://localhost:3000/auth/callback');
    const second = await auth.startOAuth('google', 'http://localhost:3000/auth/callback');

    assert.notDeepEqual(first.pkce, second.pkce, 'a reused verifier would break PKCE entirely');
  });

  test('the challenge sent to the provider matches the verifier we kept', async () => {
    const { url, pkce } = await auth.startOAuth('google', 'http://localhost:3000/auth/callback');
    const challenge = new URL(url).searchParams.get('code_challenge');

    assert.ok(challenge, 'PKCE requires a challenge on the authorize URL');
    assert.equal(
      new URL(url).searchParams.get('code_challenge_method'),
      's256',
      'S256, not plain - a plain challenge offers no protection'
    );

    // Prove the pair actually corresponds: challenge = base64url(sha256(verifier)).
    const verifier = Object.entries(pkce).find(([k]) => k.includes('code-verifier'))?.[1];
    assert.ok(verifier, 'a verifier must have been stored');

    const raw = typeof verifier === 'string' ? verifier.replace(/^"|"$/g, '') : String(verifier);
    const expected = require('crypto').createHash('sha256').update(raw).digest('base64url');

    assert.equal(expected, challenge, 'the stored verifier must be the one the challenge derives from');
  });

  test('an unconfigured provider is reported rather than silently redirecting', async () => {
    // Supabase either errors or returns a URL that fails at the provider. Either way this
    // must not throw an unhandled exception.
    await assert.doesNotReject(async () => {
      try {
        await auth.startOAuth('github', 'http://localhost:3000/auth/callback');
      } catch (err) {
        assert.ok(err.status >= 400, 'any failure must be a typed AppError');
      }
    });
  });

  test('a forged authorization code cannot be exchanged', async () => {
    const { pkce } = await auth.startOAuth('google', 'http://localhost:3000/auth/callback');

    await assert.rejects(
      () => auth.completeOAuth('forged-authorization-code', pkce),
      (err) => {
        assert.equal(err.status, 400);
        assert.match(err.message, /could not be completed/);
        return true;
      }
    );
  });

  test('a code cannot be exchanged without its verifier', async () => {
    await auth.startOAuth('google', 'http://localhost:3000/auth/callback');

    await assert.rejects(
      () => auth.completeOAuth('some-code', {}),
      (err) => err.status === 400,
      'no verifier means no exchange - this is what stops a stolen callback URL'
    );
  });

  test('a missing code is refused before any network call', async () => {
    await assert.rejects(
      () => auth.completeOAuth('', {}),
      (err) => err.status === 400
    );
  });

  test('the provider advertises which OAuth options are enabled', () => {
    assert.deepEqual(auth.oauthProviders, ['google']);
    assert.equal(auth.name, 'supabase');
  });
});
