const express = require('express');
const { WatchSpace, Title, SessionEvent } = require('../models');
const { requireAuth, requireRole } = require('../auth');
const gateway = require('../realtime/gateway');
const { computeFromLog } = require('../services/analytics');
const { HttpError, sanitizeText, inviteCode, id, asyncRoute } = require('../util');

const router = express.Router();
router.use(requireAuth);

function view(ws) {
  return {
    watchSpaceId: ws._id,
    name: ws.name,
    titleId: ws.titleId,
    inviteCode: ws.inviteCode,
    status: ws.status,
    privacy: ws.privacy,
    hostUserId: String(ws.hostUserId),
    settings: ws.settings,
    participantCount: (ws.participantIds || []).length,
    scheduledFor: ws.scheduledFor || null,
    startedAt: ws.startedAt || null,
    endedAt: ws.endedAt || null,
    createdAt: ws.createdAt,
    summary: ws.summary && ws.summary.durationSeconds !== undefined ? ws.summary : null,
  };
}

const isMember = (ws, userId) => String(ws.hostUserId) === userId || String(ws.createdBy) === userId || (ws.participantIds || []).some((p) => String(p) === userId);

async function loadWs(wsId) {
  const ws = await WatchSpace.findById(wsId).lean();
  if (!ws) throw new HttpError(404, 'NOT_FOUND', 'Watch Space not found');
  return ws;
}

async function loadMemberWs(req) {
  const ws = await loadWs(req.params.id);
  if (!isMember(ws, req.user.id) && req.user.role !== 'admin') throw new HttpError(403, 'FORBIDDEN', 'You are not a participant of this Watch Space');
  return ws;
}

// Create (Host). Viewers cannot create rooms - enforced here, not only in the UI.
router.post('/', requireRole('host', 'admin'), asyncRoute(async (req, res) => {
  const b = req.body || {};
  if (typeof b.titleId !== 'string' || !(await Title.exists({ _id: b.titleId }))) throw new HttpError(400, 'BAD_REQUEST', 'titleId must reference an existing title');
  const maxParticipants = b.maxParticipants === undefined ? 25 : Number(b.maxParticipants);
  if (!Number.isInteger(maxParticipants) || maxParticipants < 2 || maxParticipants > 50) throw new HttpError(400, 'BAD_REQUEST', 'maxParticipants must be an integer 2-50');
  const aiVerbosity = b.aiVerbosity === undefined ? 'normal' : b.aiVerbosity;
  if (!['minimal', 'normal', 'chatty'].includes(aiVerbosity)) throw new HttpError(400, 'BAD_REQUEST', 'aiVerbosity must be minimal, normal or chatty');
  const privacy = b.privacy === 'public' ? 'public' : 'invite';
  let scheduledFor;
  if (b.scheduledFor) {
    scheduledFor = new Date(b.scheduledFor);
    if (Number.isNaN(scheduledFor.getTime())) throw new HttpError(400, 'BAD_REQUEST', 'scheduledFor must be an ISO date');
  }
  const ws = await WatchSpace.create({
    _id: id('ws'),
    name: sanitizeText(b.name, 80) || 'Watch Space',
    titleId: b.titleId,
    hostUserId: req.user.id,
    createdBy: req.user.id,
    inviteCode: inviteCode(),
    privacy,
    scheduledFor,
    settings: { maxParticipants, aiVerbosity, votingEnabled: b.votingEnabled !== false, triviaEnabled: b.triviaEnabled !== false },
    participantIds: [req.user.id],
  });
  res.status(201).json({ ...view(ws.toObject()), createdAt: ws.createdAt });
}));

// Dashboard listing: rooms I host or joined, optionally filtered by status.
router.get('/', asyncRoute(async (req, res) => {
  const filter = { $or: [{ hostUserId: req.user.id }, { participantIds: req.user.id }] };
  if (typeof req.query.status === 'string') filter.status = { $in: req.query.status.split(',') };
  const list = await WatchSpace.find(filter).sort({ createdAt: -1 }).limit(50).lean();
  const titles = await Title.find({ _id: { $in: list.map((w) => w.titleId) } }, { name: 1, posterColor: 1 }).lean();
  const names = new Map(titles.map((t) => [t._id, t]));
  res.json({ watchSpaces: list.map((w) => ({ ...view(w), titleName: (names.get(w.titleId) || {}).name, isHost: String(w.hostUserId) === req.user.id })) });
}));

