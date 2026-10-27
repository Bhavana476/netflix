// Retrieval over a title's timeline metadata. Pure functions: no DB, no network.
const STOP = new Set(
  ('a an the is are was were be been am i me my you your he she it its they them this that these those who what whom whose which ' +
    'when where why how do does did of in on at to for from with about as by and or but so just there here ' +
    'can could would should will tell please know any some has have had happen happened happening mean means meaning ' +
    'that\'s whats who\'s guy girl person someone one thing').split(/\s+/)
);

function stem(w) {
  if (w.length > 5 && w.endsWith('ing')) return w.slice(0, -3);
  if (w.length > 4 && w.endsWith('ed')) return w.slice(0, -2);
  if (w.length > 3 && w.endsWith('s') && !w.endsWith('ss')) return w.slice(0, -1);
  return w;
}

function tokenize(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s'-]/g, ' ')
    .split(/[\s'-]+/)
    .filter((w) => w && !STOP.has(w))
    .map(stem);
}

function detectIntent(question) {
  const q = question.toLowerCase();
  if (/\bwho\b|character|actor|walked in|that (guy|girl|man|woman)/.test(q)) return 'who';
  if (/\bmean|meaning|definition|define|what is an?\b|what's an?\b|what does .* stand/.test(q)) return 'define';
  if (/earlier|before|recap|so far|previous|missed|what happened|catch me up/.test(q)) return 'recap';
  return 'general';
}

function characterName(title, id) {
  return (title.characters || []).find((c) => c.id === id);
}

function eventText(title, e) {
  switch (e.type) {
    case 'character': {
      const c = characterName(title, e.characterId);
      return `${c ? c.name : ''} ${c ? c.description || '' : ''} ${e.text || ''}`;
    }
    case 'glossary': return `${e.term} ${e.term} ${e.definition}`;
    case 'scene': return `${e.title} ${e.text}`;
    case 'variation_point': return e.variation ? e.variation.prompt : '';
    default: return e.text || '';
  }
}

/**
 * Returns the most relevant timeline entries for a question at a playback position.
 * Only entries at or before currentTs (+ small lookahead) are eligible, so the co-pilot never spoils later events.
 */
function retrieveContext(title, currentTs, question, { k = 4, lookaheadSec = 2, minScore = 0.9, relativeCutoff = 0.75 } = {}) {
  const eligible = (title.timeline || []).filter((e) => e.ts <= currentTs + lookaheadSec && e.type !== 'variation_point');
  if (!eligible.length) return [];
  const intent = detectIntent(question);
  const qTokens = [...new Set(tokenize(question))];
  // "Who is that?" points at a person on screen; "Who won the World Cup?" or "Who directed this?" do not.
  const deictic =
    /\b(he|she|him|her|guy|girl|man|woman|character|walk(ed|ing|s)? in|on screen|appear(ed|s)?|entered)\b/i.test(question) ||
    /\bwho('s| is| are)? (this|that|they|these|those)\s*\??\s*$/i.test(question.trim());
  // "just walked in" / "right now" favours the most recent appearance sharply.
  const justNow = /\b(just|now|walked in|appeared|entered)\b/i.test(question);

  const docs = eligible.map((e) => ({ e, tokens: new Set(tokenize(eventText(title, e))) }));
  const df = new Map();
  for (const d of docs) for (const t of d.tokens) df.set(t, (df.get(t) || 0) + 1);
  const N = docs.length;

  const scored = docs.map(({ e, tokens }) => {
    let lexical = 0;
    for (const t of qTokens) if (tokens.has(t)) lexical += Math.log(1 + (N + 1) / (df.get(t) || 1));
    const age = Math.max(0, currentTs - e.ts);
    const recency = Math.exp(-age / 180);
    const onScreen = e.type === 'character' && e.ts <= currentTs + lookaheadSec && (e.endTs ?? e.ts) >= currentTs;
    let score = lexical;
    if (intent === 'who' && e.type === 'character' && (deictic || lexical > 0)) {
      score += onScreen ? 2.5 + (justNow ? 2 * Math.exp(-age / 20) : recency) : 0.6 * recency;
    }
    if (intent === 'define' && e.type === 'glossary') score += lexical > 0 ? 1.5 : 0;
    if (intent === 'recap' && e.type === 'scene') score += 1.2 + recency;
    if (lexical > 0) score += 0.4 * recency;
    return { event: e, score: Math.round(score * 1000) / 1000, onScreen, intent };
  });

  const ranked = scored.filter((s) => s.score >= minScore).sort((a, b) => b.score - a.score || b.event.ts - a.event.ts);
  // Keep only entries competitive with the best match, so answers don't pad with loosely related facts.
  const cutoff = ranked.length ? ranked[0].score * relativeCutoff : 0;
  return ranked.filter((s) => s.score >= cutoff).slice(0, k);
}

/** Timeline events in [from, to], using the sorted embedded array (binary search for the lower bound). */
function eventsInRange(timeline, from = 0, to = Infinity) {
  let lo = 0, hi = timeline.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (timeline[mid].ts < from) lo = mid + 1; else hi = mid;
  }
  const out = [];
  for (let i = lo; i < timeline.length && timeline[i].ts <= to; i++) out.push(timeline[i]);
  return out;
}

module.exports = { tokenize, detectIntent, retrieveContext, eventsInRange, eventText, characterName };
