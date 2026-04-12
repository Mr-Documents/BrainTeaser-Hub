const path = require('path');
const express = require('express');
const { validateAnswer } = require('./lib/validateAnswer');
const { computePointsEarned } = require('./lib/scoring');
const { pickRandomPuzzle } = require('./lib/randomPuzzle');
const attemptStore = require('./lib/attemptStore');
const store = require('./lib/store');

const app = express();
const PORT = process.env.PORT || 3000;

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

function ok(res, data) {
  res.json({ ok: true, data });
}

function fail(res, status, message) {
  res.status(status).json({ ok: false, error: message });
}

function findPuzzleById(id) {
  return store.readPuzzles().find((p) => p.id === id) || null;
}

app.get('/', (req, res) => {
  const leaderboard = store.getLeaderboard(10);
  const stats = store.readStats();
  res.render('index', {
    leaderboard,
    stats,
    navActive: 'home',
    pageTitle: 'Brain Teaser Hub',
    challenge: null,
  });
});

app.get('/admin', (req, res) => {
  const puzzles = store.readPuzzles();
  res.render('admin', { puzzles, navActive: 'admin', pageTitle: 'Admin · Brain Teaser Hub' });
});

app.get('/api/puzzles/random', (req, res) => {
  const type = req.query.type || '';
  const difficulty = req.query.difficulty || '';
  const excludeParam = req.query.exclude || '';
  const exclude = excludeParam
    ? String(excludeParam)
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
    : [];

  const puzzles = store.readPuzzles();
  const puzzle = pickRandomPuzzle(puzzles, { type: type || undefined, difficulty: difficulty || undefined, exclude });
  if (!puzzle) {
    return fail(res, 404, 'No puzzle matches filters (or pool exhausted). Clear filters or reset excludes.');
  }
  const attemptToken = attemptStore.createAttempt(puzzle.id);
  ok(res, { puzzle: store.publicPuzzle(puzzle), attemptToken });
});

app.get('/api/puzzles/:id/hint', (req, res) => {
  const puzzle = findPuzzleById(req.params.id);
  if (!puzzle) return fail(res, 404, 'Puzzle not found');
  const hints = Array.isArray(puzzle.hints) ? puzzle.hints : [];
  if (hints.length === 0) return fail(res, 400, 'This puzzle has no hints');

  const token = req.query.attemptToken || req.body?.attemptToken;
  const next = attemptStore.takeNextHint(token, puzzle.id, hints);
  if (!next) {
    return fail(res, 400, 'Invalid attempt token, or no more hints');
  }
  ok(res, { hint: next.text, step: next.step, total: next.total, hintsRevealed: next.step });
});

/** Start a play session for a specific puzzle (e.g. shared challenge link). */
app.get('/api/puzzles/:id', (req, res) => {
  const puzzle = findPuzzleById(req.params.id);
  if (!puzzle) return fail(res, 404, 'Puzzle not found');
  const attemptToken = attemptStore.createAttempt(puzzle.id);
  ok(res, { puzzle: store.publicPuzzle(puzzle), attemptToken });
});

app.get('/challenge/:id', (req, res) => {
  const id = String(req.params.id || '').trim();
  if (!id) {
    return res.status(404).render('not-found', {
      navActive: 'home',
      pageTitle: 'Challenge not found · Brain Teaser Hub',
      message: 'That challenge link is missing a puzzle id.',
    });
  }
  const puzzle = findPuzzleById(id);
  if (!puzzle) {
    return res.status(404).render('not-found', {
      navActive: 'home',
      pageTitle: 'Puzzle not found · Brain Teaser Hub',
      message: 'There is no puzzle with that id. It may have been removed.',
    });
  }
  const leaderboard = store.getLeaderboard(10);
  const stats = store.readStats();
  res.render('index', {
    leaderboard,
    stats,
    navActive: 'home',
    pageTitle: 'Challenge · Brain Teaser Hub',
    challenge: { id: puzzle.id },
  });
});

