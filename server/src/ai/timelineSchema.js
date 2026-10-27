// Validates an authored title timeline (JSON or YAML) against the documented schema (docs/TIMELINE_SCHEMA.md).
// Returns every problem with a JSON path so the admin upload form can show precise, non-engineer-friendly errors.
const yaml = require('js-yaml');

const EVENT_TYPES = ['trivia', 'character', 'glossary', 'scene', 'variation_point'];
const MAX_EVENTS = 2000;

function parseTimeline(content, format = 'auto') {
  if (content && typeof content === 'object') return { data: content };
  if (typeof content !== 'string' || !content.trim()) return { error: 'Upload is empty.' };
  const looksJson = /^\s*[{[]/.test(content);
  try {
    if (format === 'json' || (format === 'auto' && looksJson)) return { data: JSON.parse(content) };
    return { data: yaml.load(content, { schema: yaml.JSON_SCHEMA }) };
  } catch (e) {
    const where = e.mark ? ` (line ${e.mark.line + 1}, column ${e.mark.column + 1})` : '';
    return { error: `Could not parse ${format === 'json' || looksJson ? 'JSON' : 'YAML'}${where}: ${e.reason || e.message}` };
  }
}

function validateTimeline(doc) {
  const errors = [];
  const err = (path, message) => errors.push({ path, message });
  const isStr = (v, max = 2000) => typeof v === 'string' && v.trim().length > 0 && v.length <= max;
  const noHtml = (path, v) => {
    if (typeof v === 'string' && /[<>]/.test(v)) err(path, 'HTML/angle brackets are not allowed in text fields.');
  };
  const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) {
    return { valid: false, errors: [{ path: '$', message: 'Top level must be an object with "title", "characters" and "events".' }] };
  }

  const t = doc.title;
  let duration = Infinity;
  if (!t || typeof t !== 'object') err('title', 'Required object.');
  else {
    if (!isStr(t.id, 64) || !/^t_[A-Za-z0-9_]+$/.test(t.id)) err('title.id', 'Required; must look like "t_1001".');
    if (!isStr(t.name, 200)) err('title.name', 'Required text (max 200 chars).');
    noHtml('title.name', t.name);
    if (!isNum(t.durationSeconds) || t.durationSeconds <= 0) err('title.durationSeconds', 'Required positive number of seconds.');
    else duration = t.durationSeconds;
    if (!Array.isArray(t.genres) || !t.genres.length || !t.genres.every((g) => isStr(g, 40))) err('title.genres', 'Required non-empty list of genre names.');
    if (!isStr(t.videoAssetUrl, 1000) || !/^(https?:\/\/|\/media\/)/.test(t.videoAssetUrl)) err('title.videoAssetUrl', 'Required; must start with http(s):// or /media/.');
    if (t.synopsis !== undefined) noHtml('title.synopsis', t.synopsis);
    if (t.year !== undefined && !Number.isInteger(t.year)) err('title.year', 'Must be a whole number.');
    if (t.tags !== undefined && (!Array.isArray(t.tags) || !t.tags.every((g) => isStr(g, 40)))) err('title.tags', 'Must be a list of short text tags.');
  }

  const charIds = new Set();
  if (doc.characters !== undefined && !Array.isArray(doc.characters)) err('characters', 'Must be a list.');
  (Array.isArray(doc.characters) ? doc.characters : []).forEach((c, i) => {
    const p = `characters[${i}]`;
    if (!c || !isStr(c.id, 64) || !/^c_[A-Za-z0-9_]+$/.test(c.id)) err(`${p}.id`, 'Required; must look like "c_01".');
    else if (charIds.has(c.id)) err(`${p}.id`, `Duplicate character id "${c.id}".`);
    else charIds.add(c.id);
    if (!c || !isStr(c.name, 100)) err(`${p}.name`, 'Required text.');
    if (c) { noHtml(`${p}.name`, c.name); noHtml(`${p}.description`, c.description); }
  });

  const lineIds = new Set();
  if (doc.subtitles !== undefined) {
    const s = doc.subtitles;
    if (!s || !Array.isArray(s.lines)) err('subtitles.lines', 'Must be a list of subtitle lines.');
    else s.lines.forEach((l, i) => {
      const p = `subtitles.lines[${i}]`;
      if (!l || !isStr(l.id, 64)) return err(`${p}.id`, 'Required.');
      if (lineIds.has(l.id)) err(`${p}.id`, `Duplicate line id "${l.id}".`);
      lineIds.add(l.id);
      if (!isNum(l.start) || !isNum(l.end) || l.end <= l.start) err(p, '"start" and "end" must be numbers with end > start.');
      if (!isStr(l.text, 500)) err(`${p}.text`, 'Required text.');
      noHtml(`${p}.text`, l.text);
      if (l.alternates !== undefined) {
        if (typeof l.alternates !== 'object' || Array.isArray(l.alternates)) err(`${p}.alternates`, 'Must map locale -> text, e.g. { "es": "Hola" }.');
        else for (const [loc, txt] of Object.entries(l.alternates)) {
          if (!/^[a-z]{2}(-[A-Z]{2})?$/.test(loc)) err(`${p}.alternates.${loc}`, 'Locale must look like "es" or "en-IN".');
          if (!isStr(txt, 500)) err(`${p}.alternates.${loc}`, 'Alternate text required.');
          noHtml(`${p}.alternates.${loc}`, txt);
        }
      }
    });
  }

  if (!Array.isArray(doc.events)) err('events', 'Required list of timeline events.');
  const events = Array.isArray(doc.events) ? doc.events : [];
  if (events.length > MAX_EVENTS) err('events', `At most ${MAX_EVENTS} events per title.`);
  const evtIds = new Set();
  const varIds = new Set();
  events.forEach((e, i) => {
    const p = `events[${i}]`;
    if (!e || typeof e !== 'object') return err(p, 'Each event must be an object.');
    if (!isStr(e.id, 64) || !/^evt_[A-Za-z0-9_]+$/.test(e.id)) err(`${p}.id`, 'Required; must look like "evt_0001".');
    else if (evtIds.has(e.id)) err(`${p}.id`, `Duplicate event id "${e.id}".`);
    else evtIds.add(e.id);
    if (!isNum(e.ts) || e.ts < 0 || e.ts > duration) err(`${p}.ts`, `Required number of seconds between 0 and the title duration (${duration}).`);
    if (e.endTs !== undefined && (!isNum(e.endTs) || e.endTs < e.ts || e.endTs > duration)) err(`${p}.endTs`, 'Must be >= ts and <= duration.');
    if (!EVENT_TYPES.includes(e.type)) return err(`${p}.type`, `Must be one of: ${EVENT_TYPES.join(', ')}.`);
    if (e.importance !== undefined && !['low', 'normal', 'high'].includes(e.importance)) err(`${p}.importance`, 'Must be low, normal or high.');
    for (const f of ['text', 'term', 'definition', 'title']) noHtml(`${p}.${f}`, e[f]);
    switch (e.type) {
      case 'trivia':
        if (!isStr(e.text, 1000)) err(`${p}.text`, 'Trivia needs "text".');
        break;
      case 'character':
        if (!charIds.has(e.characterId)) err(`${p}.characterId`, `Must reference a character id declared in "characters" (got "${e.characterId}").`);
        if (e.endTs === undefined) err(`${p}.endTs`, 'Character appearance windows need an "endTs".');
        break;
      case 'glossary':
        if (!isStr(e.term, 100)) err(`${p}.term`, 'Glossary entries need "term".');
        if (!isStr(e.definition, 1000)) err(`${p}.definition`, 'Glossary entries need "definition".');
        break;
      case 'scene':
        if (!isStr(e.title, 200)) err(`${p}.title`, 'Scene markers need "title".');
        if (!isStr(e.text, 1000)) err(`${p}.text`, 'Scene markers need a "text" summary.');
        break;
      case 'variation_point': {
        const v = e.variation;
        if (!v || typeof v !== 'object') { err(`${p}.variation`, 'Variation points need a "variation" object.'); break; }
        if (!isStr(v.id, 64) || !/^v_[A-Za-z0-9_]+$/.test(v.id)) err(`${p}.variation.id`, 'Required; must look like "v_01".');
        else if (varIds.has(v.id)) err(`${p}.variation.id`, `Duplicate variation id "${v.id}".`);
        else varIds.add(v.id);
        if (!['subtitle', 'scene'].includes(v.kind)) err(`${p}.variation.kind`, 'Must be "subtitle" or "scene".');
        if (v.kind === 'subtitle' && !lineIds.has(v.targetLineId)) err(`${p}.variation.targetLineId`, 'Subtitle variations must target a declared subtitle line id.');
        if (!isStr(v.prompt, 300)) err(`${p}.variation.prompt`, 'Required short question shown to voters.');
        noHtml(`${p}.variation.prompt`, v.prompt);
        if (!Array.isArray(v.options) || v.options.length < 2 || v.options.length > 5) { err(`${p}.variation.options`, 'Provide 2 to 5 pre-approved options.'); break; }
        const optIds = new Set();
        v.options.forEach((o, j) => {
          const op = `${p}.variation.options[${j}]`;
          if (!o || !isStr(o.id, 32)) return err(`${op}.id`, 'Required.');
          if (optIds.has(o.id)) err(`${op}.id`, `Duplicate option id "${o.id}".`);
          optIds.add(o.id);
          if (!isStr(o.label, 200)) err(`${op}.label`, 'Required.');
          if (!isStr(o.text, 500)) err(`${op}.text`, 'Required: the exact pre-approved text/caption to apply.');
          noHtml(`${op}.label`, o.label); noHtml(`${op}.text`, o.text);
        });
        if (!optIds.has(v.defaultOptionId)) err(`${p}.variation.defaultOptionId`, 'Must be one of the option ids (used on ties).');
        break;
      }
    }
  });

  return { valid: errors.length === 0, errors };
}

// Converts a validated document into the Title shape stored in MongoDB.
function toTitleDoc(doc) {
  const t = doc.title;
  const events = [...doc.events].sort((a, b) => a.ts - b.ts);
  return {
    _id: t.id,
    name: t.name,
    synopsis: t.synopsis || '',
    year: t.year,
    durationSeconds: t.durationSeconds,
    genres: t.genres,
    tags: t.tags || [],
    videoAssetUrl: t.videoAssetUrl,
    posterColor: t.posterColor,
    characters: doc.characters || [],
    timeline: events,
    subtitles: doc.subtitles
      ? { version: doc.subtitles.version || 1, defaultLocale: doc.subtitles.defaultLocale || 'en', lines: doc.subtitles.lines }
      : { version: 1, defaultLocale: 'en', lines: [] },
    hasFullTimeline: events.length >= 5,
  };
}

module.exports = { parseTimeline, validateTimeline, toTitleDoc, EVENT_TYPES };
