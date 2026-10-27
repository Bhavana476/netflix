// Real-time Sync & Event Gateway (Socket.io). One Socket.io room per watchSpaceId; every message uses the envelope
// { event, watchSpaceId, payload, ts } on the 'message' channel. Room state lives in memory (RoomState); only
// coarse-grained data (chat/event log in batches, session summary) is persisted.
const crypto = require('crypto');
const { RoomState, RoomError } = require('./roomState');
const { WatchSpace, Interaction, SessionEvent } = require('../models');
const { verifyAccess } = require('../auth');
const engine = require('../ai/engine');
const eventLog = require('../services/eventLog');
const { computeFromLog } = require('../services/analytics');
const { sanitizeText, HttpError } = require('../util');
const { config } = require('../config');
const metrics = require('../metrics');
const logger = require('../logger');

const rooms = new Map(); // watchSpaceId -> RoomContext
const loading = new Map();
let nsp = null;
let ticker = null;

const HISTORY_SIZE = 50;
const REACTIONS = ['👍', '😂', '😮', '😢', '❤️', '🔥', '👏'];
const SENSITIVE = new Set([
  'room.playback.update', 'room.settings.update', 'room.end', 'room.ai.pin', 'room.ai.triviaRound',
  'room.variation.openVote', 'room.variation.closeVote', 'room.variation.apply',
  'room.mod.mute', 'room.mod.unmute', 'room.mod.remove', 'room.mod.lock', 'room.mod.unlock', 'room.mod.transferHost',
]);

const envelope = (event, watchSpaceId, payload) => ({ event, watchSpaceId, payload, ts: Date.now() });
function broadcast(watchSpaceId, event, payload) {
  if (nsp) nsp.to(watchSpaceId).emit('message', envelope(event, watchSpaceId, payload));
}
function sendTo(socket, event, watchSpaceId, payload) {
  socket.emit('message', envelope(event, watchSpaceId, payload));
}

// ---------------------------------------------------------------- room lifecycle
async function loadRoom(ws) {
  if (rooms.has(ws._id)) return rooms.get(ws._id);
  if (loading.has(ws._id)) return loading.get(ws._id);
  const p = (async () => {
    const title = await engine.getTitle(ws.titleId);
    if (!title) throw new RoomError('NOT_FOUND', 'Title for this Watch Space no longer exists');
    const state = new RoomState({
      id: ws._id,
      titleId: ws.titleId,
      hostUserId: ws.hostUserId,
      durationSeconds: title.durationSeconds,
      settings: ws.settings,
      startPosition: ws.lastPositionSeconds || 0,
      tuning: { driftThresholdMs: config.driftThresholdMs, hardSeekThresholdMs: config.hardSeekThresholdMs },
    });
    for (const a of ws.appliedVariations || []) state.appliedVariations[a.variationId] = a.optionId;
    const recent = await SessionEvent.find({ watchSpaceId: ws._id, type: { $in: ['chat', 'ai_answer'] } }).sort({ createdAt: -1 }).limit(HISTORY_SIZE).lean();
    const sessionId = `${ws._id}:${Date.now().toString(36)}`;
    const ctx = {
      id: ws._id,
      state,
      title,
      track: engine.triviaTrack(title, state.settings.aiVerbosity),
      history: recent.reverse().map(historyItem),
      timers: new Map(),
      everJoined: new Set(),
      offered: new Set(),
      sessionId,
      log: logger.room(ws._id, sessionId),
    };
    rooms.set(ws._id, ctx);
    ctx.log.info('room.loaded', { titleId: ws.titleId });
    return ctx;
  })();
  loading.set(ws._id, p);
  try {
    return await p;
  } finally {
    loading.delete(ws._id);
  }
}

function historyItem(e) {
  return e.type === 'ai_answer'
    ? { kind: 'ai_answer', messageId: e.msgId, userId: e.meta && e.meta.askedBy, displayName: 'AI Co-Pilot', question: e.meta && e.meta.question, answer: e.body, sourceEvents: (e.meta && e.meta.sourceEvents) || [], sources: (e.meta && e.meta.sources) || [], tsSeconds: e.tsSeconds, createdAt: e.createdAt }
    : { kind: 'chat', messageId: e.msgId, userId: e.userId && String(e.userId), displayName: e.displayName, body: e.body, tsSeconds: e.tsSeconds, createdAt: e.createdAt };
}

