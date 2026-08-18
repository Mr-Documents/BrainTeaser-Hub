'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');

const { buildTestApp, makePuzzle, signIn } = require('../helpers/testApp');

test.describe('GET /api/puzzles/random', () => {
  test('serves a puzzle with an attempt token, and never the answers', async () => {
    const { app } = buildTestApp();
    const res = await request(app).get('/api/puzzles/random').expect(200);

    assert.equal(res.body.ok, true);
    assert.ok(res.body.data.attemptToken, 'an attempt token is required to submit');
    assert.equal(res.body.data.puzzle.id, 'test-puzzle');
    assert.equal(res.body.data.puzzle.answers, undefined);
    assert.equal(res.body.data.puzzle.hints, undefined);
    assert.equal(res.body.data.puzzle.hintCount, 2);
  });

  test('honours the type and difficulty filters', async () => {
    const { app } = buildTestApp({
      puzzles: [
        makePuzzle({ id: 'easy-logic', type: 'logic', difficulty: 'easy' }),
        makePuzzle({ id: 'hard-math', type: 'math', difficulty: 'hard' }),
      ],
    });

    const byType = await request(app).get('/api/puzzles/random?type=math').expect(200);
    assert.equal(byType.body.data.puzzle.id, 'hard-math');

    const byDifficulty = await request(app).get('/api/puzzles/random?difficulty=easy').expect(200);
    assert.equal(byDifficulty.body.data.puzzle.id, 'easy-logic');
  });

  test('404s with a helpful message when the filters or exclusions empty the pool', async () => {
    const { app } = buildTestApp();
    const res = await request(app).get('/api/puzzles/random?exclude=test-puzzle').expect(404);
    assert.equal(res.body.ok, false);
    assert.match(res.body.error, /Reset seen/);
  });

  test('ignores a filter value that is not a known option instead of erroring', async () => {
    const { app } = buildTestApp();
    await request(app).get('/api/puzzles/random?type=nonsense').expect(200);
  });

  test('never serves an unpublished puzzle', async () => {
    const { app } = buildTestApp({ puzzles: [makePuzzle({ id: 'draft', isPublished: false })] });
    await request(app).get('/api/puzzles/random').expect(404);
  });
});

test.describe('GET /api/puzzles/daily', () => {
  test('returns the same puzzle on repeated calls within a day', async () => {
    const { app } = buildTestApp({
      puzzles: [makePuzzle({ id: 'one' }), makePuzzle({ id: 'two' }), makePuzzle({ id: 'three' })],
    });

    const first = await request(app).get('/api/puzzles/daily').expect(200);
    const second = await request(app).get('/api/puzzles/daily').expect(200);

    assert.equal(first.body.data.puzzle.id, second.body.data.puzzle.id);
    assert.equal(first.body.data.isDaily, true);
    assert.ok(first.body.data.dayKey);
  });
});

test.describe('GET /api/puzzles/:id', () => {
  test('opens an attempt for a specific puzzle, for shared challenge links', async () => {
    const { app } = buildTestApp();
    const res = await request(app).get('/api/puzzles/test-puzzle').expect(200);
    assert.equal(res.body.data.puzzle.id, 'test-puzzle');
    assert.ok(res.body.data.attemptToken);
  });

  test('404s for an unknown id', async () => {
    const { app } = buildTestApp();
    const res = await request(app).get('/api/puzzles/does-not-exist').expect(404);
    assert.equal(res.body.ok, false);
  });
});

test.describe('hints', () => {
  test('are revealed one at a time and then refused', async () => {
    const { app } = buildTestApp();
    const { body } = await request(app).get('/api/puzzles/random');
    const token = body.data.attemptToken;
    const url = `/api/puzzles/test-puzzle/hint?attemptToken=${token}`;

    const first = await request(app).get(url).expect(200);
    assert.equal(first.body.data.hint, 'It has 88 of them.');
    assert.equal(first.body.data.step, 1);
    assert.equal(first.body.data.remaining, 1);

    const second = await request(app).get(url).expect(200);
    assert.equal(second.body.data.step, 2);
    assert.equal(second.body.data.remaining, 0);

    await request(app).get(url).expect(400);
  });

  test('are refused without a valid attempt token', async () => {
    const { app } = buildTestApp();
    await request(app).get('/api/puzzles/test-puzzle/hint').expect(400);
    await request(app).get('/api/puzzles/test-puzzle/hint?attemptToken=forged').expect(400);
  });

  test('are refused for a puzzle that has none', async () => {
    const { app } = buildTestApp({ puzzles: [makePuzzle({ hints: [] })] });
    const { body } = await request(app).get('/api/puzzles/random');
    await request(app).get(`/api/puzzles/test-puzzle/hint?attemptToken=${body.data.attemptToken}`).expect(400);
  });
});

