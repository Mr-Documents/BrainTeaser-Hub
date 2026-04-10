const fs = require('fs');
const path = require('path');

const DATA = path.join(__dirname, '..', 'data');
const PUZZLES_FILE = path.join(DATA, 'puzzles.json');
const SCORES_FILE = path.join(DATA, 'scores.json');
const STATS_FILE = path.join(DATA, 'stats.json');

function readJson(file, fallback) {
  try {
    const raw = fs.readFileSync(file, 'utf8');
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8');
}

function readPuzzles() {
  const data = readJson(PUZZLES_FILE, { puzzles: [] });
  return Array.isArray(data.puzzles) ? data.puzzles : [];
}

function writePuzzles(puzzles) {
  writeJson(PUZZLES_FILE, { puzzles });
}

function readScoresState() {
  const data = readJson(SCORES_FILE, { entries: [] });
  const entries = Array.isArray(data.entries) ? data.entries : [];
  return { entries };
}

function writeScoresState(state) {
  writeJson(SCORES_FILE, state);
}

/** @returns {Map<string, { username: string, totalScore: number }>} */
function scoresMapFromEntries(entries) {
  const m = new Map();
  for (const e of entries) {
    if (e && e.username) m.set(e.username, { username: e.username, totalScore: Number(e.totalScore) || 0 });
  }
  return m;
}

function addScore(username, delta) {
  const state = readScoresState();
  const map = scoresMapFromEntries(state.entries);
  const u = String(username || 'Anonymous').trim() || 'Anonymous';
  const prev = map.get(u) || { username: u, totalScore: 0 };
  prev.totalScore = (Number(prev.totalScore) || 0) + Math.max(0, delta);
  map.set(u, prev);
  const entries = Array.from(map.values()).sort((a, b) => {
    if (b.totalScore !== a.totalScore) return b.totalScore - a.totalScore;
    return a.username.localeCompare(b.username);
  });
  writeScoresState({ entries });
  return entries;
}

function getLeaderboard(limit = 10) {
  const { entries } = readScoresState();
  const sorted = [...entries].sort((a, b) => {
    if ((b.totalScore || 0) !== (a.totalScore || 0)) return (b.totalScore || 0) - (a.totalScore || 0);
    return String(a.username).localeCompare(String(b.username));
  });
  return sorted.slice(0, Math.max(1, Math.min(100, limit)));
}

const defaultStats = () => ({
  completionsByType: { logic: 0, math: 0, word: 0 },
  completionsByDifficulty: { easy: 0, medium: 0, hard: 0 },
  totalSolves: 0,
  correctVsWrong: { correct: 0, wrong: 0 },
});

function readStats() {
  const data = readJson(STATS_FILE, defaultStats());
  const base = defaultStats();
  return {
    completionsByType: { ...base.completionsByType, ...(data.completionsByType || {}) },
    completionsByDifficulty: { ...base.completionsByDifficulty, ...(data.completionsByDifficulty || {}) },
    totalSolves: Number(data.totalSolves) || 0,
    correctVsWrong: {
      correct: Number(data.correctVsWrong?.correct) || 0,
      wrong: Number(data.correctVsWrong?.wrong) || 0,
    },
  };
}

function writeStats(stats) {
  writeJson(STATS_FILE, stats);
}

function recordWrongGuess() {
  const stats = readStats();
  stats.correctVsWrong.wrong = (stats.correctVsWrong.wrong || 0) + 1;
  writeStats(stats);
  return stats;
}

function recordCorrectSolve(puzzle) {
  const stats = readStats();
  stats.totalSolves = (stats.totalSolves || 0) + 1;
  const t = puzzle.type;
  if (t && stats.completionsByType[t] !== undefined) stats.completionsByType[t] += 1;
  const d = puzzle.difficulty;
  if (d && stats.completionsByDifficulty[d] !== undefined) stats.completionsByDifficulty[d] += 1;
  stats.correctVsWrong.correct = (stats.correctVsWrong.correct || 0) + 1;
  writeStats(stats);
  return stats;
}

function publicPuzzle(puzzle) {
  if (!puzzle) return null;
  const hints = Array.isArray(puzzle.hints) ? puzzle.hints : [];
  return {
    id: puzzle.id,
    question: puzzle.question,
    type: puzzle.type,
    difficulty: puzzle.difficulty,
    basePoints: puzzle.basePoints,
    matchMode: puzzle.matchMode,
    hintCount: hints.length,
    hasHints: hints.length > 0,
  };
}

module.exports = {
  readPuzzles,
  writePuzzles,
  getLeaderboard,
  addScore,
  readStats,
  recordWrongGuess,
  recordCorrectSolve,
  publicPuzzle,
};
