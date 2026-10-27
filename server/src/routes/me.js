// Personal dashboard data: recommendations, interactions (ratings), history and past-session analytics.
const express = require('express');
const { Interaction, Title, WatchSpace } = require('../models');
const { requireAuth } = require('../auth');
const recs = require('../recs/service');
const { HttpError, asyncRoute } = require('../util');

const router = express.Router();
router.use(requireAuth);

router.get('/recommendations', asyncRoute(async (req, res) => {
  const k = Math.min(20, Math.max(1, Number(req.query.k) || 10));
  res.json(await recs.railFor(req.user.id, k));
}));

router.post('/interactions', asyncRoute(async (req, res) => {
  const { titleId, rating, watchedSeconds, completed } = req.body || {};
  if (typeof titleId !== 'string' || !(await Title.exists({ _id: titleId }))) throw new HttpError(400, 'BAD_REQUEST', 'titleId must reference an existing title');
  if (rating !== undefined && rating !== null && !(Number.isInteger(rating) && rating >= 1 && rating <= 5)) throw new HttpError(400, 'BAD_REQUEST', 'rating must be an integer 1-5');
  if (watchedSeconds !== undefined && !(typeof watchedSeconds === 'number' && watchedSeconds >= 0)) throw new HttpError(400, 'BAD_REQUEST', 'watchedSeconds must be >= 0');
  const doc = await Interaction.findOneAndUpdate(
    { userId: req.user.id, titleId, source: 'rating' },
    { $set: { rating: rating ?? null, watchedSeconds: watchedSeconds || 0, completed: !!completed, createdAt: new Date() } },
    { upsert: true, new: true }
  ).lean();
  res.status(201).json({ interaction: { id: String(doc._id), titleId, rating: doc.rating, watchedSeconds: doc.watchedSeconds, completed: doc.completed } });
}));

router.get('/history', asyncRoute(async (req, res) => {
  const items = await Interaction.find({ userId: req.user.id }).sort({ createdAt: -1 }).limit(100).lean();
  const titles = await Title.find({ _id: { $in: items.map((i) => i.titleId) } }, { name: 1, durationSeconds: 1, genres: 1, posterColor: 1 }).lean();
  const byId = new Map(titles.map((t) => [t._id, t]));
  const seen = new Map();
  for (const i of items) {
    const prev = seen.get(i.titleId);
    if (!prev) seen.set(i.titleId, { ...i });
    else {
      prev.watchedSeconds = Math.max(prev.watchedSeconds, i.watchedSeconds || 0);
      prev.completed = prev.completed || i.completed;
      prev.rating = prev.rating || i.rating;
    }
  }
  res.json({
    history: [...seen.values()].filter((i) => byId.has(i.titleId)).map((i) => {
      const t = byId.get(i.titleId);
      return { titleId: i.titleId, name: t.name, genres: t.genres, posterColor: t.posterColor, watchedSeconds: i.watchedSeconds, progress: Math.min(1, i.watchedSeconds / t.durationSeconds), completed: i.completed, rating: i.rating, lastWatchedAt: i.createdAt };
    }),
  });
}));

router.get('/sessions', asyncRoute(async (req, res) => {
  const list = await WatchSpace.find({ status: 'ended', $or: [{ hostUserId: req.user.id }, { participantIds: req.user.id }, { createdBy: req.user.id }] }).sort({ endedAt: -1 }).limit(30).lean();
  const titles = await Title.find({ _id: { $in: list.map((w) => w.titleId) } }, { name: 1 }).lean();
  const names = new Map(titles.map((t) => [t._id, t.name]));
  res.json({ sessions: list.map((w) => ({ watchSpaceId: w._id, name: w.name, titleName: names.get(w.titleId), startedAt: w.startedAt, endedAt: w.endedAt, summary: w.summary })) });
}));

module.exports = router;
