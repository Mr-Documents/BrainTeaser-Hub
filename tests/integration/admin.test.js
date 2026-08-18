'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');

const { buildTestApp, makePuzzle } = require('../helpers/testApp');

const draft = (overrides = {}) => ({
  question: 'Which planet rotates almost entirely on its side?',
  type: 'trivia',
  difficulty: 'medium',
  answers: ['uranus'],
  ...overrides,
});

test.describe('authorization', () => {
  test('every admin write is refused without a token when auth is required', async () => {
    const { app } = buildTestApp({ adminAuth: true });

    await request(app).get('/api/admin/puzzles').expect(401);
    await request(app).post('/api/admin/puzzles').send(draft()).expect(401);
    await request(app).put('/api/admin/puzzles/test-puzzle').send(draft()).expect(401);
    await request(app).delete('/api/admin/puzzles/test-puzzle').expect(401);
    await request(app)
      .post('/api/admin/import')
      .send({ puzzles: [draft()] })
      .expect(401);
    await request(app).get('/api/admin/export').expect(401);
  });

  test('a wrong token is refused', async () => {
    const { app } = buildTestApp({ adminAuth: true });
    await request(app).get('/api/admin/puzzles').set('Authorization', 'Bearer wrong').expect(401);
    await request(app).get('/api/admin/puzzles').set('x-admin-token', 'wrong').expect(401);
  });

  test('the correct token is accepted as a bearer token or a header', async () => {
    const { app, adminToken } = buildTestApp({ adminAuth: true });
    await request(app).get('/api/admin/puzzles').set('Authorization', `Bearer ${adminToken}`).expect(200);
    await request(app).get('/api/admin/puzzles').set('x-admin-token', adminToken).expect(200);
  });

  test('the admin page redirects an anonymous visitor to the login screen', async () => {
    const { app } = buildTestApp({ adminAuth: true });
    const res = await request(app).get('/admin').expect(302);
    assert.match(res.headers.location, /^\/admin\/login/);
  });

  test('signing in with the right token issues an httpOnly session cookie', async () => {
    const { app, adminToken } = buildTestApp({ adminAuth: true });
    const res = await request(app).post('/admin/login').send({ token: adminToken }).expect(302);

    assert.equal(res.headers.location, '/admin');
    const cookie = res.headers['set-cookie'][0];
    assert.match(cookie, /bth_admin=/);
    assert.match(cookie, /HttpOnly/i);

    await request(app).get('/admin').set('Cookie', cookie).expect(200);
  });

  test('signing in with a wrong token bounces back to the login screen', async () => {
    const { app } = buildTestApp({ adminAuth: true });
    const res = await request(app).post('/admin/login').send({ token: 'nope' }).expect(302);
    assert.match(res.headers.location, /error=1/);
  });

  test('a login redirect only ever returns to a same-site path', async () => {
    const { app, adminToken } = buildTestApp({ adminAuth: true });
    const res = await request(app)
      .post('/admin/login')
      .send({ token: adminToken, next: 'https://evil.example.com/steal' })
      .expect(302);
    assert.equal(res.headers.location, '/admin');
  });
});

test.describe('creating puzzles', () => {
  test('creates a puzzle and derives its id from the question', async () => {
    const { app } = buildTestApp({ puzzles: [] });
    const res = await request(app).post('/api/admin/puzzles').send(draft()).expect(201);

    assert.equal(res.body.data.puzzle.id, 'which-planet-rotates-almost-entirely-on');
    assert.equal(res.body.data.puzzle.basePoints, 120, 'medium puzzles default to the medium base score');
    assert.equal(res.body.data.puzzle.isPublished, true);
  });

  test('the new puzzle is immediately playable', async () => {
    const { app } = buildTestApp({ puzzles: [] });
    const created = await request(app)
      .post('/api/admin/puzzles')
      .send(draft({ id: 'uranus' }));
    const play = await request(app).get('/api/puzzles/uranus').expect(200);

    assert.equal(play.body.data.puzzle.question, created.body.data.puzzle.question);
  });

  test('returns 422 with per-field issues the form can display inline', async () => {
    const { app } = buildTestApp({ puzzles: [] });
    const res = await request(app)
      .post('/api/admin/puzzles')
      .send(draft({ answers: [], question: 'hi' }))
      .expect(422);

    assert.equal(res.body.ok, false);
    const paths = res.body.details.issues.map((i) => i.path);
    assert.ok(paths.includes('answers'));
    assert.ok(paths.includes('question'));
  });

  test('returns 409 on a duplicate id', async () => {
    const { app } = buildTestApp();
    await request(app)
      .post('/api/admin/puzzles')
      .send(draft({ id: 'test-puzzle' }))
      .expect(409);
  });

  test('an unpublished puzzle is invisible to players but visible to the admin', async () => {
    const { app } = buildTestApp({ puzzles: [] });
    await request(app)
      .post('/api/admin/puzzles')
      .send(draft({ id: 'hidden', isPublished: false }))
      .expect(201);

    await request(app).get('/api/puzzles/hidden').expect(404);
    const admin = await request(app).get('/api/admin/puzzles').expect(200);
    assert.ok(admin.body.data.puzzles.some((p) => p.id === 'hidden'));
  });
});

