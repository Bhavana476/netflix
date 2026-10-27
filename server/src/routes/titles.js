const express = require('express');
const { Title } = require('../models');
const { requireAuth } = require('../auth');
const engine = require('../ai/engine');
const { eventsInRange } = require('../ai/retrieval');
const { HttpError, asyncRoute } = require('../util');

const router = express.Router();
router.use(requireAuth);

const CATALOG_FIELDS = { name: 1, synopsis: 1, year: 1, durationSeconds: 1, genres: 1, tags: 1, posterColor: 1, hasFullTimeline: 1, videoAssetUrl: 1 };

router.get('/', asyncRoute(async (req, res) => {
  const filter = {};
  if (typeof req.query.genre === 'string') filter.genres = req.query.genre;
  const titles = await Title.find(filter, CATALOG_FIELDS).sort({ hasFullTimeline: -1, name: 1 }).lean();
  res.json({ titles: titles.map(({ _id, ...t }) => ({ id: _id, ...t })) });
}));

async function loadTitle(id) {
  const t = await engine.getTitle(id);
  if (!t) throw new HttpError(404, 'NOT_FOUND', 'Title not found');
  return t;
}

router.get('/:titleId', asyncRoute(async (req, res) => {
  const t = await loadTitle(req.params.titleId);
  res.json({
    id: t._id, name: t.name, synopsis: t.synopsis, year: t.year, durationSeconds: t.durationSeconds, genres: t.genres, tags: t.tags,
    videoAssetUrl: t.videoAssetUrl, posterColor: t.posterColor, characters: t.characters, timelineVersion: t.timelineVersion,
    eventCount: t.timeline.length, hasFullTimeline: t.hasFullTimeline,
  });
}));

// Timeline window used to hydrate the co-pilot as playback advances (range query over the ts-sorted array).
router.get('/:titleId/timeline', asyncRoute(async (req, res) => {
  const t = await loadTitle(req.params.titleId);
  const from = req.query.from === undefined ? 0 : Number(req.query.from);
  const to = req.query.to === undefined ? t.durationSeconds : Number(req.query.to);
  if (!Number.isFinite(from) || !Number.isFinite(to) || from < 0 || to < from) throw new HttpError(400, 'BAD_REQUEST', 'from/to must be numbers with 0 <= from <= to');
  const events = eventsInRange(t.timeline, from, to).map((e) => {
    const out = { id: e.id, ts: e.ts, type: e.type === 'variation_point' ? 'variationPoint' : e.type };
    if (e.endTs !== undefined) out.endTs = e.endTs;
    if (e.text) out.text = e.text;
    if (e.characterId) out.characterId = e.characterId;
    if (e.term) Object.assign(out, { term: e.term, definition: e.definition });
    if (e.title) out.title = e.title;
    if (e.variation) Object.assign(out, { variationId: e.variation.id, kind: e.variation.kind, prompt: e.variation.prompt, options: e.variation.options.map(({ id, label }) => ({ id, label })) });
    return out;
  });
  res.json({ titleId: t._id, timelineVersion: t.timelineVersion, from, to, events });
}));

router.get('/:titleId/subtitles', asyncRoute(async (req, res) => {
  const t = await loadTitle(req.params.titleId);
  const locale = typeof req.query.locale === 'string' && /^[a-z]{2}(-[A-Z]{2})?$/.test(req.query.locale) ? req.query.locale : 'en';
  res.json(engine.resolveSubtitles(t, locale));
}));

module.exports = router;
