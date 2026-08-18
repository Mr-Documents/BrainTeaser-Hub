'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');

const { buildTestApp, signIn } = require('../helpers/testApp');

test.describe('the sign-in and sign-up pages', () => {
  test('both routes render, and differ only in their framing', async () => {
    const { app } = buildTestApp();

    // EJS leaves the heading on its own line, so match its content rather than the exact markup.
    const headingOf = (html) => html.match(/id="auth-heading"[^>]*>\s*([^<]+?)\s*</)[1];

    const signin = await request(app).get('/signin').expect(200);
    assert.equal(headingOf(signin.text), 'Sign in');
    assert.match(signin.text, /First time here\?/);
    assert.match(signin.text, /action="\/signin"/);

    const signup = await request(app).get('/signup').expect(200);
    assert.equal(headingOf(signup.text), 'Create your account');
    assert.match(signup.text, /Already have an account\?/);
    assert.match(signup.text, /action="\/signup"/);
  });

  test('both post to the same handler and produce the same account', async () => {
    const { app, issuedLinks } = buildTestApp();

    await request(app).post('/signup').send({ email: 'ada@example.com', mode: 'signup' }).expect(200);
    const link = issuedLinks.at(-1).link;
    const res = await request(app)
      .get(link.slice(link.indexOf('/auth/callback')))
      .expect(302);

    const cookie = res.headers['set-cookie'].find((c) => c.startsWith('bth_session=')).split(';')[0];
    const me = await request(app).get('/api/me').set('Cookie', cookie);
    assert.equal(me.body.data.player.displayName, 'ada');
  });

  test('an already signed-in visitor is sent to their profile, not the form', async () => {
    const { app, issuedLinks } = buildTestApp();
    const { cookie } = await signIn(app, issuedLinks);

    for (const path of ['/signin', '/signup']) {
      const res = await request(app).get(path).set('Cookie', cookie).expect(302);
      assert.equal(res.headers.location, '/profile');
    }
  });

  test('the page explains the trade-off and offers a way to keep playing anonymously', async () => {
    const { app } = buildTestApp();
    const res = await request(app).get('/signin').expect(200);

    assert.match(res.text, /entirely optional/i);
    assert.match(res.text, /Play without an account/);
    assert.match(res.text, /never shown on the leaderboard/i);
  });

  test('the "check your inbox" state shows the address and offers a resend', async () => {
    const { app } = buildTestApp();
    const res = await request(app).post('/signin').send({ email: 'ada@example.com' }).expect(200);

    assert.match(res.text, /Check your inbox/);
    assert.match(res.text, /ada@example\.com/);
    assert.match(res.text, /Send another link/);
    assert.match(res.text, /data-resend-form/);
  });

  test('the resend form re-sends to the same address', async () => {
    const { app, issuedLinks } = buildTestApp();
    await request(app).post('/signin').send({ email: 'ada@example.com' }).expect(200);
    await request(app).post('/signin').send({ email: 'ada@example.com', next: '/play' }).expect(200);

    assert.equal(issuedLinks.length, 2);
    assert.equal(issuedLinks[0].email, issuedLinks[1].email);
    assert.notEqual(issuedLinks[0].tokenHash, issuedLinks[1].tokenHash, 'each send is a fresh token');
  });

  test('a rejected email keeps what was typed so it can be corrected', async () => {
    const { app } = buildTestApp();
    const res = await request(app).post('/signin').send({ email: 'ada@@bad' }).expect(400);

    assert.match(res.text, /does not look like an email/);
    assert.match(res.text, /value="ada@@bad"/, 'the field is repopulated rather than cleared');
  });

  test('an expired link lands on a form carrying the reason, not a dead end', async () => {
    const { app } = buildTestApp();
    const res = await request(app).get('/auth/callback?token_hash=stale').expect(302);

    const followed = await request(app).get(res.headers.location).expect(200);
    assert.match(followed.text, /expired or was already used/);
    assert.match(followed.text, /Email me a sign-in link/, 'and a way to get a new one');
  });

  test('the next destination survives the whole round trip', async () => {
    const { app, issuedLinks } = buildTestApp();
    await request(app).post('/signin').send({ email: 'ada@example.com', next: '/leaderboard' });

    // First sign-in goes to the profile to choose a name; the second honours where they were going.
    const link = issuedLinks.at(-1).link;
    assert.match(decodeURIComponent(link), /next=\/leaderboard/);

    await request(app).get(link.slice(link.indexOf('/auth/callback')));
    await request(app).post('/signin').send({ email: 'ada@example.com', next: '/leaderboard' });
    const second = issuedLinks.at(-1).link;
    const res = await request(app)
      .get(second.slice(second.indexOf('/auth/callback')))
      .expect(302);

    assert.equal(res.headers.location, '/leaderboard');
  });

  test('the local dev link is offered on the page when the local driver is active', async () => {
    const { app } = buildTestApp();
    const res = await request(app).post('/signin').send({ email: 'ada@example.com' }).expect(200);
    assert.match(res.text, /Use the sign-in link/);
    assert.match(res.text, /Local auth is on/);
  });
});