function pushHistory(ctx, item) {
  ctx.history.push(item);
  if (ctx.history.length > HISTORY_SIZE) ctx.history.shift();
}

function setTimer(ctx, key, ms, fn) {
  clearTimer(ctx, key);
  const timer = setTimeout(() => { ctx.timers.delete(key); fn(); }, ms);
  timer.unref();
  ctx.timers.set(key, timer);
}
function clearTimer(ctx, key) {
  const t = ctx.timers.get(key);
  if (t) clearTimeout(t);
  ctx.timers.delete(key);
}

function roomSnapshot(ctx, userId) {
  const s = ctx.state;
  const vote = s.vote ? { variationId: s.vote.variationId, prompt: s.vote.variation.prompt, options: s.vote.variation.options.map(({ id, label }) => ({ id, label })), closesAt: s.vote.closesAt, ...s.tally() } : null;
  return {
    watchSpaceId: ctx.id,
    hostUserId: s.hostUserId,
    hostDisconnected: !!s.hostDisconnectedAt,
    settings: s.settings,
    locked: s.locked,
    playback: s.snapshot(),
    participants: s.participantList(),
    history: ctx.history,
    appliedVariations: s.appliedVariations,
    variations: engine.listVariations(ctx.title).map((v) => ({ id: v.id, kind: v.kind, prompt: v.prompt, ts: v.ts, endTs: v.endTs, targetLineId: v.targetLineId, defaultOptionId: v.defaultOptionId, options: v.options })),
    vote,
    title: { id: ctx.title._id, name: ctx.title.name, videoAssetUrl: ctx.title.videoAssetUrl, durationSeconds: ctx.title.durationSeconds },
    you: { userId: String(userId), isHost: s.isHost(userId) },
  };
}

function presence(ctx, participantId, action, extra = {}) {
  broadcast(ctx.id, 'room.presence.update', {
    participantId,
    action,
    participantCount: ctx.state.connectedCount(),
    participants: ctx.state.participantList(),
    ...extra,
  });
}

async function recordInteraction(ctx, userId) {
  const p = ctx.state.participants.get(String(userId));
  const watched = Math.round(Math.max(p ? p.lastPosition || 0 : 0, Math.min(ctx.state.maxPosition, ctx.state.positionAt())));
  const others = [...ctx.everJoined].filter((u) => u !== String(userId));
  await Interaction.findOneAndUpdate(
    { userId, watchSpaceId: ctx.id },
    {
      $set: { titleId: ctx.state.titleId, source: 'live', completed: watched >= 0.9 * ctx.title.durationSeconds, coWatchedWith: others, createdAt: new Date() },
      $max: { watchedSeconds: watched },
    },
    { upsert: true }
  ).catch((e) => ctx.log.warn('interaction write failed', { error: e.message }));
}

function finalizeLeave(ctx, userId, reason = 'left') {
  const p = ctx.state.participants.get(String(userId));
  if (!p || p.connected) return;
  recordInteraction(ctx, userId);
  ctx.state.markLeft(userId);
  eventLog.append({ watchSpaceId: ctx.id, userId, displayName: p.displayName, type: 'leave', tsSeconds: ctx.state.positionAt(), meta: { reason } });
  presence(ctx, String(userId), 'left');
  ctx.log.info('presence.left', { userId: String(userId), reason });
  if (ctx.state.participants.size === 0) setTimer(ctx, 'unload', 60000, () => unloadRoom(ctx));
}

async function unloadRoom(ctx) {
  if (ctx.state.participants.size) return;
  for (const t of ctx.timers.values()) clearTimeout(t);
  rooms.delete(ctx.id);
  await WatchSpace.updateOne({ _id: ctx.id }, { lastPositionSeconds: ctx.state.positionAt() }).catch(() => {});
  ctx.log.info('room.unloaded');
}

