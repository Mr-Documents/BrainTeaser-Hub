function normalize(str) {
  if (typeof str !== 'string') return '';
  return str.trim().toLowerCase().replace(/\s+/g, ' ');
}

/**
 * @param {string} userAnswer
 * @param {{ answers: string[], matchMode?: string }} puzzle
 * @returns {{ correct: boolean }}
 */
function validateAnswer(userAnswer, puzzle) {
  const mode = puzzle.matchMode || 'exact';
  const raw = typeof userAnswer === 'string' ? userAnswer : '';

  if (mode === 'regex') {
    for (const pattern of puzzle.answers || []) {
      try {
        const re = new RegExp(pattern, 'i');
        if (re.test(raw.trim())) return { correct: true };
      } catch {
        /* skip invalid pattern */
      }
    }
    return { correct: false };
  }

  const u = normalize(raw);
  const acceptable = (puzzle.answers || []).map((a) => normalize(String(a)));

  if (mode === 'partial') {
    const ok = acceptable.some((a) => a.length > 0 && (u.includes(a) || a.includes(u)));
    return { correct: ok };
  }

  const ok = acceptable.some((a) => a === u);
  return { correct: ok };
}

module.exports = { validateAnswer, normalize };
