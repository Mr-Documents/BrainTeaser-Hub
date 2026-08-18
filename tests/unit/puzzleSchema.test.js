'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { parsePuzzle, safeParsePuzzle, toPublicPuzzle, slugify } = require('../../src/domain/puzzleSchema');
const { ValidationError } = require('../../src/lib/errors');

const draft = (overrides = {}) => ({
  question: 'What has keys but cannot open a lock?',
  type: 'word',
  difficulty: 'easy',
  answers: ['piano'],
  ...overrides,
});

test('a minimal draft is accepted and filled in with sensible defaults', () => {
  const puzzle = parsePuzzle(draft());
  assert.equal(puzzle.matchMode, 'exact');
  assert.deepEqual(puzzle.hints, []);
  assert.deepEqual(puzzle.tags, []);
  assert.equal(puzzle.explanation, null);
  assert.equal(puzzle.isPublished, true);
  assert.equal(puzzle.basePoints, 80, 'easy puzzles default to the easy base score');
});

test('the id is derived from the question when the author does not supply one', () => {
  assert.equal(parsePuzzle(draft()).id, 'what-has-keys-but-cannot-open');
});

test('a supplied id is slugified rather than rejected', () => {
  assert.equal(parsePuzzle(draft({ id: 'My Great Puzzle!' })).id, 'my-great-puzzle');
});

test('answers and hints accept either an array or newline-separated text', () => {
  const fromText = parsePuzzle(draft({ answers: 'piano\n keyboard \n\n', hints: 'first\nsecond' }));
  assert.deepEqual(fromText.answers, ['piano', 'keyboard']);
  assert.deepEqual(fromText.hints, ['first', 'second']);
});

test('base points are coerced from the string an HTML form submits', () => {
  assert.equal(parsePuzzle(draft({ basePoints: '250' })).basePoints, 250);
});

test.describe('rejections', () => {
  const expectIssue = (payload, path) => {
    const result = safeParsePuzzle(payload);
    assert.equal(result.ok, false, 'expected the payload to be rejected');
    assert.ok(
      result.issues.some((issue) => issue.path.startsWith(path)),
      `expected an issue on "${path}", got ${JSON.stringify(result.issues)}`
    );
  };

  test('a too-short question', () => expectIssue(draft({ question: 'short' }), 'question'));
  test('an unknown type', () => expectIssue(draft({ type: 'philosophy' }), 'type'));
  test('an unknown difficulty', () => expectIssue(draft({ difficulty: 'impossible' }), 'difficulty'));
  test('no answers at all', () => expectIssue(draft({ answers: [] }), 'answers'));
  test('more than five hints', () => expectIssue(draft({ hints: ['1', '2', '3', '4', '5', '6'] }), 'hints'));
  test('base points beyond the cap', () => expectIssue(draft({ basePoints: 99999 }), 'basePoints'));

  test('an unsafe regex when the match mode is regex', () => {
    expectIssue(draft({ matchMode: 'regex', answers: ['(a+)+b'] }), 'answers');
  });

  test('parsePuzzle throws a ValidationError carrying the per-field issues', () => {
    assert.throws(
      () => parsePuzzle(draft({ answers: [] })),
      (err) => err instanceof ValidationError && err.status === 422 && Array.isArray(err.issues)
    );
  });
});

test('the public projection never leaks answers, hints or the explanation', () => {
  const puzzle = parsePuzzle(draft({ hints: ['a', 'b'], explanation: 'because piano' }));
  const publicView = toPublicPuzzle(puzzle);

  assert.equal(publicView.answers, undefined);
  assert.equal(publicView.hints, undefined);
  assert.equal(publicView.explanation, undefined);
  assert.equal(publicView.hintCount, 2, 'the count is safe to expose — the text is not');
  assert.equal(publicView.hasHints, true);
  assert.equal(publicView.question, puzzle.question);
});

test('slugify strips accents, punctuation and repeated separators', () => {
  assert.equal(slugify('Café — the BEST puzzle!!'), 'cafe-the-best-puzzle');
  assert.equal(slugify('  --already-a-slug--  '), 'already-a-slug');
});