function onHostGone(ctx, hostId, immediate) {
  const snap = ctx.state.onHostDisconnected();
  broadcast(ctx.id, 'room.playback.update', snap);
  broadcast(ctx.id, 'room.host.disconnected', { hostUserId: hostId, graceMs: immediate ? 0 : config.hostGraceMs, policy: 'pause_then_promote' });
  eventLog.append({ watchSpaceId: ctx.id, type: 'system', body: 'Host disconnected; playback paused.', tsSeconds: snap.positionSeconds });
  ctx.log.info('host.disconnected', { hostUserId: hostId });
  const promote = async () => {
    const host = ctx.state.participants.get(hostId);
    if (host && host.connected && ctx.state.isHost(hostId)) return; // host came back in time
    const newHost = ctx.state.promoteHost();
    if (!newHost) return; // nobody left to promote: room stays paused until the host returns
    await WatchSpace.updateOne({ _id: ctx.id }, { hostUserId: newHost }).catch(() => {});
    broadcast(ctx.id, 'room.host.changed', { hostUserId: newHost, previousHostUserId: hostId, reason: 'host_disconnected' });
    eventLog.append({ watchSpaceId: ctx.id, type: 'system', body: 'Host role promoted after disconnect.', meta: { newHost, previous: hostId } });
    ctx.log.info('host.promoted', { hostUserId: newHost, previous: hostId });
  };
  if (immediate) promote();
  else setTimer(ctx, 'hostPromote', config.hostGraceMs, promote);
}

function socketGone(ctx, socket, explicit) {
  const uid = socket.data.user.id;
  socket.data.rooms.delete(ctx.id);
  const last = ctx.state.removeSocket(uid, socket.id);
  if (!last) return;
  const wasHost = ctx.state.isHost(uid);
  if (explicit) finalizeLeave(ctx, uid, 'left');
  else {
    presence(ctx, uid, 'reconnecting');
    setTimer(ctx, `leave:${uid}`, config.reconnectGraceMs, () => finalizeLeave(ctx, uid, 'timeout'));
  }
  if (wasHost) onHostGone(ctx, uid, explicit);
}

async function endRoom(watchSpaceId, user) {
  const ws = await WatchSpace.findById(watchSpaceId);
  if (!ws) throw new HttpError(404, 'NOT_FOUND', 'Watch Space not found');
  if (ws.status === 'ended') throw new HttpError(409, 'ALREADY_ENDED', 'Watch Space already ended');
  const ctx = rooms.get(watchSpaceId);
  const isHost = ctx ? ctx.state.isHost(user.id) : String(ws.hostUserId) === user.id;
  if (!isHost && user.role !== 'admin') throw new HttpError(403, 'NOT_HOST', 'Only the host (or an admin) can end this Watch Space');

  const now = new Date();
  if (ctx) {
    for (const t of ctx.timers.values()) clearTimeout(t);
    ctx.timers.clear();
    for (const p of ctx.state.participants.values()) {
      await recordInteraction(ctx, p.userId);
      eventLog.append({ watchSpaceId, userId: p.userId, displayName: p.displayName, type: 'leave', meta: { reason: 'ended' } });
    }
    ws.lastPositionSeconds = ctx.state.positionAt();
  }
  ws.status = 'ended';
  ws.endedAt = now;
  if (!ws.startedAt) ws.startedAt = ws.createdAt;
  await ws.save();
  await eventLog.flush();
  const summary = await computeFromLog(watchSpaceId);
  ws.summary = {
    durationSeconds: summary.durationSeconds,
    peakParticipants: summary.peakParticipants,
    aiQuestions: summary.aiQuestions,
    triviaSurfaced: summary.triviaSurfaced,
    chatMessages: summary.chatMessages,
    reactions: summary.reactions,
  };
  await ws.save();
  if (ctx) {
    broadcast(watchSpaceId, 'room.ended', { summary: ws.summary, endedBy: user.id });
    nsp.in(watchSpaceId).socketsLeave(watchSpaceId);
    rooms.delete(watchSpaceId);
    ctx.log.info('room.ended', { summary: ws.summary });
  }
  return ws.summary;
}

