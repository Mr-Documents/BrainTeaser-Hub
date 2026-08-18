'use strict';

/** Leading words that carry no meaning in an answer ("an echo" === "echo"). */
const LEADING_ARTICLES = /^(?:a|an|the)\s+/;

const NUMBER_WORDS = Object.freeze({
  zero: '0',
  one: '1',
  two: '2',
  three: '3',
  four: '4',
  five: '5',
  six: '6',
  seven: '7',
  eight: '8',
  nine: '9',
  ten: '10',
  eleven: '11',
  twelve: '12',
  thirteen: '13',
  fourteen: '14',
  fifteen: '15',
  sixteen: '16',
  seventeen: '17',
  eighteen: '18',
  nineteen: '19',
  twenty: '20',
  thirty: '30',
  forty: '40',
  fifty: '50',
  sixty: '60',
  seventy: '70',
  eighty: '80',
  ninety: '90',
  hundred: '100',
  thousand: '1000',
});

/** Nested quantifiers are the classic catastrophic-backtracking shape - refuse those patterns. */
const RISKY_REGEX = /\([^)]*[+*][^)]*\)\s*[+*]|\[[^\]]*\]\s*[+*]\s*[+*]/;
const MAX_REGEX_LENGTH = 200;

/**
 * Casefold, strip accents and punctuation, collapse whitespace.
 * @param {unknown} value
 * @returns {string}
 */
function normalize(value) {
  if (typeof value !== 'string') return '';
  return value
    .normalize('NFKD')
    .replace(/\p{M}/gu, '') // combining accents left over from NFKD
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s'-]/gu, ' ') // keep letters, digits, apostrophes, hyphens
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Comparison form: drop a leading article and apostrophes/hyphens, and turn spelled-out
 * numbers into digits so "eight" matches "8".
 * @param {unknown} value
 */
function canonicalize(value) {
  const base = normalize(value).replace(LEADING_ARTICLES, '');
  const collapsed = base.replace(/['-]/g, '');
  const words = collapsed.split(' ').filter(Boolean);
  return words.map((w) => NUMBER_WORDS[w] ?? w).join(' ');
}

function escapeRegex(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** @returns {boolean} true when the pattern is short and free of catastrophic-backtracking shapes. */
function isSafeRegexSource(source) {
  if (typeof source !== 'string' || source.length === 0) return false;
  if (source.length > MAX_REGEX_LENGTH) return false;
  if (RISKY_REGEX.test(source)) return false;
  try {
    new RegExp(source, 'i');
    return true;
  } catch {
    return false;
  }
}

function matchRegex(raw, patterns) {
  const subject = String(raw).trim();
  for (const pattern of patterns) {
    if (!isSafeRegexSource(pattern)) continue;
    if (new RegExp(pattern, 'i').test(subject)) return true;
  }
  return false;
}

/**
 * Compare a player's answer against a puzzle's accepted answers.
 *
 * - `exact`   - canonical equality (case, accents, punctuation, articles and number words are forgiving).
 * - `partial` - the accepted answer appears inside the submission (or vice-versa), on word boundaries.
 * - `regex`   - every accepted answer is treated as a case-insensitive pattern.
 *
 * @param {string} userAnswer
 * @param {{ answers?: string[], matchMode?: string }} puzzle
 * @returns {{ correct: boolean, matched: string|null }}
 */
function matchAnswer(userAnswer, puzzle) {
  const answers = Array.isArray(puzzle?.answers) ? puzzle.answers.map(String) : [];
  const mode = puzzle?.matchMode || 'exact';
  const raw = typeof userAnswer === 'string' ? userAnswer : '';

  if (answers.length === 0) return { correct: false, matched: null };
  if (mode === 'regex') return { correct: matchRegex(raw, answers), matched: null };

  const submitted = canonicalize(raw);
  if (!submitted) return { correct: false, matched: null };

  for (const answer of answers) {
    const candidate = canonicalize(answer);
    if (!candidate) continue;

    if (mode === 'partial') {
      // Word-boundary containment, so "art" does not match "start".
      const inSubmission = new RegExp(`(?:^|\\s)${escapeRegex(candidate)}(?:\\s|$)`).test(submitted);
      const inAnswer = new RegExp(`(?:^|\\s)${escapeRegex(submitted)}(?:\\s|$)`).test(candidate);
      if (inSubmission || inAnswer) return { correct: true, matched: answer };
    } else if (candidate === submitted) {
      return { correct: true, matched: answer };
    }
  }

  return { correct: false, matched: null };
}

/** Back-compat alias kept so older call sites keep reading naturally. */
const validateAnswer = matchAnswer;

module.exports = { matchAnswer, validateAnswer, normalize, canonicalize, isSafeRegexSource };