test.describe('POST /api/submit', () => {
  const startAttempt = async (app, id = 'test-puzzle') => {
    const { body } = await request(app).get(`/api/puzzles/${id}`);
    return body.data.attemptToken;
  };

  test('awards the full base score for a clean solve', async () => {
    const { app, issuedLinks } = buildTestApp();
    const { cookie } = await signIn(app, issuedLinks);
    const { body } = await request(app).get('/api/puzzles/test-puzzle').set('Cookie', cookie);

    const res = await request(app)
      .post('/api/submit')
      .set('Cookie', cookie)
      .send({ puzzleId: 'test-puzzle', answer: 'piano', attemptToken: body.data.attemptToken })
      .expect(200);

    const data = res.body.data;
    assert.equal(data.correct, true);
    assert.equal(data.alreadySolved, false);
    // 100 base, no penalties, plus the speed bonus for an instant solve.
    assert.ok(data.pointsEarned >= 100, `expected at least the base score, got ${data.pointsEarned}`);
    assert.equal(data.breakdown.hintPenalty, 0);
    assert.equal(data.explanation, 'A piano.');
    assert.equal(data.leaderboard[0].displayName, 'ada');
  });

  test('accepts a forgiving variant of the answer', async () => {
    const { app } = buildTestApp();
    const attemptToken = await startAttempt(app);
    const res = await request(app)
      .post('/api/submit')
      .send({ puzzleId: 'test-puzzle', answer: '  A PIANO! ', attemptToken })
      .expect(200);
    assert.equal(res.body.data.correct, true);
  });

  test('reports a wrong answer without revealing anything', async () => {
    const { app } = buildTestApp();
    const attemptToken = await startAttempt(app);

    const res = await request(app)
      .post('/api/submit')
      .send({ puzzleId: 'test-puzzle', answer: 'guitar', attemptToken })
      .expect(200);

    assert.equal(res.body.data.correct, false);
    assert.equal(res.body.data.wrongSubmissions, 1);
    assert.equal(res.body.data.explanation, undefined);
    assert.equal(res.body.data.pointsEarned, undefined);
  });

  test('charges the hint and wrong-guess penalties recorded on the server', async () => {
    const { app } = buildTestApp();
    const attemptToken = await startAttempt(app);

    await request(app).get(`/api/puzzles/test-puzzle/hint?attemptToken=${attemptToken}`);
    await request(app).post('/api/submit').send({ puzzleId: 'test-puzzle', answer: 'wrong', attemptToken });

    const res = await request(app)
      .post('/api/submit')
      .send({ puzzleId: 'test-puzzle', answer: 'piano', attemptToken })
      .expect(200);

    assert.equal(res.body.data.breakdown.hintPenalty, 15);
    assert.equal(res.body.data.breakdown.wrongPenalty, 10);
    assert.equal(res.body.data.hintsRevealed, 1);
    assert.equal(res.body.data.wrongSubmissions, 1);
  });

  test('scores a repeat solve of the same attempt at zero', async () => {
    const { app } = buildTestApp();
    const attemptToken = await startAttempt(app);
    const payload = { puzzleId: 'test-puzzle', answer: 'piano', username: 'Ada', attemptToken };

    const first = await request(app).post('/api/submit').send(payload).expect(200);
    const second = await request(app).post('/api/submit').send(payload).expect(200);

    assert.ok(first.body.data.pointsEarned > 0);
    assert.equal(second.body.data.alreadySolved, true);
    assert.equal(second.body.data.pointsEarned, 0);
  });

  test('rejects a submission with a forged, missing or foreign attempt token', async () => {
    const { app } = buildTestApp({ puzzles: [makePuzzle(), makePuzzle({ id: 'other' })] });

    await request(app).post('/api/submit').send({ puzzleId: 'test-puzzle', answer: 'piano' }).expect(400);
    await request(app)
      .post('/api/submit')
      .send({ puzzleId: 'test-puzzle', answer: 'piano', attemptToken: 'forged' })
      .expect(400);

    const foreign = await startAttempt(app, 'other');
    await request(app)
      .post('/api/submit')
      .send({ puzzleId: 'test-puzzle', answer: 'piano', attemptToken: foreign })
      .expect(400);
  });

  test('validates the request body', async () => {
    const { app } = buildTestApp();
    await request(app).post('/api/submit').send({}).expect(400);
    await request(app).post('/api/submit').send({ puzzleId: 'test-puzzle' }).expect(400);
  });

  test('404s for a puzzle that does not exist', async () => {
    const { app } = buildTestApp();
    await request(app)
      .post('/api/submit')
      .send({ puzzleId: 'ghost', answer: 'x', attemptToken: 'whatever' })
      .expect(404);
  });

  test('accumulates a player total across separate puzzles', async () => {
    const { app, issuedLinks } = buildTestApp({ puzzles: [makePuzzle({ id: 'one' }), makePuzzle({ id: 'two' })] });
    const { cookie } = await signIn(app, issuedLinks);

    for (const id of ['one', 'two']) {
      const { body } = await request(app).get(`/api/puzzles/${id}`).set('Cookie', cookie);
      await request(app)
        .post('/api/submit')
        .set('Cookie', cookie)
        .send({ puzzleId: id, answer: 'piano', attemptToken: body.data.attemptToken });
    }

    const res = await request(app).get('/api/leaderboard').expect(200);
    const ada = res.body.data.entries.find((e) => e.displayName === 'ada');
    assert.equal(ada.solves, 2);
    assert.ok(ada.totalScore >= 200);
    assert.equal(ada.rank, 1);
  });

  test('an anonymous solve creates no leaderboard entry at all', async () => {
    // Superseded the old "falls back to Anonymous" behaviour: a name in the body is now
    // ignored outright, so an unauthenticated solve simply has no owner to rank.
    const { app } = buildTestApp();
    const attemptToken = await startAttempt(app);
    await request(app)
      .post('/api/submit')
      .send({ puzzleId: 'test-puzzle', answer: 'piano', username: 'Impostor', attemptToken })
      .expect(200);

    const res = await request(app).get('/api/leaderboard');
    assert.deepEqual(res.body.data.entries, []);
  });
});