// ---------------------------------------------------------------- AI (shared with REST)
async function askAi(watchSpaceId, user, question, currentTs) {
  const q = sanitizeText(question, 300);
  if (!q) throw new HttpError(400, 'BAD_REQUEST', 'question is required');
  const ws = await WatchSpace.findById(watchSpaceId).lean();
  if (!ws) throw new HttpError(404, 'NOT_FOUND', 'Watch Space not found');
  const ctx = rooms.get(watchSpaceId);
  const title = ctx ? ctx.title : await engine.getTitle(ws.titleId);
  const ts = typeof currentTs === 'number' && Number.isFinite(currentTs) && currentTs >= 0 ? currentTs : ctx ? ctx.state.positionAt() : ws.lastPositionSeconds || 0;
  const verbosity = ctx ? ctx.state.settings.aiVerbosity : ws.settings.aiVerbosity;

  if (ctx) ctx.state.stats.aiQuestions++;
  eventLog.append({ watchSpaceId, userId: user.id, displayName: user.name, type: 'ai_question', body: q, tsSeconds: ts });
  if (ctx) broadcast(watchSpaceId, 'room.ai.thinking', { userId: user.id, displayName: user.name, question: q });

  const result = await engine.answerQuestion({ title, question: q, currentTs: ts, verbosity });
  const payload = { ...result, userId: user.id, displayName: user.name, question: q, tsSeconds: ts };
  eventLog.append({
    msgId: result.questionId,
    watchSpaceId,
    type: 'ai_answer',
    body: result.answer,
    tsSeconds: ts,
    meta: { askedBy: user.id, question: q, sourceEvents: result.sourceEvents, sources: result.sources, model: result.model, latencyMs: result.latencyMs },
  });
  (ctx ? ctx.log : logger).info('ai.answer', { watchSpaceId, questionId: result.questionId, userId: user.id, latencyMs: result.latencyMs, model: result.model, grounded: result.grounded, sourceEvents: result.sourceEvents });
  if (ctx) {
    pushHistory(ctx, { kind: 'ai_answer', messageId: result.questionId, userId: user.id, displayName: 'AI Co-Pilot', question: q, answer: result.answer, sourceEvents: result.sourceEvents, sources: result.sources, tsSeconds: ts, createdAt: new Date() });
    broadcast(watchSpaceId, 'room.ai.answer', payload);
  }
  return payload;
}

// ---------------------------------------------------------------- handlers
function requireJoined(socket, watchSpaceId) {
  const ctx = rooms.get(watchSpaceId);
  if (!ctx || !socket.data.rooms.has(watchSpaceId)) throw new RoomError('NOT_JOINED', 'Join the Watch Space first');
  return ctx;
}

function applyVariationResult(ctx, res) {
  const v = engine.findVariation(ctx.title, res.variationId);
  const option = v.options.find((o) => o.id === res.winningOptionId);
  WatchSpace.updateOne({ _id: ctx.id }, { $push: { appliedVariations: { variationId: res.variationId, optionId: res.winningOptionId, appliedAt: new Date(), via: res.via } } }).catch(() => {});
  eventLog.append({ watchSpaceId: ctx.id, type: 'variation_applied', body: option.label, meta: res, tsSeconds: v.ts });
  const payload = { ...res, kind: v.kind, targetLineId: v.targetLineId, endTs: v.endTs, option };
  broadcast(ctx.id, 'room.variation.applied', payload);
  ctx.log.info('variation.applied', res);
  return payload;
}

function closeVoteNow(ctx) {
  clearTimer(ctx, 'vote');
  const res = ctx.state.closeVote();
  return res ? applyVariationResult(ctx, res) : null;
}

