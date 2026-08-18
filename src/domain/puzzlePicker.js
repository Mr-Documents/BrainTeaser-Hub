'use strict';

/**
 * Filter a puzzle pool by the player's chosen type/difficulty, minus anything already seen.
 * @param {object[]} puzzles
 * @param {{ type?: string, difficulty?: string, exclude?: string[], tag?: string }} filters
 */
function filterPuzzles(puzzles, filters = {}) {
  const { type, difficulty, exclude = [], tag } = filters;
  const excludeSet = new Set((exclude || []).filter(Boolean));

  return (puzzles || []).filter((p) => {
    if (!p || !p.id) return false;
    if (p.isPublished === false) return false;
    if (excludeSet.has(p.id)) return false;
    if (type && p.type !== type) return false;
    if (difficulty && p.difficulty !== difficulty) return false;
    if (tag && !(Array.isArray(p.tags) ? p.tags : []).includes(tag)) return false;
    return true;
  });
}

/**
 * Pick one puzzle at random from the filtered pool.
 * @param {object[]} puzzles
 * @param {object} [filters]
 * @param {() => number} [random] injectable RNG so tests are deterministic
 * @returns {object|null} null when nothing matches (empty pool or every match already seen)
 */
function pickRandomPuzzle(puzzles, filters = {}, random = Math.random) {
  const pool = filterPuzzles(puzzles, filters);
  if (pool.length === 0) return null;
  const index = Math.min(pool.length - 1, Math.floor(random() * pool.length));
  return pool[index];
}

/** FNV-1a - a small, stable string hash. Same input, same number, on every machine and run. */
function hashString(str) {
  let hash = 0x811c9dc5;
  for (let i = 0; i < str.length; i += 1) {
    hash ^= str.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

/** The UTC calendar day, as `YYYY-MM-DD`. The daily puzzle rolls over at midnight UTC for everyone. */
function dayKey(date = new Date()) {
  return new Date(date).toISOString().slice(0, 10);
}

/**
 * The puzzle of the day: deterministic per UTC day, so every player gets the same one
 * and a reload cannot reroll it.
 * @param {object[]} puzzles
 * @param {Date|string} [date]
 * @returns {object|null}
 */
function pickDailyPuzzle(puzzles, date = new Date()) {
  const pool = filterPuzzles(puzzles, {})
    .slice()
    .sort((a, b) => String(a.id).localeCompare(String(b.id)));
  if (pool.length === 0) return null;
  const key = dayKey(date);
  return pool[hashString(key) % pool.length];
}

module.exports = { pickRandomPuzzle, pickDailyPuzzle, filterPuzzles, dayKey, hashString };