test.describe('read models', () => {
  test('stats count both correct and wrong submissions', async () => {
    const { app } = buildTestApp();
    const { body } = await request(app).get('/api/puzzles/test-puzzle');
    const attemptToken = body.data.attemptToken;

    await request(app).post('/api/submit').send({ puzzleId: 'test-puzzle', answer: 'nope', attemptToken });
    await request(app).post('/api/submit').send({ puzzleId: 'test-puzzle', answer: 'piano', attemptToken });

    const res = await request(app).get('/api/stats?fresh=1').expect(200);
    const stats = res.body.data;
    assert.equal(stats.correctVsWrong.correct, 1);
    assert.equal(stats.correctVsWrong.wrong, 1);
    assert.equal(stats.totalSolves, 1);
    assert.equal(stats.completionsByType.word, 1);
    assert.equal(stats.completionsByDifficulty.easy, 1);
  });

  test('the leaderboard limit is clamped to a sane range', async () => {
    const { app } = buildTestApp();
    await request(app).get('/api/leaderboard?limit=99999').expect(200);
    await request(app).get('/api/leaderboard?limit=-5').expect(200);
    await request(app).get('/api/leaderboard?limit=abc').expect(200);
  });

  test('a player profile 404s until they have scored', async () => {
    const { app } = buildTestApp();
    await request(app).get('/api/players/Ghost').expect(404);
  });

  test('health reports the active driver', async () => {
    const { app } = buildTestApp();
    const res = await request(app).get('/api/health').expect(200);
    assert.equal(res.body.data.ok, true);
    assert.equal(res.body.data.driver, 'memory');
  });
});
