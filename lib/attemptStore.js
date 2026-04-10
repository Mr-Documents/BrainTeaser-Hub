const crypto = require('crypto');

/** @type {Map<string, { puzzleId: string, hintStep: number, wrongSubmissions: number, solved: boolean }>} */
const attempts = new Map();

const TTL_MS = 1000 * 60 * 60 * 4;

function prune() {
  const now = Date.now();
  for (const [token, meta] of attempts.entries()) {
    if (meta.createdAt && now - meta.createdAt > TTL_MS) attempts.delete(token);
  }
}

function createAttempt(puzzleId) {
  prune();
  const token = crypto.randomUUID();
  attempts.set(token, {
    puzzleId,
    hintStep: 0,
    wrongSubmissions: 0,
    solved: false,
    createdAt: Date.now(),
  });
  return token;
}

function getAttempt(token) {
  if (!token) return null;
  prune();
  return attempts.get(token) || null;
}

function assertAttemptForPuzzle(token, puzzleId) {
  const a = getAttempt(token);
  if (!a || a.puzzleId !== puzzleId) return null;
  return a;
}

/**
 * @returns {{ text: string, step: number, total: number } | null}
 */
function takeNextHint(token, puzzleId, hintList) {
  const a = assertAttemptForPuzzle(token, puzzleId);
  if (!a || !hintList || hintList.length === 0) return null;
  if (a.hintStep >= hintList.length) return null;
  const text = hintList[a.hintStep];
  a.hintStep += 1;
  return { text, step: a.hintStep, total: hintList.length };
}

function hintsRevealedCount(token, puzzleId) {
  const a = assertAttemptForPuzzle(token, puzzleId);
  if (!a) return 0;
  return a.hintStep;
}

function recordWrongSubmission(token, puzzleId) {
  const a = assertAttemptForPuzzle(token, puzzleId);
  if (!a || a.solved) return false;
  a.wrongSubmissions += 1;
  return true;
}

function markSolved(token, puzzleId) {
  const a = assertAttemptForPuzzle(token, puzzleId);
  if (!a) return { alreadySolved: false, wasSolved: false };
  if (a.solved) return { alreadySolved: true, wasSolved: true };
  a.solved = true;
  return { alreadySolved: false, wasSolved: true };
}

function wrongCount(token, puzzleId) {
  const a = assertAttemptForPuzzle(token, puzzleId);
  return a ? a.wrongSubmissions : 0;
}

module.exports = {
  createAttempt,
  getAttempt,
  takeNextHint,
  hintsRevealedCount,
  recordWrongSubmission,
  markSolved,
  wrongCount,
};