// Join by invite code (works for invite-only rooms).
router.post('/join', asyncRoute(async (req, res) => {
  const code = typeof (req.body || {}).inviteCode === 'string' ? req.body.inviteCode.trim().toUpperCase() : '';
  const ws = code && (await WatchSpace.findOne({ inviteCode: code }).lean());
  if (!ws) throw new HttpError(404, 'NOT_FOUND', 'No Watch Space with that invite code');
  if (ws.status === 'ended') throw new HttpError(410, 'ENDED', 'That Watch Space has ended');
  if (!isMember(ws, req.user.id) && ws.participantIds.length >= ws.settings.maxParticipants) throw new HttpError(409, 'ROOM_FULL', 'That Watch Space is full');
  await WatchSpace.updateOne({ _id: ws._id }, { $addToSet: { participantIds: req.user.id } });
  res.json({ watchSpaceId: ws._id, titleId: ws.titleId, name: ws.name, status: ws.status });
}));

router.get('/:id', asyncRoute(async (req, res) => {
  const ws = await loadWs(req.params.id);
  if (ws.privacy !== 'public' && !isMember(ws, req.user.id) && req.user.role !== 'admin') throw new HttpError(403, 'FORBIDDEN', 'Invite code required');
  res.json(view(ws));
}));

router.get('/:id/messages', asyncRoute(async (req, res) => {
  await loadMemberWs(req);
  const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 50));
  const events = await SessionEvent.find({ watchSpaceId: req.params.id, type: { $in: ['chat', 'ai_answer', 'system'] } }).sort({ createdAt: -1 }).limit(limit).lean();
  res.json({
    messages: events.reverse().map((e) => ({ messageId: e.msgId, type: e.type, userId: e.userId ? String(e.userId) : null, displayName: e.displayName || (e.type === 'ai_answer' ? 'AI Co-Pilot' : 'System'), body: e.body, tsSeconds: e.tsSeconds, sourceEvents: e.meta && e.meta.sourceEvents, createdAt: e.createdAt })),
  });
}));

// AI Co-Pilot question (REST entry point; the answer is also broadcast to the live room).
router.post('/:id/ai/ask', asyncRoute(async (req, res) => {
  const ws = await loadMemberWs(req);
  if (ws.status === 'ended') throw new HttpError(410, 'ENDED', 'This Watch Space has ended');
  const { question, currentTs } = req.body || {};
  const r = await gateway.askAi(ws._id, req.user, question, currentTs);
  res.json({ questionId: r.questionId, answer: r.answer, sourceEvents: r.sourceEvents, sources: r.sources, explanation: r.explanation, grounded: r.grounded, model: r.model, latencyMs: r.latencyMs, generatedAt: r.generatedAt });
}));

router.post('/:id/end', asyncRoute(async (req, res) => {
  const summary = await gateway.endRoom(req.params.id, req.user);
  res.json({ watchSpaceId: req.params.id, status: 'ended', summary });
}));

// Session analytics: stored summary next to a fresh recomputation from the raw event log (reconciliation).
router.get('/:id/analytics', asyncRoute(async (req, res) => {
  const ws = await loadMemberWs(req);
  const fromLog = await computeFromLog(ws._id);
  const stored = ws.summary && ws.summary.durationSeconds !== undefined ? ws.summary : null;
  const keys = ['durationSeconds', 'peakParticipants', 'aiQuestions', 'triviaSurfaced', 'chatMessages', 'reactions'];
  res.json({ watchSpaceId: ws._id, status: ws.status, summary: stored, fromEventLog: fromLog, reconciles: stored ? keys.every((k) => stored[k] === fromLog[k]) : null });
}));

module.exports = router;