test.describe('editing and deleting', () => {
  test('a partial update leaves untouched fields alone', async () => {
    const { app } = buildTestApp();
    const res = await request(app).put('/api/admin/puzzles/test-puzzle').send({ difficulty: 'hard' }).expect(200);

    const puzzle = res.body.data.puzzle;
    assert.equal(puzzle.difficulty, 'hard');
    assert.deepEqual(puzzle.answers, ['piano'], 'answers must survive an update that omits them');
    assert.equal(puzzle.hints.length, 2);
  });

  test('updating an unknown puzzle is a 404', async () => {
    const { app } = buildTestApp();
    await request(app).put('/api/admin/puzzles/ghost').send({ difficulty: 'hard' }).expect(404);
  });

  test('deleting removes it from play', async () => {
    const { app } = buildTestApp();
    await request(app).delete('/api/admin/puzzles/test-puzzle').expect(200);
    await request(app).get('/api/puzzles/test-puzzle').expect(404);
    await request(app).delete('/api/admin/puzzles/test-puzzle').expect(404);
  });
});

test.describe('the draft tester', () => {
  test('grades sample answers against an unsaved draft', async () => {
    const { app } = buildTestApp({ puzzles: [] });
    const res = await request(app)
      .post('/api/admin/puzzles/validate')
      .send({ ...draft(), sampleAnswers: ['Uranus', 'an uranus', 'Neptune'] })
      .expect(200);

    assert.equal(res.body.data.valid, true);
    assert.deepEqual(
      res.body.data.samples.map((s) => s.correct),
      [true, true, false]
    );
  });

  test('reports validation issues instead of grading an invalid draft', async () => {
    const { app } = buildTestApp({ puzzles: [] });
    const res = await request(app)
      .post('/api/admin/puzzles/validate')
      .send({ ...draft({ answers: [] }), sampleAnswers: ['x'] })
      .expect(200);

    assert.equal(res.body.data.valid, false);
    assert.ok(res.body.data.issues.length > 0);
  });

  test('does not save the draft it tested', async () => {
    const { app } = buildTestApp({ puzzles: [] });
    await request(app)
      .post('/api/admin/puzzles/validate')
      .send({ ...draft({ id: 'temp' }), sampleAnswers: ['x'] });
    const list = await request(app).get('/api/admin/puzzles');
    assert.equal(list.body.data.total, 0);
  });
});

test.describe('import and export', () => {
  test('imports valid puzzles and reports the rejected ones', async () => {
    const { app } = buildTestApp({ puzzles: [] });
    const res = await request(app)
      .post('/api/admin/import')
      .send({ puzzles: [draft({ id: 'good-one' }), { question: 'too short' }] })
      .expect(200);

    assert.equal(res.body.data.created, 1);
    assert.equal(res.body.data.rejected.length, 1);
    assert.equal(res.body.data.rejected[0].index, 1);
  });

  test('re-importing the same puzzle updates rather than duplicates it', async () => {
    const { app } = buildTestApp({ puzzles: [] });
    await request(app)
      .post('/api/admin/import')
      .send({ puzzles: [draft({ id: 'repeat' })] });
    const second = await request(app)
      .post('/api/admin/import')
      .send({ puzzles: [draft({ id: 'repeat', difficulty: 'hard' })] })
      .expect(200);

    assert.equal(second.body.data.updated, 1);
    assert.equal(second.body.data.created, 0);

    const list = await request(app).get('/api/admin/puzzles');
    assert.equal(list.body.data.total, 1);
    assert.equal(list.body.data.puzzles[0].difficulty, 'hard');
  });

  test('rejects an empty or malformed import body', async () => {
    const { app } = buildTestApp({ puzzles: [] });
    await request(app).post('/api/admin/import').send({}).expect(400);
    await request(app).post('/api/admin/import').send({ puzzles: [] }).expect(400);
  });

  test('exports a document that can be imported straight back', async () => {
    const { app } = buildTestApp();
    const res = await request(app).get('/api/admin/export').expect(200);

    assert.equal(res.body.count, 1);
    assert.match(res.headers['content-disposition'], /brain-teaser-puzzles\.json/);

    const reimport = await request(app).post('/api/admin/import').send({ puzzles: res.body.puzzles }).expect(200);
    assert.equal(reimport.body.data.updated, 1);
  });
});

test.describe('the catalogue summary', () => {
  test('counts published, drafts and hint coverage', async () => {
    const { app } = buildTestApp({
      puzzles: [
        makePuzzle({ id: 'a', type: 'logic', difficulty: 'easy' }),
        makePuzzle({ id: 'b', type: 'math', difficulty: 'hard', hints: [] }),
        makePuzzle({ id: 'c', isPublished: false }),
      ],
    });

    const res = await request(app).get('/api/admin/summary').expect(200);
    const { catalogue } = res.body.data;

    assert.equal(catalogue.total, 3);
    assert.equal(catalogue.published, 2);
    assert.equal(catalogue.drafts, 1);
    assert.equal(catalogue.withHints, 2);
    assert.equal(catalogue.byType.logic, 1);
    assert.equal(catalogue.byDifficulty.hard, 1);
  });
});
