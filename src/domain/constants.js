'use strict';

/** Puzzle categories. Adding one here is enough for the UI, API and DB check constraint. */
const PUZZLE_TYPES = Object.freeze(['logic', 'math', 'word', 'lateral', 'trivia']);

/** Difficulty tiers - the "levels" players are grouped into. */
const DIFFICULTIES = Object.freeze(['easy', 'medium', 'hard']);

/** How a submitted answer is compared against the accepted answers. */
const MATCH_MODES = Object.freeze(['exact', 'partial', 'regex']);

const TYPE_LABELS = Object.freeze({
  logic: 'Logic',
  math: 'Math',
  word: 'Word',
  lateral: 'Lateral',
  trivia: 'Trivia',
});

const DIFFICULTY_LABELS = Object.freeze({
  easy: 'Easy',
  medium: 'Medium',
  hard: 'Hard',
});

/** Suggested base points per tier - used as the admin form default. */
const DEFAULT_BASE_POINTS = Object.freeze({ easy: 80, medium: 120, hard: 180 });

module.exports = {
  PUZZLE_TYPES,
  DIFFICULTIES,
  MATCH_MODES,
  TYPE_LABELS,
  DIFFICULTY_LABELS,
  DEFAULT_BASE_POINTS,
};
