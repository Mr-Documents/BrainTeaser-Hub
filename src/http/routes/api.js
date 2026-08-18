'use strict';

const express = require('express');
const { asyncHandler } = require('../middleware/asyncHandler');
const { PUZZLE_TYPES, DIFFICULTIES } = require('../../domain/constants');
const { NotFoundError, BadRequestError } = require('../../lib/errors');

const csvToArray = (value) =>
  String(value || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

/** Accept a filter value only if it is one of the known options — anything else means "any". */
const oneOf = (value, allowed) => (allowed.includes(String(value)) ? String(value) : undefined);

/**
 * The player-facing API. Every response uses the { ok, data } / { ok, error } envelope
 * installed by the respond() middleware.
 */
function createApiRouter({ puzzleService, gameService, statsService, repository, limiters }) {
  const router = express.Router();
  const submitLimiter = limiters?.submit || ((req, res, next) => next());

  router.get(
    '/health',
    asyncHandler(async (req, res) => {
      const health = await repository.healthCheck();
      res
        .status(health.ok ? 200 : 503)
        .json({ ok: health.ok, data: { ...health, uptimeSec: Math.round(process.uptime()) } });
    })
  );

  router.get(
    '/meta',
    asyncHandler(async (req, res) => {
      res.ok({ types: PUZZLE_TYPES, difficulties: DIFFICULTIES, catalogue: await puzzleService.catalogueSummary() });
    })
  );

  // --- puzzles ------------------------------------------------------------
  // Static segments are declared before "/:id" so a puzzle can never shadow them.

  router.get(
    '/puzzles/random',
    asyncHandler(async (req, res) => {
      const session = await gameService.startRandom({
        type: oneOf(req.query.type, PUZZLE_TYPES),
        difficulty: oneOf(req.query.difficulty, DIFFICULTIES),
        tag: req.query.tag ? String(req.query.tag) : undefined,
        exclude: csvToArray(req.query.exclude),
      });
      if (!session) {
        throw new NotFoundError(
          'No puzzle left matching those filters. Clear a filter or tap "Reset seen" to play them again.'
        );
      }
      res.ok(session);
    })
  );

  router.get(
    '/puzzles/daily',
    asyncHandler(async (req, res) => {
      const session = await gameService.startDaily();
      if (!session) throw new NotFoundError('No puzzles are published yet.');
      res.ok(session);
    })
  );

  router.get(
    '/puzzles',
    asyncHandler(async (req, res) => {
      const limit = Math.min(200, Math.max(1, Number.parseInt(req.query.limit, 10) || 50));
      const offset = Math.max(0, Number.parseInt(req.query.offset, 10) || 0);
      const { puzzles, total } = await puzzleService.listPublic({
        type: oneOf(req.query.type, PUZZLE_TYPES) || '',
        difficulty: oneOf(req.query.difficulty, DIFFICULTIES) || '',
        search: req.query.q || '',
        limit,
        offset,
      });
      res.ok({ puzzles, total, limit, offset });
    })
  );

  router.get(
    '/puzzles/:id/hint',
    asyncHandler(async (req, res) => {
      const attemptToken = req.query.attemptToken || req.get('x-attempt-token');
      res.ok(await gameService.revealHint({ puzzleId: req.params.id, attemptToken }));
    })
  );

  router.get(
    '/puzzles/:id',
    asyncHandler(async (req, res) => {
      res.ok(await gameService.startById(req.params.id));
    })
  );

  // --- play ---------------------------------------------------------------

  router.post(
    '/submit',
    submitLimiter,
    asyncHandler(async (req, res) => {
      const { puzzleId, answer, username, attemptToken } = req.body || {};
      res.ok(await gameService.submitAnswer({ puzzleId, answer, username, attemptToken }));
    })
  );

  // --- read models --------------------------------------------------------

  router.get(
    '/leaderboard',
    asyncHandler(async (req, res) => {
      const limit = Number.parseInt(req.query.limit, 10) || 10;
      res.ok({ entries: await statsService.getLeaderboard(limit) });
    })
  );

  router.get(
    '/stats',
    asyncHandler(async (req, res) => {
      res.ok(await statsService.getStats({ fresh: req.query.fresh === '1' }));
    })
  );

  router.get(
    '/players/:username',
    asyncHandler(async (req, res) => {
      const username = String(req.params.username || '').trim();
      if (!username) throw new BadRequestError('username is required');
      const profile = await statsService.getPlayerProfile(username);
      if (!profile) throw new NotFoundError(`No player named "${username}" has scored yet`);
      res.ok(profile);
    })
  );

  return router;
}

module.exports = { createApiRouter };
