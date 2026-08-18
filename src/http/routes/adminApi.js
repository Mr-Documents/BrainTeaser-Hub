'use strict';

const express = require('express');
const { asyncHandler } = require('../middleware/asyncHandler');
const { matchAnswer } = require('../../domain/answerMatcher');
const { safeParsePuzzle } = require('../../domain/puzzleSchema');
const { BadRequestError } = require('../../lib/errors');

/**
 * Admin write API. Every route here is behind the admin guard; the guard is applied once at
 * the router level so a new endpoint cannot accidentally ship unprotected.
 */
function createAdminApiRouter({ puzzleService, statsService, adminAuth }) {
  const router = express.Router();
  router.use(adminAuth.requireApi());

  router.get(
    '/puzzles',
    asyncHandler(async (req, res) => {
      const limit = Math.min(500, Math.max(1, Number.parseInt(req.query.limit, 10) || 200));
      const offset = Math.max(0, Number.parseInt(req.query.offset, 10) || 0);
      const { puzzles, total } = await puzzleService.list({
        search: req.query.q || '',
        type: req.query.type || '',
        difficulty: req.query.difficulty || '',
        limit,
        offset,
      });
      res.ok({ puzzles, total, limit, offset });
    })
  );

  router.get(
    '/summary',
    asyncHandler(async (req, res) => {
      const [catalogue, stats] = await Promise.all([puzzleService.catalogueSummary(), statsService.getStats()]);
      res.ok({ catalogue, stats });
    })
  );

  router.post(
    '/puzzles',
    asyncHandler(async (req, res) => {
      res.ok({ puzzle: await puzzleService.create(req.body) }, 201);
    })
  );

  router.put(
    '/puzzles/:id',
    asyncHandler(async (req, res) => {
      res.ok({ puzzle: await puzzleService.update(req.params.id, req.body) });
    })
  );

  router.delete(
    '/puzzles/:id',
    asyncHandler(async (req, res) => {
      res.ok(await puzzleService.remove(req.params.id));
    })
  );

  /**
   * Dry-run a draft: validate it and grade sample answers against it, without saving.
   * Lets an author confirm the match mode behaves before the puzzle reaches players.
   */
  router.post(
    '/puzzles/validate',
    asyncHandler(async (req, res) => {
      const { sampleAnswers = [], ...draft } = req.body || {};
      const parsed = safeParsePuzzle(draft);
      if (!parsed.ok) return res.ok({ valid: false, issues: parsed.issues, samples: [] });

      const samples = (Array.isArray(sampleAnswers) ? sampleAnswers : [sampleAnswers])
        .map((s) => String(s))
        .filter((s) => s.trim())
        .slice(0, 10)
        .map((input) => ({ input, correct: matchAnswer(input, parsed.data).correct }));

      res.ok({ valid: true, issues: [], puzzle: parsed.data, samples });
    })
  );

  /** Bulk import — the same shape `npm run db:seed` consumes, so a backup restores cleanly. */
  router.post(
    '/import',
    asyncHandler(async (req, res) => {
      const body = req.body || {};
      const incoming = Array.isArray(body) ? body : body.puzzles;
      if (!Array.isArray(incoming) || incoming.length === 0) {
        throw new BadRequestError('Send { "puzzles": [...] } with at least one puzzle');
      }
      if (incoming.length > 500) throw new BadRequestError('Import at most 500 puzzles at a time');

      const valid = [];
      const rejected = [];
      incoming.forEach((raw, index) => {
        const parsed = safeParsePuzzle(raw);
        if (parsed.ok) valid.push(parsed.data);
        else rejected.push({ index, id: raw?.id ?? null, issues: parsed.issues });
      });

      const result = valid.length ? await puzzleService.importMany(valid) : { created: 0, updated: 0 };
      res.ok({ ...result, rejected });
    })
  );

  /** Export the full catalogue as a re-importable JSON document. */
  router.get(
    '/export',
    asyncHandler(async (req, res) => {
      const { puzzles } = await puzzleService.list({});
      res.setHeader('content-disposition', 'attachment; filename="brain-teaser-puzzles.json"');
      res.json({ exportedAt: new Date().toISOString(), count: puzzles.length, puzzles });
    })
  );

  return router;
}

module.exports = { createAdminApiRouter };
