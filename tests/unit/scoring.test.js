'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  computeScore,
  computePointsEarned,
  computeSpeedBonus,
  computeStreakMultiplier,
  PENALTY_PER_HINT,
  PENALTY_PER_WRONG,
  STREAK_MAX_MULTIPLIER,
} = require('../../src/domain/scoring');

test('a clean solve with no timing information earns exactly the base points', () => {
  assert.equal(computePointsEarned(100, 0, 0), 100);
});

test('each hint costs PENALTY_PER_HINT and each wrong guess costs PENALTY_PER_WRONG', () => {
  assert.equal(computePointsEarned(100, 1, 0), 100 - PENALTY_PER_HINT);
  assert.equal(computePointsEarned(100, 0, 1), 100 - PENALTY_PER_WRONG);
  assert.equal(computePointsEarned(100, 2, 3), 100 - 2 * PENALTY_PER_HINT - 3 * PENALTY_PER_WRONG);
});

test('the score floors at zero rather than going negative', () => {
  assert.equal(computePointsEarned(50, 10, 10), 0);
});

test('non-numeric or negative inputs are coerced instead of throwing', () => {
  assert.equal(computePointsEarned(undefined, undefined, undefined), 0);
  assert.equal(computePointsEarned('120', -5, -5), 120);
});

test.describe('speed bonus', () => {
  test('is the full 25% of base inside the fast window', () => {
    assert.equal(computeSpeedBonus(200, 5_000), 50);
    assert.equal(computeSpeedBonus(200, 20_000), 50);
  });

  test('tapers linearly and reaches zero at the cutoff', () => {
    const midpoint = computeSpeedBonus(200, 70_000);
    assert.ok(midpoint > 0 && midpoint < 50, `expected a partial bonus, got ${midpoint}`);
    assert.equal(computeSpeedBonus(200, 120_000), 0);
    assert.equal(computeSpeedBonus(200, 600_000), 0);
  });

  test('is zero when the solve was not timed', () => {
    assert.equal(computeSpeedBonus(200, null), 0);
    assert.equal(computeSpeedBonus(200, undefined), 0);
  });
});

test.describe('streak multiplier', () => {
  test('is neutral for a first solve', () => {
    assert.equal(computeStreakMultiplier(0), 1);
    assert.equal(computeStreakMultiplier(1), 1);
  });

  test('adds 5% per consecutive day', () => {
    assert.equal(computeStreakMultiplier(3), 1.1);
  });

  test('is capped so a long streak cannot run away with the leaderboard', () => {
    assert.equal(computeStreakMultiplier(1000), STREAK_MAX_MULTIPLIER);
  });
});

test('penalties are applied before bonuses, so a hinted solve never beats a clean one', () => {
  const clean = computeScore({ basePoints: 100, durationMs: 5_000, streak: 5 });
  const hinted = computeScore({ basePoints: 100, hintsRevealed: 2, durationMs: 5_000, streak: 5 });
  assert.ok(hinted.total < clean.total, `${hinted.total} should be below ${clean.total}`);
});

test('a solve worth zero after penalties earns no bonus and no multiplier', () => {
  const score = computeScore({ basePoints: 30, hintsRevealed: 2, durationMs: 1_000, streak: 10 });
  assert.equal(score.total, 0);
  assert.equal(score.speedBonus, 0);
  assert.equal(score.streakMultiplier, 1);
});

test('the breakdown reports every component that produced the total', () => {
  const score = computeScore({
    basePoints: 200,
    hintsRevealed: 1,
    wrongSubmissions: 2,
    durationMs: 10_000,
    streak: 3,
  });
  assert.equal(score.base, 200);
  assert.equal(score.hintPenalty, 15);
  assert.equal(score.wrongPenalty, 20);
  assert.equal(score.speedBonus, 50);
  assert.equal(score.streakMultiplier, 1.1);
  // (200 - 15 - 20 + 50) * 1.1 = 236.5 -> 237
  assert.equal(score.total, 237);
});
