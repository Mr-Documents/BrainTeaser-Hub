'use strict';

const { z } = require('zod');
const { PUZZLE_TYPES, DIFFICULTIES, MATCH_MODES, DEFAULT_BASE_POINTS } = require('./constants');
const { isSafeRegexSource } = require('./answerMatcher');
const { ValidationError } = require('../lib/errors');

const SLUG_RE = /^[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$/;

/** Turn any title-ish string into a URL-safe, stable puzzle id. */
function slugify(input) {
  const base = String(input || '')
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64)
    .replace(/-+$/g, '');
  return base;
}

/** Derive a readable id from the question text, e.g. "what-has-keys-but-cant-open". */
function slugFromQuestion(question, maxWords = 6) {
  const words = slugify(question).split('-').filter(Boolean).slice(0, maxWords);
  return words.join('-');
}

const trimmedString = (max) =>
  z
    .string()
    .transform((s) => s.trim())
    .pipe(z.string().max(max));

const linesArray = z.union([z.string(), z.array(z.union([z.string(), z.number()]))]).transform((value) => {
  const arr = Array.isArray(value) ? value : String(value).split(/\r?\n/);
  return arr.map((s) => String(s).trim()).filter(Boolean);
});

const basePuzzleShape = {
  id: z
    .string()
    .transform((s) => slugify(s))
    .pipe(z.string().regex(SLUG_RE, 'id must be 3-64 chars: lowercase letters, numbers and hyphens')),
  question: trimmedString(2000).pipe(z.string().min(8, 'question must be at least 8 characters')),
  type: z.enum(PUZZLE_TYPES),
  difficulty: z.enum(DIFFICULTIES),
  answers: linesArray.pipe(z.array(z.string().min(1)).min(1, 'at least one answer is required').max(24)),
  matchMode: z.enum(MATCH_MODES).default('exact'),
  hints: linesArray.pipe(z.array(z.string().min(1)).max(5, 'at most 5 hints')).default([]),
  explanation: z
    .union([z.string(), z.null(), z.undefined()])
    .transform((s) => (s == null ? null : String(s).trim() || null))
    .default(null),
  basePoints: z.coerce.number().int().min(0).max(1000),
  isPublished: z.coerce.boolean().default(true),
  tags: linesArray.pipe(z.array(z.string().min(1)).max(10)).default([]),
};

const puzzleSchema = z.object(basePuzzleShape).superRefine((value, ctx) => {
  if (value.matchMode === 'regex') {
    value.answers.forEach((pattern, i) => {
      if (!isSafeRegexSource(pattern)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['answers', i],
          message: `"${pattern}" is not a valid or safe regular expression`,
        });
      }
    });
  }
});

/** Create/update payload: id may be derived from the question, base points from the difficulty. */
const puzzleInputSchema = z.preprocess((raw) => {
  const input = raw && typeof raw === 'object' ? { ...raw } : {};
  if (!input.id && input.question) input.id = slugFromQuestion(input.question);
  if (input.answer && !input.answers) input.answers = input.answer;
  if (input.basePoints === undefined || input.basePoints === '' || input.basePoints === null) {
    input.basePoints = DEFAULT_BASE_POINTS[input.difficulty] ?? 100;
  }
  return input;
}, puzzleSchema);

function formatIssues(error) {
  return error.issues.map((issue) => ({
    path: issue.path.join('.') || '(root)',
    message: issue.message,
  }));
}

/**
 * Validate and normalize an admin-supplied puzzle payload.
 * @throws {ValidationError} with a per-field issue list the admin UI renders inline.
 */
function parsePuzzle(payload) {
  const result = puzzleInputSchema.safeParse(payload);
  if (!result.success) throw new ValidationError(formatIssues(result.error));
  return result.data;
}

/** Same as parsePuzzle but returns a result object instead of throwing — used by the seed importer. */
function safeParsePuzzle(payload) {
  const result = puzzleInputSchema.safeParse(payload);
  return result.success ? { ok: true, data: result.data } : { ok: false, issues: formatIssues(result.error) };
}

/** Strip everything a player must not see (answers, hints, explanation). */
function toPublicPuzzle(puzzle) {
  if (!puzzle) return null;
  const hints = Array.isArray(puzzle.hints) ? puzzle.hints : [];
  return {
    id: puzzle.id,
    question: puzzle.question,
    type: puzzle.type,
    difficulty: puzzle.difficulty,
    basePoints: puzzle.basePoints,
    matchMode: puzzle.matchMode,
    tags: Array.isArray(puzzle.tags) ? puzzle.tags : [],
    hintCount: hints.length,
    hasHints: hints.length > 0,
  };
}

module.exports = {
  parsePuzzle,
  safeParsePuzzle,
  toPublicPuzzle,
  slugify,
  slugFromQuestion,
  puzzleInputSchema,
  SLUG_RE,
};