const handlers = {
  async 'room.join'({ socket, env, user }) {
    const watchSpaceId = env.watchSpaceId;
    if (typeof watchSpaceId !== 'string') throw new RoomError('BAD_REQUEST', 'watchSpaceId required');
    const ws = await WatchSpace.findById(watchSpaceId).lean();
    if (!ws) throw new RoomError('NOT_FOUND', 'Watch Space not found');
    if (ws.status === 'ended') throw new RoomError('ENDED', 'This Watch Space has ended');
    const isMember = String(ws.hostUserId) === user.id || ws.participantIds.some((p) => String(p) === user.id);
    if (ws.privacy !== 'public' && !isMember && user.role !== 'admin') throw new RoomError('FORBIDDEN', 'Invite code required to join this Watch Space');

    const ctx = await loadRoom(ws);
    clearTimer(ctx, 'unload');
    const { isNew, resumed } = ctx.state.addParticipant({ userId: user.id, displayName: user.name }, socket.id);
    socket.join(watchSpaceId);
    socket.data.rooms.add(watchSpaceId);
    clearTimer(ctx, `leave:${user.id}`);
    ctx.everJoined.add(user.id);

    if (isNew) {
      eventLog.append({ watchSpaceId, userId: user.id, displayName: user.name, type: 'join', tsSeconds: ctx.state.positionAt() });
      if (!isMember) WatchSpace.updateOne({ _id: watchSpaceId }, { $addToSet: { participantIds: user.id } }).catch(() => {});
      presence(ctx, user.id, 'joined');
    } else if (resumed) {
      presence(ctx, user.id, 'resumed');
    }
    if (ctx.state.isHost(user.id)) {
      if (ws.status === 'scheduled') WatchSpace.updateOne({ _id: watchSpaceId }, { status: 'live', startedAt: new Date() }).catch(() => {});
      if (ctx.state.hostDisconnectedAt) {
        clearTimer(ctx, 'hostPromote');
        ctx.state.hostDisconnectedAt = null;
        broadcast(watchSpaceId, 'room.host.reconnected', { hostUserId: user.id });
      }
    }
    ctx.log.info('presence.join', { userId: user.id, isNew, resumed });
    return { room: roomSnapshot(ctx, user.id), isNew };
  },

  async 'room.leave'({ socket, ctx }) {
    socket.leave(ctx.id);
    socketGone(ctx, socket, true);
    return {};
  },

  async 'room.sync.ping'({ payload }) {
    return { clientSentAt: payload.clientSentAt, serverReceivedAt: Date.now() };
  },

  async 'room.sync.report'({ ctx, user, payload }) {
    const pos = Number(payload.positionSeconds);
    if (!Number.isFinite(pos)) throw new RoomError('BAD_REQUEST', 'positionSeconds required');
    const at = Number.isFinite(payload.serverTimeEstimate) ? payload.serverTimeEstimate : Date.now();
    const p = ctx.state.participants.get(user.id);
    if (p) {
      p.lastPosition = Math.max(p.lastPosition || 0, pos);
      if (Number.isFinite(payload.rttMs)) {
        p.rttMs = Math.round(payload.rttMs);
        const q = p.rttMs < 150 ? 'good' : p.rttMs < 400 ? 'fair' : 'poor';
        if (q !== p.quality) { p.quality = q; presence(ctx, user.id, 'quality', { quality: q }); }
      }
    }
    if (payload.buffering) return { correction: { action: 'none' } };
    const correction = ctx.state.computeCorrection(pos, at);
    if (ctx.state.playback.state === 'playing') metrics.record('sync.drift.abs', Math.abs(correction.driftMs));
    if (correction.action !== 'none') metrics.record(`sync.correction.${correction.action}`, Math.abs(correction.driftMs));
    return { correction, playback: ctx.state.snapshot() };
  },

  async 'room.playback.update'({ ctx, user, payload }) {
    const snap = ctx.state.applyPlayback(user.id, payload);
    clearTimer(ctx, 'hostPromote');
    broadcast(ctx.id, 'room.playback.update', snap);
    ctx.log.info('playback.update', { state: payload.state, positionSeconds: snap.positionSeconds, seq: snap.seq, issuedBy: user.id });
    return { playback: snap };
  },

  async 'room.chat.message'({ ctx, user, payload }) {
    const p = ctx.state.participants.get(user.id);
    if (p && p.muted) throw new RoomError('MUTED', 'The host has muted you');
    const body = sanitizeText(payload.body, 500);
    if (!body) throw new RoomError('BAD_REQUEST', 'Message body required');
    const msg = { kind: 'chat', messageId: crypto.randomUUID(), userId: user.id, displayName: user.name, body, tsSeconds: Math.round(ctx.state.positionAt() * 10) / 10, createdAt: new Date() };
    ctx.state.stats.chat++;
    pushHistory(ctx, msg);
    eventLog.append({ msgId: msg.messageId, watchSpaceId: ctx.id, userId: user.id, displayName: user.name, type: 'chat', body, tsSeconds: msg.tsSeconds });
    broadcast(ctx.id, 'room.chat.message', msg);
    ctx.log.info('chat.message', { userId: user.id, messageId: msg.messageId, length: body.length });
    return { messageId: msg.messageId };
  },

  async 'room.chat.typing'({ socket, ctx, user, payload }) {
    socket.to(ctx.id).emit('message', envelope('room.chat.typing', ctx.id, { userId: user.id, displayName: user.name, isTyping: !!payload.isTyping }));
    return {};
  },

  async 'room.chat.reaction'({ ctx, user, payload }) {
    if (!REACTIONS.includes(payload.emoji)) throw new RoomError('BAD_REQUEST', 'Unsupported reaction');
    ctx.state.stats.reactions++;
    eventLog.append({ watchSpaceId: ctx.id, userId: user.id, displayName: user.name, type: 'reaction', body: payload.emoji, tsSeconds: ctx.state.positionAt() });
    broadcast(ctx.id, 'room.chat.reaction', { userId: user.id, displayName: user.name, emoji: payload.emoji });
    return {};
  },

  async 'room.ai.ask'({ ctx, user, payload }) {
    const res = await askAi(ctx.id, user, payload.question, payload.currentTs);
    return { questionId: res.questionId };
  },

  async 'room.ai.pin'({ ctx, user, payload }) {
    ctx.state.requireHost(user.id);
    const text = sanitizeText(payload.text, 500);
    if (!text) throw new RoomError('BAD_REQUEST', 'text required');
    broadcast(ctx.id, 'room.ai.pinned', { text, sourceEventId: payload.sourceEventId || null, pinnedBy: user.id });
    return {};
  },

  async 'room.ai.triviaRound'({ ctx, user }) {
    ctx.state.requireHost(user.id);
    const pos = ctx.state.positionAt();
    const pool = ctx.title.timeline.filter((e) => e.type === 'trivia' && e.ts <= pos + 2);
    const pick = pool.reverse().find((e) => !ctx.state.firedTrivia.has(e.id)) || pool[0];
    if (!pick) throw new RoomError('NO_TRIVIA', 'No trivia available at this point yet');
    ctx.state.firedTrivia.add(pick.id);
    ctx.state.stats.trivia++;
    const card = { ...engine.triviaCard(ctx.title, pick), onDemand: true, lagMs: 0 };
    eventLog.append({ watchSpaceId: ctx.id, type: 'trivia', body: card.text, tsSeconds: pos, meta: { eventId: pick.id, onDemand: true } });
    broadcast(ctx.id, 'room.ai.trivia', card);
    return { eventId: pick.id };
  },

  async 'room.settings.update'({ ctx, user, payload }) {
    ctx.state.requireHost(user.id);
    const s = ctx.state.settings;
    if (payload.triviaEnabled !== undefined) s.triviaEnabled = !!payload.triviaEnabled;
    if (payload.votingEnabled !== undefined) s.votingEnabled = !!payload.votingEnabled;
    if (payload.aiVerbosity !== undefined) {
      if (!['minimal', 'normal', 'chatty'].includes(payload.aiVerbosity)) throw new RoomError('BAD_REQUEST', 'Invalid aiVerbosity');
      s.aiVerbosity = payload.aiVerbosity;
      ctx.track = engine.triviaTrack(ctx.title, s.aiVerbosity);
    }
    await WatchSpace.updateOne({ _id: ctx.id }, { 'settings.triviaEnabled': s.triviaEnabled, 'settings.votingEnabled': s.votingEnabled, 'settings.aiVerbosity': s.aiVerbosity });
    broadcast(ctx.id, 'room.settings.update', { settings: s });
    return { settings: s };
  },

  async 'room.variation.openVote'({ ctx, user, payload }) {
    const v = engine.findVariation(ctx.title, payload.variationId);
    const open = ctx.state.openVote(user.id, v, payload.durationSec);
    setTimer(ctx, 'vote', open.closesAt - Date.now(), () => closeVoteNow(ctx));
    eventLog.append({ watchSpaceId: ctx.id, type: 'system', body: `Vote opened: ${v.prompt}`, meta: { variationId: v.id } });
    broadcast(ctx.id, 'room.variation.voteOpen', open);
    return open;
  },

  async 'room.variation.vote'({ ctx, user, payload }) {
    const tally = ctx.state.castVote(user.id, payload.variationId, payload.optionId);
    eventLog.append({ watchSpaceId: ctx.id, userId: user.id, displayName: user.name, type: 'vote', body: payload.optionId, meta: { variationId: payload.variationId } });
    broadcast(ctx.id, 'room.variation.voteTally', tally);
    return tally;
  },

  async 'room.variation.closeVote'({ ctx, user }) {
    ctx.state.requireHost(user.id);
    const res = closeVoteNow(ctx);
    if (!res) throw new RoomError('NO_VOTE', 'No vote is open');
    return res;
  },

  async 'room.variation.apply'({ ctx, user, payload }) {
    const v = engine.findVariation(ctx.title, payload.variationId);
    const res = ctx.state.applyVariation(user.id, v, payload.optionId);
    clearTimer(ctx, 'vote');
    return applyVariationResult(ctx, res);
  },

  async 'room.mod.mute'({ ctx, user, payload }) {
    ctx.state.setMuted(user.id, payload.userId, true);
    presence(ctx, String(payload.userId), 'muted');
    return {};
  },
  async 'room.mod.unmute'({ ctx, user, payload }) {
    ctx.state.setMuted(user.id, payload.userId, false);
    presence(ctx, String(payload.userId), 'unmuted');
    return {};
  },
  async 'room.mod.remove'({ ctx, user, payload }) {
    const target = String(payload.userId);
    const p = ctx.state.removeParticipant(user.id, target);
    clearTimer(ctx, `leave:${target}`);
    const sockets = await nsp.in(ctx.id).fetchSockets();
    for (const s of sockets) {
      if (s.data.user.id === target) {
        s.emit('message', envelope('room.removed', ctx.id, { by: user.id }));
        s.leave(ctx.id);
        s.data.rooms.delete(ctx.id);
      }
    }
    if (p) eventLog.append({ watchSpaceId: ctx.id, userId: target, displayName: p.displayName, type: 'leave', meta: { reason: 'removed' } });
    presence(ctx, target, 'left', { reason: 'removed' });
    return {};
  },
  async 'room.mod.lock'({ ctx, user }) {
    ctx.state.setLocked(user.id, true);
    broadcast(ctx.id, 'room.lock.update', { locked: true });
    return {};
  },
  async 'room.mod.unlock'({ ctx, user }) {
    ctx.state.setLocked(user.id, false);
    broadcast(ctx.id, 'room.lock.update', { locked: false });
    return {};
  },
  async 'room.mod.transferHost'({ ctx, user, payload }) {
    const to = ctx.state.transferHost(user.id, payload.userId);
    await WatchSpace.updateOne({ _id: ctx.id }, { hostUserId: to });
    broadcast(ctx.id, 'room.host.changed', { hostUserId: to, previousHostUserId: user.id, reason: 'transfer' });
    presence(ctx, to, 'host');
    return {};
  },

  async 'room.end'({ ctx, user }) {
    const summary = await endRoom(ctx.id, user);
    return { summary };
  },

  // Lets a long-lived socket swap in a refreshed access token without reconnecting.
  async 'session.reauth'({ socket, payload }) {
    const claims = verifyAccess(payload.accessToken);
    if (claims.sub !== socket.data.user.id) throw new RoomError('FORBIDDEN', 'Token belongs to another user');
    socket.data.tokenExp = claims.exp;
    socket.data.user.role = claims.role;
    return {};
  },
};

