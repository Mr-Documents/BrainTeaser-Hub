'use strict';

const express = require('express');
const { asyncHandler } = require('../middleware/asyncHandler');
const {
  PUZZLE_TYPES,
  DIFFICULTIES,
  TYPE_LABELS,
  DIFFICULTY_LABELS,
  DEFAULT_BASE_POINTS,
} = require('../../domain/constants');
const { NotFoundError } = require('../../lib/errors');

/** Copy for the category tiles on the home page - one place, not scattered through the template. */
const TYPE_BLURBS = {
  logic: 'Deduction, riddles and "wait, what?" moments.',
  math: 'Numbers, patterns and quick arithmetic traps.',
  word: 'Anagrams, wordplay and language twists.',
  lateral: 'Sideways thinking - the obvious answer is wrong.',
  trivia: 'Facts that sound false but are not.',
};

const DIFFICULTY_BLURBS = {
  easy: 'Warm-ups. A good first solve.',
  medium: 'Needs a moment of real thought.',
  hard: 'Bring coffee. Hints exist for a reason.',
};

/**
 * Server-rendered pages. Each one ships its first paint with real data (leaderboard, stats,
 * puzzle counts) so the page is useful before any JavaScript runs, then the client enhances it.
 */
function createPagesRouter({ puzzleService, statsService, adminAuth, config }) {
  const router = express.Router();

  const baseLocals = (overrides = {}) => ({
    site: config.site,
    types: PUZZLE_TYPES,
    difficulties: DIFFICULTIES,
    typeLabels: TYPE_LABELS,
    difficultyLabels: DIFFICULTY_LABELS,
    typeBlurbs: TYPE_BLURBS,
    difficultyBlurbs: DIFFICULTY_BLURBS,
    navActive: 'home',
    pageTitle: config.site.name,
    pageDescription:
      'Solve curated logic, math, word and lateral-thinking brain teasers. Hints, streaks, a live leaderboard and shareable challenge links.',
    ...overrides,
  });

  router.get(
    '/',
    asyncHandler(async (req, res) => {
      const [stats, leaderboard, catalogue] = await Promise.all([
        statsService.getStats(),
        statsService.getLeaderboard(5),
        puzzleService.catalogueSummary(),
      ]);
      res.render(
        'home',
        baseLocals({
          navActive: 'home',
          pageTitle: `${config.site.name} - daily logic, math and word puzzles`,
          stats,
          leaderboard,
          catalogue,
        })
      );
    })
  );

  router.get(
    '/play',
    asyncHandler(async (req, res) => {
      const [stats, leaderboard] = await Promise.all([statsService.getStats(), statsService.getLeaderboard(10)]);
      res.render(
        'play',
        baseLocals({
          navActive: 'play',
          pageTitle: `Play · ${config.site.name}`,
          stats,
          leaderboard,
          mode: 'random',
          initialFilters: {
            type: PUZZLE_TYPES.includes(req.query.type) ? req.query.type : '',
            difficulty: DIFFICULTIES.includes(req.query.difficulty) ? req.query.difficulty : '',
          },
          challengePuzzleId: null,
        })
      );
    })
  );

  router.get(
    '/daily',
    asyncHandler(async (req, res) => {
      const [stats, leaderboard] = await Promise.all([statsService.getStats(), statsService.getLeaderboard(10)]);
      res.render(
        'play',
        baseLocals({
          navActive: 'daily',
          pageTitle: `Daily challenge · ${config.site.name}`,
          pageDescription: 'One puzzle, the same for everyone, every day. Solve it before midnight UTC.',
          stats,
          leaderboard,
          mode: 'daily',
          initialFilters: { type: '', difficulty: '' },
          challengePuzzleId: null,
        })
      );
    })
  );

  router.get(
    '/challenge/:id',
    asyncHandler(async (req, res) => {
      const id = String(req.params.id || '').trim();
      // Resolve now so a dead link 404s on the server instead of failing later in the browser.
      const puzzle = await puzzleService.getById(id).catch(() => null);
      if (!puzzle) throw new NotFoundError('That challenge link points to a puzzle that no longer exists.');

      const [stats, leaderboard] = await Promise.all([statsService.getStats(), statsService.getLeaderboard(10)]);
      res.render(
        'play',
        baseLocals({
          navActive: 'play',
          pageTitle: `Challenge · ${config.site.name}`,
          pageDescription: `A ${puzzle.difficulty} ${puzzle.type} brain teaser - can you solve it?`,
          stats,
          leaderboard,
          mode: 'challenge',
          initialFilters: { type: '', difficulty: '' },
          challengePuzzleId: puzzle.id,
        })
      );
    })
  );

  router.get(
    '/leaderboard',
    asyncHandler(async (req, res) => {
      const [leaderboard, stats] = await Promise.all([statsService.getLeaderboard(50), statsService.getStats()]);
      res.render(
        'leaderboard',
        baseLocals({
          navActive: 'leaderboard',
          pageTitle: `Leaderboard · ${config.site.name}`,
          pageDescription: 'Top solvers ranked by points, solves and streaks.',
          leaderboard,
          stats,
        })
      );
    })
  );

  router.get('/how-it-works', (req, res) => {
    res.render(
      'how-it-works',
      baseLocals({
        navActive: 'how',
        pageTitle: `How scoring works · ${config.site.name}`,
        pageDescription: 'Points, hint penalties, speed bonuses and daily streaks, explained.',
      })
    );
  });

  // --- admin --------------------------------------------------------------

  router.get('/admin/login', (req, res) => {
    if (adminAuth.isAuthorized(req)) return res.redirect('/admin');
    res.render(
      'admin-login',
      baseLocals({
        navActive: 'admin',
        pageTitle: `Sign in · ${config.site.name}`,
        next: typeof req.query.next === 'string' ? req.query.next : '/admin',
        error: req.query.error === '1' ? 'That token was not accepted.' : null,
        tokenConfigured: Boolean(config.admin.token),
      })
    );
  });

  router.post('/admin/login', (req, res) => {
    const target = typeof req.body?.next === 'string' && req.body.next.startsWith('/') ? req.body.next : '/admin';
    if (adminAuth.login(req, res, req.body?.token)) return res.redirect(target);
    res.redirect(`/admin/login?error=1&next=${encodeURIComponent(target)}`);
  });

  router.post('/admin/logout', (req, res) => {
    adminAuth.clearSession(res);
    res.redirect('/admin/login');
  });

  router.get(
    '/admin',
    adminAuth.requirePage(),
    asyncHandler(async (req, res) => {
      const [{ puzzles }, catalogue, stats] = await Promise.all([
        puzzleService.list({}),
        puzzleService.catalogueSummary(),
        statsService.getStats(),
      ]);
      res.render(
        'admin',
        baseLocals({
          navActive: 'admin',
          pageTitle: `Puzzle studio · ${config.site.name}`,
          pageDescription: 'Create, edit and publish brain teasers.',
          puzzles,
          catalogue,
          stats,
          defaultBasePoints: DEFAULT_BASE_POINTS,
          authRequired: config.admin.required,
          driver: config.data.driver,
        })
      );
    })
  );

  return router;
}

module.exports = { createPagesRouter, TYPE_BLURBS, DIFFICULTY_BLURBS };
