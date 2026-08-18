'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');

const { buildTestApp } = require('../helpers/testApp');

const hasCookie = (res, name) => (res.headers['set-cookie'] || []).some((c) => c.startsWith(`${name}=`));
const getCookie = (res, name) =>
  (res.headers['set-cookie'] || []).find((c) => c.startsWith(`${name}=`))?.split(';')[0];
const callbackPathOf = (res) => res.headers.location.slice(res.headers.location.indexOf('/auth/callback'));

/** Walk the whole handshake the way a browser would. */
async function oauthSignIn(app, provider = 'google') {
  const start = await request(app).post(`/auth/${provider}/start`).send({ next: '/play' }).expect(302);
  const handshake = getCookie(start, 'bth_oauth');
  const done = await request(app).get(callbackPathOf(start)).set('Cookie', handshake);
  return { start, done, handshake };
}

test.describe('the Google button', () => {
  test('is offered on both auth pages', async () => {
    const { app } = buildTestApp();
    for (const path of ['/signin', '/signup']) {
      const res = await request(app).get(path).expect(200);
      assert.match(res.text, /Continue with Google/);
      assert.match(res.text, /action="\/auth\/google\/start"/);
    }
  });

  test('posts rather than links, so another site cannot start a handshake', async () => {
    const { app } = buildTestApp();
    const res = await request(app).get('/signin').expect(200);
    assert.match(res.text, /<form method="post" action="\/auth\/google\/start"/);
    assert.doesNotMatch(res.text, /<a[^>]+href="\/auth\/google\/start"/);
  });

  test('carries the brand mark inline rather than hot-linking the provider', async () => {
    const { app } = buildTestApp();
    const res = await request(app).get('/signin').expect(200);
    // An <img> to a Google CDN would be blocked by our CSP and would leak a request to Google
    // before the visitor has chosen anything.
    assert.match(res.text, /<svg viewBox="0 0 18 18"/);
    assert.doesNotMatch(res.text, /<img[^>]+google/i);
  });

  test('is hidden when no providers are configured', async () => {
    const { app } = buildTestApp({ oauthProviders: [] });
    const res = await request(app).get('/signin').expect(200);
    assert.doesNotMatch(res.text, /Continue with Google/);
    assert.match(res.text, /Email me a sign-in link/, 'email sign-in still works on its own');
  });
});