// ---------------------------------------------------------------- trivia / variation scheduler
function tick() {
  const now = Date.now();
  for (const ctx of rooms.values()) {
    const s = ctx.state;
    if (s.playback.state !== 'playing') continue;
    const due = s.dueTrivia(s.settings.triviaEnabled ? ctx.track : [], now);
    for (const e of due) {
      const crossedAt = s.playback.updatedAt + ((e.ts - s.playback.position) / s.playback.rate) * 1000;
      const lagMs = Math.max(0, now - crossedAt);
      metrics.record('trivia.lag', lagMs);
      s.stats.trivia++;
      const card = { ...engine.triviaCard(ctx.title, e), lagMs: Math.round(lagMs) };
      eventLog.append({ watchSpaceId: ctx.id, type: 'trivia', body: card.text, tsSeconds: e.ts, meta: { eventId: e.id, lagMs: card.lagMs } });
      broadcast(ctx.id, 'room.ai.trivia', card);
    }
    for (const v of engine.evaluateVariations(ctx.title, s.positionAt(now), s.appliedVariations)) {
      if (ctx.offered.has(v.id)) continue;
      ctx.offered.add(v.id);
      broadcast(ctx.id, 'room.variation.suggested', { variationId: v.id, kind: v.kind, prompt: v.prompt, ts: v.ts, options: v.options.map(({ id, label }) => ({ id, label })), defaultOptionId: v.defaultOptionId });
    }
  }
}

