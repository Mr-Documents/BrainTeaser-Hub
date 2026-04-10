const PENALTY_PER_HINT = 15;
const PENALTY_PER_WRONG = 10;

/**
 * @param {number} basePoints
 * @param {number} hintsRevealed
 * @param {number} wrongSubmissions
 */
function computePointsEarned(basePoints, hintsRevealed, wrongSubmissions) {
  const b = Number(basePoints) || 0;
  const h = Math.max(0, Number(hintsRevealed) || 0);
  const w = Math.max(0, Number(wrongSubmissions) || 0);
  const earned = b - h * PENALTY_PER_HINT - w * PENALTY_PER_WRONG;
  return Math.max(0, Math.round(earned));
}

module.exports = {
  computePointsEarned,
  PENALTY_PER_HINT,
  PENALTY_PER_WRONG,
};
