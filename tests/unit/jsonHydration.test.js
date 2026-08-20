'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createJsonRepository } = require('../../src/repositories/jsonRepository');

/**
 * The JSON driver hydrates itself from the seed catalogue.
 *
 * This exists because data/puzzles.json used to be a tracked file that the admin UI also wrote
 * to. It silently drifted from data/puzzles.seed.json - one puzzle went missing and the drift
 * was committed. The store is now generated, and these tests hold the three properties that
 * make that safe.
 */

const SEED = {
  puzzles: [
    {
      id: 'seed-one',
      question: 'A question long enough to be valid.',
      type: 'logic',
      difficulty: 'easy',
      answers: ['a'],
      basePoints: 80,
    },
    {
      id: 'seed-two',
      question: 'Another question long enough to be valid.',
      type: 'math',
      difficulty: 'hard',
      answers: ['b'],
      basePoints: 180,
    },
  ],
};

/** A throwaway data directory containing only the seed catalogue. */
function freshDataDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bth-hydrate-'));
  fs.writeFileSync(path.join(dir, 'puzzles.seed.json'), JSON.stringify(SEED), 'utf8');
  return dir;
}

const count = async (repo) => (await repo.listPuzzles({ includeUnpublished: true })).total;

test('an empty data directory hydrates from the seed catalogue', async (t) => {
  const dir = freshDataDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const repo = createJsonRepository({ dataDir: dir, persist: true });
  assert.equal(await count(repo), 2, 'a fresh clone must be playable with no setup step');
  await repo.flush();

  assert.ok(fs.existsSync(path.join(dir, 'puzzles.json')), 'the store is written back for the next boot');
});

test('a second boot reads the store rather than re-hydrating', async (t) => {
  const dir = freshDataDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const first = createJsonRepository({ dataDir: dir, persist: true });
  await first.createPuzzle({
    id: 'added-later',
    question: 'A puzzle added by the admin UI, long enough.',
    type: 'word',
    difficulty: 'easy',
    answers: ['x'],
    matchMode: 'exact',
    hints: [],
    explanation: null,
    basePoints: 80,
    isPublished: true,
    tags: [],
  });
  await first.flush();

  const second = createJsonRepository({ dataDir: dir, persist: true });
  assert.equal(await count(second), 3, 'an operator-added puzzle survives a restart');
});

test('hydration never resurrects a deleted puzzle', async (t) => {
  const dir = freshDataDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const first = createJsonRepository({ dataDir: dir, persist: true });
  await first.deletePuzzle('seed-one');
  await first.flush();

  const second = createJsonRepository({ dataDir: dir, persist: true });
  assert.equal(await count(second), 1);
  assert.equal(await second.getPuzzle('seed-one'), null, 'a deletion must be permanent');
});

test('an empty store is treated as unseeded, not as a deliberately empty catalogue', async (t) => {
  const dir = freshDataDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  fs.writeFileSync(path.join(dir, 'puzzles.json'), JSON.stringify({ puzzles: [] }), 'utf8');

  const repo = createJsonRepository({ dataDir: dir, persist: true });
  assert.equal(await count(repo), 2, 'an empty file is indistinguishable from a fresh install');
});

test('a missing seed catalogue degrades to empty rather than throwing', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bth-noseed-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  let repo;
  assert.doesNotThrow(() => {
    repo = createJsonRepository({ dataDir: dir, persist: true });
  });
  assert.equal(await count(repo), 0);
});

test('the in-memory driver never touches the filesystem', async (t) => {
  const dir = freshDataDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const repo = createJsonRepository({ dataDir: dir, persist: false, seed: { puzzles: [] } });
  assert.equal(await count(repo), 0, 'tests get exactly the catalogue they ask for');

  await repo.flush();
  assert.equal(fs.existsSync(path.join(dir, 'puzzles.json')), false, 'and nothing is written');
});

test('the shipped seed catalogue and the running store agree', async () => {
  // The drift that motivated all of the above: catch it here rather than in production.
  const dataDir = path.join(__dirname, '..', '..', 'data');
  const seed = JSON.parse(fs.readFileSync(path.join(dataDir, 'puzzles.seed.json'), 'utf8'));
  const ids = seed.puzzles.map((p) => p.id);

  assert.equal(new Set(ids).size, ids.length, 'the seed catalogue must not contain duplicate ids');
  assert.ok(ids.length >= 80, `expected a full catalogue, found ${ids.length}`);
});