// ---------------------------------------------------------------- wiring
function init(io) {
  nsp = io.of('/rooms');
  nsp.use((socket, next) => {
    try {
      const claims = verifyAccess(socket.handshake.auth && socket.handshake.auth.token);
      socket.data.user = { id: claims.sub, role: claims.role, name: claims.name };
      socket.data.tokenExp = claims.exp;
      socket.data.rooms = new Set();
      next();
    } catch (e) {
      const err = new Error('UNAUTHENTICATED');
      err.data = { code: 'UNAUTHENTICATED', message: 'Valid access token required at handshake' };
      next(err);
    }
  });

  nsp.on('connection', (socket) => {
    socket.on('message', async (env, ack) => {
      const reply = typeof ack === 'function' ? ack : null;
      const event = env && env.event;
      try {
        if (!env || typeof event !== 'string' || !handlers[event]) throw new RoomError('BAD_REQUEST', `Unknown or malformed event "${event}"`);
        if (SENSITIVE.has(event) && Date.now() / 1000 > socket.data.tokenExp) throw new RoomError('TOKEN_EXPIRED', 'Access token expired; send session.reauth');
        // Stateless events (clock sync, re-auth) are allowed before joining so clients can sync clocks first.
        const ctx = event === 'room.join' || event === 'session.reauth' || event === 'room.sync.ping' ? null : requireJoined(socket, env.watchSpaceId);
        const result = await handlers[event]({ socket, ctx, env, user: socket.data.user, payload: (env.payload && typeof env.payload === 'object') ? env.payload : {} });
        // Structured log for every room event (high-frequency sync traffic is captured as metrics instead).
        if (!event.startsWith('room.sync.')) {
          const room = ctx || rooms.get(env.watchSpaceId);
          (room ? room.log : logger).info('ws.event', { event, userId: socket.data.user.id, watchSpaceId: env.watchSpaceId });
        }
        if (reply) reply({ ok: true, ...result });
      } catch (e) {
        const known = e instanceof RoomError || e instanceof HttpError || e.name === 'JsonWebTokenError' || e.name === 'TokenExpiredError';
        const error = { code: e.code || (known ? 'UNAUTHENTICATED' : 'INTERNAL'), message: known ? e.message : 'Internal error', event };
        if (!known) logger.error('ws handler error', { event, error: e.message, stack: e.stack });
        else logger.info('ws.rejected', { event, code: error.code, userId: socket.data.user.id, watchSpaceId: env && env.watchSpaceId });
        if (reply) reply({ ok: false, error });
        else sendTo(socket, 'room.error', env && env.watchSpaceId, error);
      }
    });
    socket.on('disconnect', () => {
      for (const id of [...socket.data.rooms]) {
        const ctx = rooms.get(id);
        if (ctx) socketGone(ctx, socket, false);
      }
    });
  });

  ticker = setInterval(tick, 100);
  ticker.unref();
  return nsp;
}

function getStats() {
  return { rooms: rooms.size, sockets: nsp ? nsp.sockets.size : 0 };
}

function shutdown() {
  if (ticker) clearInterval(ticker);
  for (const ctx of rooms.values()) for (const t of ctx.timers.values()) clearTimeout(t);
  rooms.clear();
}

module.exports = { init, askAi, endRoom, broadcast, getStats, shutdown, rooms };
