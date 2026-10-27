// AI Content Engine: shared by REST controllers and the Socket.io gateway.
// ingest_timeline -> retrieve_context -> generate_answer, plus trivia selection and variation evaluation.
const { Title } = require('../models');
const { config } = require('../config');
const { retrieveContext, characterName } = require('./retrieval');
const { parseTimeline, validateTimeline, toTitleDoc } = require('./timelineSchema');
const { fmtTs, id } = require('../util');
const metrics = require('../metrics');
const log = require('../logger');

// ---------- title cache (timeline is read-heavy, write-rare) ----------
const cache = new Map();

async function getTitle(titleId) {
  const hit = cache.get(titleId);
  if (hit) return hit;
  const doc = await Title.findById(titleId).lean();
  if (!doc) return null;
  doc.subtitles = doc.subtitles || { lines: [] };
  doc.subtitles.lines = (doc.subtitles.lines || []).map((l) => ({ ...l, alternates: l.alternates instanceof Map ? Object.fromEntries(l.alternates) : l.alternates || {} }));
  cache.set(titleId, doc);
  return doc;
}
const invalidateTitle = (titleId) => cache.delete(titleId);

async function ingestTimeline(content, format = 'auto') {
  const parsed = parseTimeline(content, format);
  if (parsed.error) return { valid: false, errors: [{ path: '$', message: parsed.error }] };
  const result = validateTimeline(parsed.data);
  if (!result.valid) return result;
  const titleDoc = toTitleDoc(parsed.data);
  const existing = await Title.findById(titleDoc._id).select('timelineVersion').lean();
  titleDoc.timelineVersion = existing ? (existing.timelineVersion || 1) + 1 : 1;
  await Title.findOneAndUpdate({ _id: titleDoc._id }, titleDoc, { upsert: true, overwrite: true, runValidators: true });
  invalidateTitle(titleDoc._id);
  return { valid: true, errors: [], titleId: titleDoc._id, timelineVersion: titleDoc.timelineVersion, eventCount: titleDoc.timeline.length };
}

// ---------- grounded answers ----------
const VERBOSITY_ENTRIES = { minimal: 1, normal: 2, chatty: 3 };

function describe(title, e) {
  switch (e.type) {
    case 'character': {
      const c = characterName(title, e.characterId);
      return c ? `That's ${c.name} — ${c.description || 'a character in this story'} (on screen from ${fmtTs(e.ts)}).` : e.text;
    }
    case 'glossary': return `"${e.term}": ${e.definition}`;
    case 'scene': return `Earlier, at ${fmtTs(e.ts)} ("${e.title}"): ${e.text}`;
    default: return e.text;
  }
}

function sourceLabel(title, e) {
  const label = e.type === 'character' ? (characterName(title, e.characterId) || {}).name : e.term || e.title || (e.text || '').slice(0, 60);
  return { id: e.id, type: e.type, ts: e.ts, label };
}

function extractiveAnswer(title, hits, verbosity) {
  const n = VERBOSITY_ENTRIES[verbosity] || 2;
  const used = hits.slice(0, n).map((h) => h.event);
  return { answer: used.map((e) => describe(title, e)).join(' '), usedIds: used.map((e) => e.id), model: 'extractive' };
}

async function llmAnswer(title, question, hits, verbosity, currentTs) {
  const entries = hits.map((h) => ({ id: h.event.id, type: h.event.type, at: fmtTs(h.event.ts), content: describe(title, h.event) }));
  const system =
    'You are the AI co-pilot in a group watch party. Answer ONLY using the provided timeline entries for this title. ' +
    'Never add facts that are not in the entries and never reveal events after the current timestamp. ' +
    `Answer length: ${verbosity === 'minimal' ? 'one short sentence' : verbosity === 'chatty' ? 'up to 4 sentences' : 'one or two sentences'}. ` +
    'Respond with JSON only: {"answer": string, "usedEventIds": string[]}. If the entries do not answer the question, respond {"answer": "NO_ANSWER", "usedEventIds": []}.';
  const user = JSON.stringify({ title: title.name, currentTimestamp: fmtTs(currentTs), question, entries });

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), config.aiTimeoutMs);
  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      signal: ctrl.signal,
      headers: { 'content-type': 'application/json', 'x-api-key': config.anthropicApiKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: config.aiModel, max_tokens: 300, system, messages: [{ role: 'user', content: user }] }),
    });
    if (!res.ok) throw new Error(`LLM HTTP ${res.status}`);
    const body = await res.json();
    const text = (body.content || []).map((c) => c.text || '').join('');
    const json = JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1));
    const allowed = new Set(hits.map((h) => h.event.id));
    const usedIds = (json.usedEventIds || []).filter((x) => allowed.has(x));
    // Grounding guard: an answer that cites nothing retrieved is not accepted.
    if (json.answer === 'NO_ANSWER' || !usedIds.length || typeof json.answer !== 'string') return null;
    return { answer: json.answer.slice(0, 800), usedIds, model: config.aiModel };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Answers a viewer question grounded in the title's timeline at currentTs.
 * The payload always lists the exact timeline entries used (sourceEvents); with no relevant entries it declines.
 */