test.describe('display name availability', () => {
  test('reports a free name as available', async () => {
    const { app, issuedLinks } = buildTestApp();
    const { cookie } = await signIn(app, issuedLinks);

    const res = await request(app).get('/api/account/name-available?name=Grace').set('Cookie', cookie).expect(200);
    assert.equal(res.body.data.available, true);
    assert.equal(res.body.data.name, 'Grace');
  });

  test('reports a taken name as unavailable, with a reason', async () => {
    const { app, issuedLinks } = buildTestApp();
    const first = await signIn(app, issuedLinks, 'ada@example.com');
    await request(app).post('/profile/name').set('Cookie', first.cookie).send({ displayName: 'Grace' }).expect(302);

    const second = await signIn(app, issuedLinks, 'bob@example.com');
    const res = await request(app).get('/api/account/name-available?name=grace').set('Cookie', second.cookie);

    assert.equal(res.body.data.available, false);
    assert.match(res.body.data.reason, /already plays under that name/);
  });

  test('your own current name is available to you', async () => {
    const { app, issuedLinks } = buildTestApp();
    const { cookie } = await signIn(app, issuedLinks);
    const res = await request(app).get('/api/account/name-available?name=ada').set('Cookie', cookie).expect(200);
    assert.equal(res.body.data.available, true);
  });

  test('an invalid name is reported as unavailable rather than erroring', async () => {
    const { app, issuedLinks } = buildTestApp();
    const { cookie } = await signIn(app, issuedLinks);

    const res = await request(app).get('/api/account/name-available?name=x').set('Cookie', cookie).expect(200);
    assert.equal(res.body.data.available, false);
    assert.match(res.body.data.reason, /between 2 and 32/);
  });

  test('requires a session', async () => {
    const { app } = buildTestApp();
    await request(app).get('/api/account/name-available?name=Grace').expect(401);
  });
});

test.describe('account deletion', () => {
  const deleteAccount = (app, cookie, confirm) =>
    request(app).post('/profile/delete').set('Cookie', cookie).send({ confirm });

  test('removes the profile, the session and the leaderboard entry', async () => {
    const { app, issuedLinks } = buildTestApp();
    const { cookie } = await signIn(app, issuedLinks);

    const { body } = await request(app).get('/api/puzzles/test-puzzle').set('Cookie', cookie);
    await request(app)
      .post('/api/submit')
      .set('Cookie', cookie)
      .send({ puzzleId: 'test-puzzle', answer: 'piano', attemptToken: body.data.attemptToken });

    const before = await request(app).get('/api/leaderboard');
    assert.equal(before.body.data.entries.length, 1);

    const res = await deleteAccount(app, cookie, 'ada').expect(302);
    assert.equal(res.headers.location, '/?deleted=1');

    const after = await request(app).get('/api/leaderboard');
    assert.deepEqual(after.body.data.entries, [], 'the leaderboard entry goes with the account');

    const me = await request(app).get('/api/me').set('Cookie', cookie);
    assert.equal(me.body.data.signedIn, false, 'the old cookie no longer resolves');
  });

  test('refuses without the exact display name typed as confirmation', async () => {
    const { app, issuedLinks } = buildTestApp();
    const { cookie } = await signIn(app, issuedLinks);

    for (const wrong of ['', 'delete', 'adaa']) {
      const res = await deleteAccount(app, cookie, wrong).expect(400);
      assert.match(res.text, /to confirm deletion/);
    }

    const me = await request(app).get('/api/me').set('Cookie', cookie);
    assert.equal(me.body.data.signedIn, true, 'a failed confirmation must not delete anything');
  });

  test('the solved puzzles stay in the global statistics, unattributed', async () => {
    const { app, issuedLinks } = buildTestApp();
    const { cookie } = await signIn(app, issuedLinks);

    const { body } = await request(app).get('/api/puzzles/test-puzzle').set('Cookie', cookie);
    await request(app)
      .post('/api/submit')
      .set('Cookie', cookie)
      .send({ puzzleId: 'test-puzzle', answer: 'piano', attemptToken: body.data.attemptToken });

    await deleteAccount(app, cookie, 'ada').expect(302);

    const stats = await request(app).get('/api/stats?fresh=1').expect(200);
    assert.equal(stats.body.data.totalSolves, 1, 'deleting an account must not punch a hole in the totals');
  });

  test('requires a session', async () => {
    const { app } = buildTestApp();
    const res = await request(app).post('/profile/delete').send({ confirm: 'ada' }).expect(302);
    assert.match(res.headers.location, /^\/signin/);
  });
});

test.describe('the profile page', () => {
  test('shows the account, the stats and the danger zone', async () => {
    const { app, issuedLinks } = buildTestApp();
    const { cookie } = await signIn(app, issuedLinks);
    const res = await request(app).get('/profile').set('Cookie', cookie).expect(200);

    assert.match(res.text, /Display name/);
    assert.match(res.text, /Sign-in details/);
    assert.match(res.text, /Delete account/);
    assert.match(res.text, /Sign out/);
    assert.match(res.text, /ada@example\.com/, 'your own email is shown to you');
  });

  test('greets a brand new account with an explanation of the chosen name', async () => {
    const { app, issuedLinks } = buildTestApp();
    const { cookie, redirectedTo } = await signIn(app, issuedLinks);

    assert.match(redirectedTo, /welcome=1/);
    const res = await request(app).get(redirectedTo).set('Cookie', cookie).expect(200);
    assert.match(res.text, /Welcome to/);
    assert.match(res.text, /change it below/);
  });
});
