'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { pickRandomPuzzle, pickDailyPuzzle, filterPuzzles } = require('../../src/domain/puzzlePicker');

const pool = [
  { id: 'a', type: 'logic', difficulty: 'easy', tags: ['classic'] },
  { id: 'b', type: 'math', difficulty: 'hard', tags: [] },
  { id: 'c', type: 'logic', difficulty: 'hard', tags: ['classic'] },
  { id: 'd', type: 'word', difficulty: 'easy', tags: [], isPublished: false },
];

test.describe('filtering', () => {
  test('drops unpublished puzzles', () => {
    assert.deepEqual(
      filterPuzzles(pool).map((p) => p.id),
      ['a', 'b', 'c']
    );
  });

  test('narrows by type, difficulty and tag', () => {
    assert.deepEqual(
      filterPuzzles(pool, { type: 'logic' }).map((p) => p.id),
      ['a', 'c']
    );
    assert.deepEqual(
      filterPuzzles(pool, { difficulty: 'hard' }).map((p) => p.id),
      ['b', 'c']
    );
    assert.deepEqual(
      filterPuzzles(pool, { tag: 'classic' }).map((p) => p.id),
      ['a', 'c']
    );
    assert.deepEqual(
      filterPuzzles(pool, { type: 'logic', difficulty: 'hard' }).map((p) => p.id),
      ['c']
    );
  });

  test('excludes ids the player has already seen', () => {
    assert.deepEqual(
      filterPuzzles(pool, { exclude: ['a', 'c'] }).map((p) => p.id),
      ['b']
    );
  });
});

test.describe('random selection', () => {
  test('returns null when nothing matches rather than throwing', () => {
    assert.equal(pickRandomPuzzle(pool, { type: 'trivia' }), null);
    assert.equal(pickRandomPuzzle([], {}), null);
    assert.equal(pickRandomPuzzle(pool, { exclude: ['a', 'b', 'c'] }), null);
  });

  test('uses the injected RNG, and never reads past the end of the pool', () => {
    assert.equal(pickRandomPuzzle(pool, {}, () => 0).id, 'a');
    assert.equal(pickRandomPuzzle(pool, {}, () => 0.99).id, 'c');
    assert.equal(pickRandomPuzzle(pool, {}, () => 1).id, 'c');
  });

  test('never returns an unpublished puzzle', () => {
    for (let i = 0; i < 50; i += 1) {
      assert.notEqual(pickRandomPuzzle(pool, {}).id, 'd');
    }
  });
});

test.describe('daily puzzle', () => {
  test('is stable for a given UTC day', () => {
    const first = pickDailyPuzzle(pool, '2026-03-14T01:00:00Z');
    const second = pickDailyPuzzle(pool, '2026-03-14T23:59:00Z');
    assert.equal(first.id, second.id);
  });

  test('does not depend on the order the puzzles arrive in', () => {
    const forwards = pickDailyPuzzle(pool, '2026-03-14T00:00:00Z');
    const backwards = pickDailyPuzzle([...pool].reverse(), '2026-03-14T00:00:00Z');
    assert.equal(forwards.id, backwards.id);
  });

  test('changes across the span of a month', () => {
    const picks = new Set();
    for (let day = 1; day <= 28; day += 1) {
      picks.add(pickDailyPuzzle(pool, `2026-03-${String(day).padStart(2, '0')}T12:00:00Z`).id);
    }
    assert.ok(picks.size > 1, 'the daily puzzle should not be the same all month');
  });

  test('returns null with an empty catalogue', () => {
    assert.equal(pickDailyPuzzle([], '2026-03-14T00:00:00Z'), null);
  });
});