async function answerQuestion({ title, question, currentTs, verbosity = 'normal' }) {
  const started = Date.now();
  const hits = retrieveContext(title, currentTs, question, { k: 4 });
  let result = null;
  if (hits.length && config.anthropicApiKey) {
    try {
      result = await llmAnswer(title, question, hits, verbosity, currentTs);
    } catch (e) {
      log.warn('llm answer failed, using extractive fallback', { error: e.message });
    }
  }
  if (!result && hits.length) result = extractiveAnswer(title, hits, verbosity);
  const latencyMs = Date.now() - started;
  metrics.record('ai.answer', latencyMs);

  if (!result) {
    return {
      questionId: id('q'),
      answer: `I don't have anything in the ${title.name} metadata up to ${fmtTs(currentTs)} that answers that, so I'd rather not guess.`,
      sourceEvents: [],
      sources: [],
      grounded: false,
      model: 'none',
      latencyMs,
      generatedAt: new Date().toISOString(),
    };
  }
  const byId = new Map(hits.map((h) => [h.event.id, h.event]));
  const sources = result.usedIds.map((x) => sourceLabel(title, byId.get(x)));
  return {
    questionId: id('q'),
    answer: result.answer,
    sourceEvents: result.usedIds,
    sources,
    explanation: `Drawn from ${sources.map((s) => `${s.type} entry ${s.id} @ ${fmtTs(s.ts)}`).join(', ')}.`,
    grounded: true,
    model: result.model,
    latencyMs,
    generatedAt: new Date().toISOString(),
  };
}

// ---------- trivia selection ----------
// Which timeline entries surface as cards, by host-selected verbosity.
function triviaTrack(title, verbosity = 'normal') {
  return (title.timeline || []).filter((e) => {
    if (verbosity === 'minimal') return e.type === 'trivia' && e.importance === 'high';
    if (verbosity === 'chatty') return e.type === 'trivia' || e.type === 'glossary' || e.type === 'scene';
    return e.type === 'trivia';
  });
}

function triviaCard(title, e) {
  return { eventId: e.id, type: e.type, tsSeconds: e.ts, text: e.type === 'trivia' ? e.text : describe(title, e) };
}

// ---------- variations ----------
function findVariation(title, variationId) {
  const e = (title.timeline || []).find((x) => x.type === 'variation_point' && x.variation && x.variation.id === variationId);
  return e ? { ...e.variation, ts: e.ts, endTs: e.endTs ?? e.ts + 8, eventId: e.id } : null;
}

function listVariations(title) {
  return (title.timeline || []).filter((e) => e.type === 'variation_point').map((e) => findVariation(title, e.variation.id));
}

/** Upcoming variation points within `windowSec` ahead of the playhead that are not yet applied (offered to host). */
function evaluateVariations(title, currentTs, applied = {}, windowSec = 45) {
  return listVariations(title).filter((v) => v.ts > currentTs && v.ts - currentTs <= windowSec && !applied[v.id]);
}

/** Subtitle track resolved for a locale: authored alternates replace the default line where they exist. */
function resolveSubtitles(title, locale = 'en', applied = {}) {
  const overrides = {};
  for (const v of listVariations(title)) {
    if (v.kind === 'subtitle' && applied[v.id]) {
      const opt = v.options.find((o) => o.id === applied[v.id]);
      if (opt) overrides[v.targetLineId] = { text: opt.text, variationId: v.id };
    }
  }
  const lines = (title.subtitles.lines || []).map((l) => {
    if (overrides[l.id]) return { id: l.id, start: l.start, end: l.end, text: overrides[l.id].text, source: `variation:${overrides[l.id].variationId}` };
    const alt = l.alternates && (l.alternates[locale] || l.alternates[locale.split('-')[0]]);
    return { id: l.id, start: l.start, end: l.end, text: alt || l.text, source: alt ? `locale:${locale}` : 'default' };
  });
  const locales = new Set([title.subtitles.defaultLocale || 'en']);
  for (const l of title.subtitles.lines || []) for (const k of Object.keys(l.alternates || {})) locales.add(k);
  return { titleId: title._id, version: title.subtitles.version || 1, locale, availableLocales: [...locales], lines };
}

module.exports = {
  getTitle,
  invalidateTitle,
  ingestTimeline,
  answerQuestion,
  triviaTrack,
  triviaCard,
  findVariation,
  listVariations,
  evaluateVariations,
  resolveSubtitles,
};
