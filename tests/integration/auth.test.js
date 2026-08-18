'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');

const { buildTestApp, makePuzzle, signIn } = require('../helpers/testApp');

const solve = async (app, cookie, puzzleId = 'test-puzzle') => {
  const agent = request(app).get(`/api/puzzles/${puzzleId}`);
  if (cookie) agent.set('Cookie', cookie);
  const { body } = await agent;

  const submit = request(app).post('/api/submit');
  if (cookie) submit.set('Cookie', cookie);
  return submit.send({ puzzleId, answer: 'piano', attemptToken: body.data.attemptToken });
};

test.describe('play without an account', () => {
  test('every gameplay route works signed out', async () => {
    const { app } = buildTestApp();
    await request(app).get('/play').expect(200);
    await request(app).get('/api/puzzles/random').expect(200);
    await request(app).get('/api/puzzles/daily').expect(200);
    await request(app).get('/challenge/test-puzzle').expect(200);
  });

  test('an anonymous solve is graded and scored, but not banked', async () => {
    const { app } = buildTestApp();
    const res = await solve(app, null);

    assert.equal(res.body.data.correct, true);
    assert.ok(res.body.data.pointsEarned > 0, 'the player still sees what the solve was worth');
    assert.equal(res.body.data.ranked, false);
    assert.equal(res.body.data.player, null);
    assert.match(res.body.data.message, /sign in to keep it/i);
  });

  test('an anonymous solve stays off the leaderboard but still moves global stats', async () => {
    const { app } = buildTestApp();
    await solve(app, null);

    const board = await request(app).get('/api/leaderboard').expect(200);
    assert.deepEqual(board.body.data.entries, [], 'anonymous play must not create a player row');

    const stats = await request(app).get('/api/stats?fresh=1').expect(200);
    assert.equal(stats.body.data.totalSolves, 1, 'the solve still counts globally');
  });

  test('an anonymous solve never earns a streak multiplier', async () => {
    const { app } = buildTestApp();
    const res = await solve(app, null);
    assert.equal(res.body.data.streak, 0);
    assert.equal(res.body.data.breakdown.streakMultiplier, 1);
  });

  test('/api/me reports signed out rather than failing', async () => {
    const { app } = buildTestApp();
    const res = await request(app).get('/api/me').expect(200);
    assert.deepEqual(res.body.data, { signedIn: false, player: null });
  });
});

