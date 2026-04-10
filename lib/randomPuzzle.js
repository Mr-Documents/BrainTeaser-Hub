/**
 * @param {object[]} puzzles
 * @param {{ type?: string, difficulty?: string, exclude?: string[] }} filters
 * @returns {object | null}
 */
function pickRandomPuzzle(puzzles, filters = {}) {
  const { type, difficulty, exclude = [] } = filters;
  const excludeSet = new Set(exclude.filter(Boolean));

  let pool = (puzzles || []).filter((p) => p && p.id && !excludeSet.has(p.id));
  if (type) pool = pool.filter((p) => p.type === type);
  if (difficulty) pool = pool.filter((p) => p.difficulty === difficulty);

  if (pool.length === 0) return null;
  const i = Math.floor(Math.random() * pool.length);
  return pool[i];
}

module.exports = { pickRandomPuzzle };
