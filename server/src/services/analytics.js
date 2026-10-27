// Session analytics are computed from the event log itself, so the stored summary always reconciles with it.
const { SessionEvent, WatchSpace } = require('../models');

async function computeFromLog(watchSpaceId) {
  const ws = await WatchSpace.findById(watchSpaceId).lean();
  if (!ws) return null;
  const events = await SessionEvent.find({ watchSpaceId }).sort({ createdAt: 1, _id: 1 }).lean();
  const counts = { chat: 0, ai_question: 0, ai_answer: 0, trivia: 0, reaction: 0, join: 0, leave: 0, vote: 0, variation_applied: 0, system: 0 };
  let current = 0, peak = 0;
  const present = new Set();
  for (const e of events) {
    counts[e.type] = (counts[e.type] || 0) + 1;
    const uid = String(e.userId);
    if (e.type === 'join' && !present.has(uid)) { present.add(uid); current++; peak = Math.max(peak, current); }
    if (e.type === 'leave' && present.has(uid)) { present.delete(uid); current--; }
  }
  const start = ws.startedAt ? new Date(ws.startedAt) : null;
  const end = ws.endedAt ? new Date(ws.endedAt) : new Date();
  return {
    watchSpaceId,
    status: ws.status,
    startedAt: ws.startedAt || null,
    endedAt: ws.endedAt || null,
    durationSeconds: start ? Math.round((end - start) / 1000) : 0,
    peakParticipants: peak,
    aiQuestions: counts.ai_question,
    triviaSurfaced: counts.trivia,
    chatMessages: counts.chat,
    reactions: counts.reaction,
    eventCounts: counts,
    totalEvents: events.length,
  };
}

module.exports = { computeFromLog };
