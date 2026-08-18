'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createAttemptStore } = require('../../src/lib/attemptStore');

const HINTS = ['first hint', 'second hint'];

test('a fresh attempt starts with no hints, no wrong guesses and unsolved', () => {
  const store = createAttemptStore();
  const token = store.create('p1');

  assert.equal(store.hintsRevealed(token, 'p1'), 0);
  assert.equal(store.wrongCount(token, 'p1'), 0);
  assert.equal(store.get(token, 'p1').solved, false);
});

test('a token is scoped to its puzzle and cannot be reused on another', () => {
  const store = createAttemptStore();
  const token = store.create('p1');

  assert.equal(store.get(token, 'p2'), null);
  assert.equal(store.takeNextHint(token, 'p2', HINTS), null);
  assert.equal(store.hintsRevealed(token, 'p2'), 0);
});

test('an unknown or missing token yields nothing rather than throwing', () => {
  const store = createAttemptStore();
  assert.equal(store.get('nope', 'p1'), null);
  assert.equal(store.get(undefined), null);
  assert.equal(store.hintsRevealed('nope', 'p1'), 0);
});

test('hints are handed out in order, once each, and then run out', () => {
  const store = createAttemptStore();
  const token = store.create('p1');

  assert.deepEqual(store.takeNextHint(token, 'p1', HINTS), { text: 'first hint', step: 1, total: 2 });
  assert.deepEqual(store.takeNextHint(token, 'p1', HINTS), { text: 'second hint', step: 2, total: 2 });
  assert.equal(store.takeNextHint(token, 'p1', HINTS), null, 'a third request must be refused');
  assert.equal(store.hintsRevealed(token, 'p1'), 2);
});

test('a puzzle with no hints never yields one', () => {
  const store = createAttemptStore();
  const token = store.create('p1');
  assert.equal(store.takeNextHint(token, 'p1', []), null);
  assert.equal(store.takeNextHint(token, 'p1', undefined), null);
});

test('wrong submissions accumulate until the puzzle is solved, then stop counting', () => {
  const store = createAttemptStore();
  const token = store.create('p1');

  assert.equal(store.recordWrong(token, 'p1'), 1);
  assert.equal(store.recordWrong(token, 'p1'), 2);

  store.markSolved(token, 'p1');
  assert.equal(store.recordWrong(token, 'p1'), 0, 'post-solve guesses must not be penalised');
  assert.equal(store.wrongCount(token, 'p1'), 2);
});

test('marking solved twice reports the repeat and times only the first solve', () => {
  const store = createAttemptStore();
  const token = store.create('p1');

  const first = store.markSolved(token, 'p1');
  assert.equal(first.alreadySolved, false);
  assert.equal(typeof first.durationMs, 'number');

  assert.deepEqual(store.markSolved(token, 'p1'), { alreadySolved: true, durationMs: null });
});

test('solve duration is measured from when the puzzle was served', () => {
  let clock = 1_000;
  const store = createAttemptStore({ now: () => clock });
  const token = store.create('p1');

  clock += 7_500;
  assert.equal(store.markSolved(token, 'p1').durationMs, 7_500);
});

test('an attempt older than the TTL is treated as gone', () => {
  let clock = 0;
  const store = createAttemptStore({ ttlMs: 1_000, now: () => clock });
  const token = store.create('p1');

  clock = 999;
  assert.ok(store.get(token, 'p1'), 'still inside the TTL');

  clock = 1_001;
  assert.equal(store.get(token, 'p1'), null, 'expired attempts must not be usable');
});

test('the store evicts the oldest attempts rather than growing without bound', () => {
  const store = createAttemptStore({ maxEntries: 5 });
  for (let i = 0; i < 50; i += 1) store.create(`p${i}`);
  assert.ok(store.size() <= 6, `expected the store to stay bounded, saw ${store.size()}`);
});

test('tokens are unique across attempts', () => {
  const store = createAttemptStore();
  const tokens = new Set();
  for (let i = 0; i < 200; i += 1) tokens.add(store.create('p1'));
  assert.equal(tokens.size, 200);
});
