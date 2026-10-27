// Admin-only routes. RBAC is enforced here for every route - non-admin tokens receive 403.
const express = require('express');
const { Title, User, ROLES } = require('../models');
const { requireAuth, requireRole } = require('../auth');
const engine = require('../ai/engine');
const { parseTimeline, validateTimeline } = require('../ai/timelineSchema');
const recs = require('../recs/service');
const metrics = require('../metrics');
const gateway = require('../realtime/gateway');
const { HttpError, asyncRoute } = require('../util');

const router = express.Router();
router.use(requireAuth, requireRole('admin'));

function readUpload(body) {
  const b = body || {};
  if (typeof b.content === 'string') return { content: b.content, format: ['json', 'yaml', 'auto'].includes(b.format) ? b.format : 'auto' };
  if (b.timeline && typeof b.timeline === 'object') return { content: b.timeline, format: 'json' };
  throw new HttpError(400, 'BAD_REQUEST', 'Send { content: "<json or yaml text>", format } or { timeline: {...} }');
}

router.post('/timelines/validate', asyncRoute(async (req, res) => {
  const { content, format } = readUpload(req.body);
  const parsed = parseTimeline(content, format);
  if (parsed.error) return res.status(422).json({ valid: false, errors: [{ path: '$', message: parsed.error }] });
  const result = validateTimeline(parsed.data);
  const summary = result.valid ? { titleId: parsed.data.title.id, events: parsed.data.events.length, byType: parsed.data.events.reduce((m, e) => ((m[e.type] = (m[e.type] || 0) + 1), m), {}) } : undefined;
  res.status(result.valid ? 200 : 422).json({ ...result, summary });
}));

router.post('/timelines', asyncRoute(async (req, res) => {
  const { content, format } = readUpload(req.body);
  const result = await engine.ingestTimeline(content, format);
  if (!result.valid) return res.status(422).json(result);
  res.status(201).json(result);
}));

router.delete('/titles/:titleId', asyncRoute(async (req, res) => {
  const r = await Title.deleteOne({ _id: req.params.titleId });
  if (!r.deletedCount) throw new HttpError(404, 'NOT_FOUND', 'Title not found');
  engine.invalidateTitle(req.params.titleId);
  res.status(204).end();
}));

router.post('/recommendations/retrain', asyncRoute(async (req, res) => {
  res.json(await recs.retrain());
}));

router.get('/metrics', (req, res) => {
  res.json({ metrics: metrics.snapshot(), realtime: gateway.getStats(), uptimeSec: Math.round(process.uptime()) });
});

router.get('/users', asyncRoute(async (req, res) => {
  const users = await User.find({ synthetic: { $ne: true } }).sort({ createdAt: 1 }).limit(200);
  res.json({ users: users.map((u) => u.toPublic()) });
}));

router.patch('/users/:userId/role', asyncRoute(async (req, res) => {
  const role = (req.body || {}).role;
  if (!ROLES.includes(role)) throw new HttpError(400, 'BAD_REQUEST', `role must be one of ${ROLES.join(', ')}`);
  const user = await User.findByIdAndUpdate(req.params.userId, { role }, { new: true });
  if (!user) throw new HttpError(404, 'NOT_FOUND', 'User not found');
  res.json({ user: user.toPublic() });
}));

module.exports = router;
