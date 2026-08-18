'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');

const { buildTestApp, makePuzzle } = require('../helpers/testApp');

test.describe('server-rendered pages', () => {
  const pages = [
    ['/', 'hand-picked brain teasers'],
    ['/play', 'Type your answer'],
    ['/daily', 'Daily challenge'],
    ['/leaderboard', 'Top 50 solvers'],
    ['/how-it-works', 'How scoring works'],
  ];

  for (const [path, marker] of pages) {
    test(`GET ${path} renders`, async () => {
      const { app } = buildTestApp();
      const res = await request(app).get(path).expect(200).expect('Content-Type', /html/);
      assert.match(res.text, new RegExp(marker));
      assert.match(res.text, /<html lang="en">/);
    });
  }

  test('every page ships a skip link and a labelled main region', async () => {
    const { app } = buildTestApp();
    const res = await request(app).get('/play');
    assert.match(res.text, /class="skip-link"/);
    assert.match(res.text, /id="main"/);
  });

  test('the home page shows real catalogue counts, not placeholders', async () => {
    const { app } = buildTestApp({
      puzzles: [makePuzzle({ id: 'a', difficulty: 'easy' }), makePuzzle({ id: 'b', difficulty: 'hard' })],
    });
    const res = await request(app).get('/');
    assert.match(res.text, /2 hand-picked brain teasers/);
  });
});

test.describe('challenge links', () => {
  test('render the play page for a real puzzle', async () => {
    const { app } = buildTestApp();
    const res = await request(app).get('/challenge/test-puzzle').expect(200);
    assert.match(res.text, /Someone challenged you/);
    assert.match(res.text, /"challengePuzzleId":"test-puzzle"/);
  });

  test('404 on the server for a puzzle that no longer exists', async () => {
    const { app } = buildTestApp();
    const res = await request(app).get('/challenge/deleted-puzzle').expect(404);
    assert.match(res.text, /no longer exists/);
  });

  test('404 for an unpublished puzzle', async () => {
    const { app } = buildTestApp({ puzzles: [makePuzzle({ id: 'draft', isPublished: false })] });
    await request(app).get('/challenge/draft').expect(404);
  });
});

test.describe('error handling', () => {
  test('an unknown page renders the HTML error view', async () => {
    const { app } = buildTestApp();
    const res = await request(app).get('/no-such-page').expect(404).expect('Content-Type', /html/);
    assert.match(res.text, /Nothing here/);
  });

  test('an unknown API route returns the JSON envelope, not HTML', async () => {
    const { app } = buildTestApp();
    const res = await request(app).get('/api/no-such-route').expect(404).expect('Content-Type', /json/);
    assert.equal(res.body.ok, false);
    assert.equal(res.body.code, 'not_found');
  });

  test('an internal failure is reported without leaking the cause', async () => {
    const { app, repository } = buildTestApp();
    repository.getLeaderboard = async () => {
      throw new Error('connection string is postgres://user:hunter2@db');
    };

    const res = await request(app).get('/api/leaderboard').expect(200);
    // The stats service degrades to an empty board rather than failing the request.
    assert.deepEqual(res.body.data.entries, []);
  });

  test('a repository failure on a required read surfaces as a clean 500', async () => {
    const { app, repository } = buildTestApp();
    repository.getPuzzle = async () => {
      throw new Error('secret internal detail');
    };

    const res = await request(app).get('/api/puzzles/test-puzzle').expect(500);
    assert.equal(res.body.ok, false);
    assert.doesNotMatch(JSON.stringify(res.body), /secret internal detail/);
  });
});

test.describe('security headers and infrastructure routes', () => {
  test('helmet headers are applied', async () => {
    const { app } = buildTestApp();
    const res = await request(app).get('/');
    assert.ok(res.headers['content-security-policy']);
    assert.equal(res.headers['x-content-type-options'], 'nosniff');
    assert.equal(res.headers['x-powered-by'], undefined);
  });

  test('every response carries a request id for tracing', async () => {
    const { app } = buildTestApp();
    const res = await request(app).get('/api/health');
    assert.ok(res.headers['x-request-id']);
  });

  test('/healthz answers for a load balancer', async () => {
    const { app } = buildTestApp();
    await request(app).get('/healthz').expect(200, { ok: true, status: 'up' });
  });

  test('robots.txt keeps the studio out of search results', async () => {
    const { app } = buildTestApp();
    const res = await request(app).get('/robots.txt').expect(200);
    assert.match(res.text, /Disallow: \/admin/);
  });
});
