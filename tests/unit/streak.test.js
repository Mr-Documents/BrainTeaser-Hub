'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { nextStreak, isStreakStale } = require('../../src/domain/streak');

const NOW = '2026-03-14T10:00:00Z';

test('a player with no history starts at 1', () => {
  assert.equal(nextStreak(null, NOW), 1);
  assert.equal(nextStreak({ currentStreak: 0, lastSolvedAt: null }, NOW), 1);
});

test('solving again the same UTC day holds the streak steady', () => {
  assert.equal(nextStreak({ currentStreak: 4, lastSolvedAt: '2026-03-14T01:00:00Z' }, NOW), 4);
});

test('solving the next day extends the streak', () => {
  assert.equal(nextStreak({ currentStreak: 4, lastSolvedAt: '2026-03-13T23:00:00Z' }, NOW), 5);
});

test('missing a day restarts the streak at 1', () => {
  assert.equal(nextStreak({ currentStreak: 40, lastSolvedAt: '2026-03-12T10:00:00Z' }, NOW), 1);
  assert.equal(nextStreak({ currentStreak: 40, lastSolvedAt: '2025-01-01T10:00:00Z' }, NOW), 1);
});

test('a corrupt timestamp degrades to a fresh streak instead of NaN', () => {
  assert.equal(nextStreak({ currentStreak: 9, lastSolvedAt: 'not-a-date' }, NOW), 1);
});

test('staleness is only reported once more than a day has passed', () => {
  assert.equal(isStreakStale({ lastSolvedAt: '2026-03-13T23:00:00Z' }, NOW), false);
  assert.equal(isStreakStale({ lastSolvedAt: '2026-03-11T23:00:00Z' }, NOW), true);
  assert.equal(isStreakStale({ lastSolvedAt: null }, NOW), false);
});