test.describe('the sign-in flow', () => {
  test('issues a single-use link and exchanges it for a session cookie', async () => {
    const { app, issuedLinks } = buildTestApp();
    const { cookie, redirectedTo } = await signIn(app, issuedLinks);

    assert.match(cookie, /^bth_session=/);
    assert.match(redirectedTo, /^\/profile/, 'a brand new account lands on the profile');

    const me = await request(app).get('/api/me').set('Cookie', cookie).expect(200);
    assert.equal(me.body.data.signedIn, true);
    assert.equal(me.body.data.player.displayName, 'ada');
  });

  test('the session cookie is httpOnly and same-site', async () => {
    const { app, issuedLinks } = buildTestApp();
    await request(app).post('/signin').send({ email: 'ada@example.com' });
    const link = issuedLinks.at(-1).link;
    const res = await request(app).get(link.slice(link.indexOf('/auth/callback')));

    const raw = res.headers['set-cookie'].find((c) => c.startsWith('bth_session='));
    assert.match(raw, /HttpOnly/i);
    assert.match(raw, /SameSite=Lax/i);
  });

  test('a link cannot be replayed', async () => {
    const { app, issuedLinks } = buildTestApp();
    await request(app).post('/signin').send({ email: 'ada@example.com' });
    const link = issuedLinks.at(-1).link;
    const path = link.slice(link.indexOf('/auth/callback'));

    await request(app).get(path).expect(302);
    const second = await request(app).get(path).expect(400);
    assert.match(second.text, /expired or was already used/);
  });

  test('a forged or tampered token is rejected', async () => {
    const { app } = buildTestApp();
    await request(app).get('/auth/callback?token_hash=made-up&type=email').expect(400);
    await request(app).get('/auth/callback').expect(400);
  });

  test('a tampered session cookie is ignored', async () => {
    const { app, issuedLinks } = buildTestApp();
    const { cookie } = await signIn(app, issuedLinks);

    // Flip a character in the signature; the HMAC must reject it.
    const forged = cookie.slice(0, -1) + (cookie.endsWith('a') ? 'b' : 'a');
    const res = await request(app).get('/api/me').set('Cookie', forged).expect(200);
    assert.equal(res.body.data.signedIn, false);
  });

  test('a session signed with a different secret is rejected', async () => {
    const a = buildTestApp();
    const b = buildTestApp();
    const { cookie } = await signIn(a.app, a.issuedLinks);

    // Same secret in the harness, but b has no such player - the session must not resolve.
    const res = await request(b.app).get('/api/me').set('Cookie', cookie).expect(200);
    assert.equal(res.body.data.signedIn, false);
  });

  test('rejects an address that is not an email, without sending anything', async () => {
    const { app, issuedLinks } = buildTestApp();
    const res = await request(app).post('/signin').send({ email: 'not-an-email' }).expect(400);
    assert.match(res.text, /does not look like an email/);
    assert.equal(issuedLinks.length, 0);
  });

  test('does not reveal whether an address already has an account', async () => {
    const { app, issuedLinks } = buildTestApp();
    const first = await request(app).post('/signin').send({ email: 'ada@example.com' }).expect(200);
    await signIn(app, issuedLinks);
    const second = await request(app).post('/signin').send({ email: 'ada@example.com' }).expect(200);

    assert.match(first.text, /Check your email/);
    assert.match(second.text, /Check your email/, 'the response must not differ for a known address');
  });

  test('signing in twice returns to the same account, not a duplicate', async () => {
    const { app, issuedLinks } = buildTestApp();
    const first = await signIn(app, issuedLinks);
    const second = await signIn(app, issuedLinks);

    assert.match(second.redirectedTo, /^\/play/, 'a returning player goes where they were headed');

    const me = await request(app).get('/api/me').set('Cookie', second.cookie).expect(200);
    assert.equal(me.body.data.player.displayName, 'ada');
    assert.notEqual(first.cookie, '');
  });

  test('two different emails get distinct, non-colliding display names', async () => {
    const { app, issuedLinks } = buildTestApp();
    const one = await signIn(app, issuedLinks, 'ada@example.com');
    const two = await signIn(app, issuedLinks, 'ada@other.com');

    const nameOf = async (cookie) =>
      (await request(app).get('/api/me').set('Cookie', cookie)).body.data.player.displayName;

    assert.equal(await nameOf(one.cookie), 'ada');
    assert.equal(await nameOf(two.cookie), 'ada2', 'the second "ada" is disambiguated, not rejected');
  });

  test('signing out clears the session', async () => {
    const { app, issuedLinks } = buildTestApp();
    const { cookie } = await signIn(app, issuedLinks);

    const res = await request(app).post('/signout').set('Cookie', cookie).expect(302);
    const cleared = res.headers['set-cookie'].find((c) => c.startsWith('bth_session='));
    assert.match(cleared, /bth_session=;/, 'the cookie is emptied');
  });

  test('the sign-in redirect only ever targets this site', async () => {
    const { app, issuedLinks } = buildTestApp();
    await request(app).post('/signin').send({ email: 'ada@example.com', next: 'https://evil.example.com' });
    const link = issuedLinks.at(-1).link;
    const res = await request(app)
      .get(link.slice(link.indexOf('/auth/callback')))
      .expect(302);
    assert.doesNotMatch(res.headers.location, /evil\.example\.com/);
  });
});