app.post('/api/submit', (req, res) => {
  const { puzzleId, answer, username, attemptToken } = req.body || {};
  if (!puzzleId || answer === undefined || answer === null) {
    return fail(res, 400, 'puzzleId and answer are required');
  }
  const puzzle = findPuzzleById(puzzleId);
  if (!puzzle) return fail(res, 404, 'Puzzle not found');

  const token = attemptToken;
  const attempt = attemptStore.getAttempt(token);
  if (!attempt || attempt.puzzleId !== puzzleId) {
    return fail(res, 400, 'Invalid or missing attemptToken — fetch a new puzzle');
  }

  const { correct } = validateAnswer(String(answer), puzzle);

  if (!correct) {
    attemptStore.recordWrongSubmission(token, puzzleId);
    store.recordWrongGuess();
    const hintsUsed = attemptStore.hintsRevealedCount(token, puzzleId);
    return ok(res, {
      correct: false,
      message: 'Not quite — try again!',
      hintsRevealed: hintsUsed,
      wrongSubmissions: attemptStore.wrongCount(token, puzzleId),
    });
  }

  const solvedState = attemptStore.markSolved(token, puzzleId);
  if (solvedState.alreadySolved) {
    return ok(res, {
      correct: true,
      alreadySolved: true,
      pointsEarned: 0,
      message: 'You already solved this one — load a new puzzle for more points.',
      hintsRevealed: attemptStore.hintsRevealedCount(token, puzzleId),
      wrongSubmissions: attemptStore.wrongCount(token, puzzleId),
    });
  }

  const hintsRevealed = attemptStore.hintsRevealedCount(token, puzzleId);
  const wrongSubmissions = attemptStore.wrongCount(token, puzzleId);
  const pointsEarned = computePointsEarned(puzzle.basePoints, hintsRevealed, wrongSubmissions);
  const name = String(username || 'Anonymous').trim() || 'Anonymous';
  const leaderboard = store.addScore(name, pointsEarned);
  const stats = store.recordCorrectSolve(puzzle);

  ok(res, {
    correct: true,
    alreadySolved: false,
    pointsEarned,
    hintsRevealed,
    wrongSubmissions,
    basePoints: puzzle.basePoints,
    message: pointsEarned > 0 ? `Nice! +${pointsEarned} points` : 'Correct — but penalties brought this solve to 0 points.',
    leaderboard: leaderboard.slice(0, 10),
    stats,
  });
});

app.get('/api/leaderboard', (req, res) => {
  const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 10));
  ok(res, { entries: store.getLeaderboard(limit) });
});

app.get('/api/stats', (req, res) => {
  ok(res, store.readStats());
});

app.get('/api/puzzles', (req, res) => {
  const puzzles = store.readPuzzles().map((p) => store.publicPuzzle(p));
  ok(res, { puzzles });
});

app.post('/api/puzzles', (req, res) => {
  const body = req.body || {};
  const id = String(body.id || '').trim();
  if (!id) return fail(res, 400, 'id is required');
  const puzzles = store.readPuzzles();
  if (puzzles.some((p) => p.id === id)) return fail(res, 409, 'Puzzle id already exists');
  const puzzle = normalizePuzzlePayload(body, id);
  puzzles.push(puzzle);
  store.writePuzzles(puzzles);
  ok(res, { puzzle });
});

app.put('/api/puzzles/:id', (req, res) => {
  const id = req.params.id;
  const puzzles = store.readPuzzles();
  const idx = puzzles.findIndex((p) => p.id === id);
  if (idx === -1) return fail(res, 404, 'Puzzle not found');
  const puzzle = normalizePuzzlePayload({ ...puzzles[idx], ...req.body, id }, id);
  puzzles[idx] = puzzle;
  store.writePuzzles(puzzles);
  ok(res, { puzzle });
});

app.delete('/api/puzzles/:id', (req, res) => {
  const id = req.params.id;
  const all = store.readPuzzles();
  const puzzles = all.filter((p) => p.id !== id);
  if (puzzles.length === all.length) return fail(res, 404, 'Puzzle not found');
  store.writePuzzles(puzzles);
  ok(res, { deleted: id });
});

function normalizePuzzlePayload(body, id) {
  const hints = Array.isArray(body.hints) ? body.hints.map(String) : [];
  const answers = Array.isArray(body.answers) ? body.answers.map(String) : [String(body.answer || 'yes')];
  return {
    id,
    question: String(body.question || ''),
    type: String(body.type || 'logic'),
    difficulty: String(body.difficulty || 'medium'),
    answers,
    matchMode: ['exact', 'partial', 'regex'].includes(body.matchMode) ? body.matchMode : 'exact',
    hints,
    basePoints: Number(body.basePoints) || 100,
  };
}

app.use((err, req, res, next) => {
  console.error(err);
  fail(res, 500, 'Server error');
});

const server = app.listen(PORT, () => {
  console.log(`Brain Teaser Hub http://localhost:${PORT}`);
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(
      `Port ${PORT} is already in use. Stop the other process or run with a different port, e.g. set PORT=3001`
    );
  } else {
    console.error(err);
  }
  process.exit(1);
});