test.describe('the OAuth handshake', () => {
  test('redirects to the provider and parks the verifier in an httpOnly cookie', async () => {
    const { app } = buildTestApp();
    const res = await request(app).post('/auth/google/start').send({ next: '/play' }).expect(302);

    assert.match(res.headers.location, /\/auth\/callback/);
    const handshake = getCookie(res, 'bth_oauth');
    assert.ok(handshake, 'the verifier must be parked for the round trip');

    const raw = res.headers['set-cookie'].find((c) => c.startsWith('bth_oauth='));
    assert.match(raw, /HttpOnly/i, 'no script may read the verifier');
    assert.match(raw, /SameSite=Lax/i);
  });

  test('completes and signs the visitor in', async () => {
    const { app } = buildTestApp();
    const { done } = await oauthSignIn(app);

    assert.equal(done.status, 302);
    assert.ok(hasCookie(done, 'bth_session'), 'a completed handshake issues a session');

    const me = await request(app).get('/api/me').set('Cookie', getCookie(done, 'bth_session')).expect(200);
    assert.equal(me.body.data.signedIn, true);
    assert.equal(me.body.data.player.displayName, 'google-user');
  });

  test('clears the handshake cookie once it is spent', async () => {
    const { app } = buildTestApp();
    const { done } = await oauthSignIn(app);
    const cleared = done.headers['set-cookie'].find((c) => c.startsWith('bth_oauth='));
    assert.match(cleared, /bth_oauth=;/);
  });

  test('refuses a callback that did not start in this browser', async () => {
    const { app } = buildTestApp();
    const start = await request(app).post('/auth/google/start').send({ next: '/play' }).expect(302);

    // Same code, no handshake cookie - what an attacker replaying a stolen URL would have.
    const res = await request(app).get(callbackPathOf(start)).expect(302);
    assert.match(res.headers.location, /^\/signin/);
    assert.equal(hasCookie(res, 'bth_session'), false, 'no verifier means no session, ever');
  });

  test('refuses a forged code even with a valid handshake cookie', async () => {
    const { app } = buildTestApp();
    const start = await request(app).post('/auth/google/start').send({ next: '/play' }).expect(302);

    const res = await request(app)
      .get('/auth/callback?code=forged&next=/play')
      .set('Cookie', getCookie(start, 'bth_oauth'))
      .expect(302);

    assert.match(decodeURIComponent(res.headers.location), /could not be completed/);
    assert.equal(hasCookie(res, 'bth_session'), false);
  });

  test('a code cannot be replayed', async () => {
    const { app } = buildTestApp();
    const start = await request(app).post('/auth/google/start').send({ next: '/play' }).expect(302);
    const handshake = getCookie(start, 'bth_oauth');

    await request(app).get(callbackPathOf(start)).set('Cookie', handshake).expect(302);
    const second = await request(app).get(callbackPathOf(start)).set('Cookie', handshake).expect(302);
    assert.equal(hasCookie(second, 'bth_session'), false);
  });

  test('a tampered handshake cookie is rejected', async () => {
    const { app } = buildTestApp();
    const start = await request(app).post('/auth/google/start').send({ next: '/play' }).expect(302);
    const raw = getCookie(start, 'bth_oauth');
    const forged = raw.slice(0, -1) + (raw.endsWith('a') ? 'b' : 'a');

    const res = await request(app).get(callbackPathOf(start)).set('Cookie', forged).expect(302);
    assert.equal(hasCookie(res, 'bth_session'), false);
  });

  test('an unknown provider is refused', async () => {
    const { app } = buildTestApp();
    const res = await request(app).post('/auth/facebook/start').send({ next: '/play' }).expect(400);
    assert.match(res.text, /not available/);
  });

  test('a cancelled consent screen returns a readable message, not a crash', async () => {
    const { app } = buildTestApp();
    const res = await request(app)
      .get('/auth/callback?error=access_denied&error_description=User%20declined')
      .expect(302);

    assert.match(res.headers.location, /^\/signin/);
    assert.match(decodeURIComponent(res.headers.location), /User declined/);
  });

  test('signing in twice by OAuth returns to the same account', async () => {
    const { app } = buildTestApp();
    const first = await oauthSignIn(app);
    assert.match(first.done.headers.location, /^\/profile/, 'first time picks a name');

    const second = await oauthSignIn(app);
    assert.equal(second.done.headers.location, '/play', 'a returning player goes where they meant to');
  });

  test('OAuth and magic link converge on one account-creation path', async () => {
    const { app } = buildTestApp();
    const { done } = await oauthSignIn(app);

    // Same shape of profile as an emailed sign-in produces.
    const me = await request(app).get('/api/me').set('Cookie', getCookie(done, 'bth_session')).expect(200);
    assert.equal(me.body.data.player.email, 'google-user@example.com');
    assert.equal(me.body.data.player.totalScore, 0);
    assert.ok(me.body.data.player.createdAt);
  });

  test('an OAuth player is ranked like any other', async () => {
    const { app } = buildTestApp();
    const { done } = await oauthSignIn(app);
    const session = getCookie(done, 'bth_session');

    const { body } = await request(app).get('/api/puzzles/test-puzzle').set('Cookie', session);
    const solved = await request(app)
      .post('/api/submit')
      .set('Cookie', session)
      .send({ puzzleId: 'test-puzzle', answer: 'piano', attemptToken: body.data.attemptToken })
      .expect(200);

    assert.equal(solved.body.data.ranked, true);
    const board = await request(app).get('/api/leaderboard');
    assert.equal(board.body.data.entries[0].displayName, 'google-user');
  });
});