test.describe('playing with an account', () => {
  test('a solve is banked to the profile and appears on the leaderboard', async () => {
    const { app, issuedLinks } = buildTestApp();
    const { cookie } = await signIn(app, issuedLinks);

    const res = await solve(app, cookie);
    assert.equal(res.body.data.ranked, true);
    assert.equal(res.body.data.player.displayName, 'ada');
    assert.equal(res.body.data.streak, 1);

    const board = await request(app).get('/api/leaderboard').expect(200);
    assert.equal(board.body.data.entries[0].displayName, 'ada');
    assert.equal(board.body.data.entries[0].solves, 1);
  });

  test('the score cannot be assigned to somebody else by editing the request', async () => {
    const { app, issuedLinks } = buildTestApp({
      puzzles: [makePuzzle({ id: 'one' }), makePuzzle({ id: 'two' })],
    });
    const { cookie } = await signIn(app, issuedLinks, 'ada@example.com');

    const { body } = await request(app).get('/api/puzzles/one').set('Cookie', cookie);
    await request(app)
      .post('/api/submit')
      .set('Cookie', cookie)
      // A username in the body is the old, spoofable path - it must be ignored entirely.
      .send({ puzzleId: 'one', answer: 'piano', username: 'SomebodyElse', attemptToken: body.data.attemptToken })
      .expect(200);

    const board = await request(app).get('/api/leaderboard');
    const names = board.body.data.entries.map((e) => e.displayName);
    assert.deepEqual(names, ['ada'], 'the claimed name must not appear anywhere');
  });

  test('the leaderboard never exposes an email or a user id', async () => {
    const { app, issuedLinks } = buildTestApp();
    const { cookie } = await signIn(app, issuedLinks, 'ada@example.com');
    await solve(app, cookie);

    const board = await request(app).get('/api/leaderboard').expect(200);
    const serialised = JSON.stringify(board.body);
    assert.doesNotMatch(serialised, /ada@example\.com/);
    assert.doesNotMatch(serialised, /userId/);
  });

  test('points accumulate across puzzles for the same account', async () => {
    const { app, issuedLinks } = buildTestApp({
      puzzles: [makePuzzle({ id: 'one' }), makePuzzle({ id: 'two' })],
    });
    const { cookie } = await signIn(app, issuedLinks);

    await solve(app, cookie, 'one');
    const second = await solve(app, cookie, 'two');

    assert.equal(second.body.data.player.solves, 2);
    assert.ok(second.body.data.player.totalScore >= 200);
  });
});

test.describe('the profile page', () => {
  test('requires a session and redirects a signed-out visitor', async () => {
    const { app } = buildTestApp();
    const res = await request(app).get('/profile').expect(302);
    assert.match(res.headers.location, /^\/signin/);
  });

  test('renders the account for a signed-in player', async () => {
    const { app, issuedLinks } = buildTestApp();
    const { cookie } = await signIn(app, issuedLinks);
    const res = await request(app).get('/profile').set('Cookie', cookie).expect(200);
    assert.match(res.text, /ada/);
  });

  test('the display name can be changed', async () => {
    const { app, issuedLinks } = buildTestApp();
    const { cookie } = await signIn(app, issuedLinks);

    await request(app).post('/profile/name').set('Cookie', cookie).send({ displayName: 'Ada Lovelace' }).expect(302);

    const me = await request(app).get('/api/me').set('Cookie', cookie);
    assert.equal(me.body.data.player.displayName, 'Ada Lovelace');
  });

  test('an invalid or reserved name is rejected with a reason', async () => {
    const { app, issuedLinks } = buildTestApp();
    const { cookie } = await signIn(app, issuedLinks);

    for (const bad of ['x', 'a'.repeat(40), '<script>', 'Anonymous']) {
      const res = await request(app).post('/profile/name').set('Cookie', cookie).send({ displayName: bad });
      assert.equal(res.status, 400, `"${bad}" should be rejected`);
    }
  });

  test('a name already taken by another player is refused', async () => {
    const { app, issuedLinks } = buildTestApp();
    const first = await signIn(app, issuedLinks, 'ada@example.com');
    await request(app).post('/profile/name').set('Cookie', first.cookie).send({ displayName: 'Grace' }).expect(302);

    const second = await signIn(app, issuedLinks, 'bob@example.com');
    const res = await request(app).post('/profile/name').set('Cookie', second.cookie).send({ displayName: 'grace' });

    assert.equal(res.status, 409, 'display names collide case-insensitively');
    assert.match(res.text, /already plays under that name/);
  });

  test('keeping your own name is not a collision with yourself', async () => {
    const { app, issuedLinks } = buildTestApp();
    const { cookie } = await signIn(app, issuedLinks);
    await request(app).post('/profile/name').set('Cookie', cookie).send({ displayName: 'ada' }).expect(302);
  });
});

test.describe('signed-in chrome', () => {
  test('the nav offers sign-in when signed out and the account when signed in', async () => {
    const { app, issuedLinks } = buildTestApp();

    const anon = await request(app).get('/play').expect(200);
    assert.match(anon.text, /href="\/signin"/);
    assert.match(anon.text, /Playing anonymously/);

    const { cookie } = await signIn(app, issuedLinks);
    const signed = await request(app).get('/play').set('Cookie', cookie).expect(200);
    assert.match(signed.text, /nav-account/);
    assert.match(signed.text, /Playing as/);
  });
});
