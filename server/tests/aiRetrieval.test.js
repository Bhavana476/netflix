const fs = require('fs');
const path = require('path');
const { parseTimeline, validateTimeline, toTitleDoc } = require('../src/ai/timelineSchema');
const { retrieveContext, eventsInRange, detectIntent } = require('../src/ai/retrieval');
const engine = require('../src/ai/engine');

function fixture(file) {
  const text = fs.readFileSync(path.resolve(__dirname, '../data/timelines', file), 'utf8');
  const { data } = parseTimeline(text);
  const doc = toTitleDoc(data);
  doc.subtitles.lines = doc.subtitles.lines.map((l) => ({ ...l, alternates: l.alternates || {} }));
  return doc;
}

const bbb = fixture('big-buck-bunny.yaml');
const tos = fixture('tears-of-steel.yaml');
const sintel = fixture('sintel.yaml');

describe('retrieval', () => {
  test('intent detection', () => {
    expect(detectIntent('Who is the character that just walked in?')).toBe('who');
    expect(detectIntent('What does burrow mean?')).toBe('define');
    expect(detectIntent('What happened earlier?')).toBe('recap');
  });

  test('"who just walked in" returns the most recently appeared on-screen character only', () => {
    const hits = retrieveContext(bbb, 152, 'Who is the character that just walked in?');
    expect(hits.map((h) => h.event.characterId)).toEqual(['c_frank']);
  });

  test('"who directed this?" answers from trivia, not from whoever is on screen', () => {
    const hits = retrieveContext(bbb, 300, 'Who directed this?');
    expect(hits[0].event.id).toBe('evt_bbb_016');
    expect(hits.some((h) => h.event.type === 'character')).toBe(false);
  });

  test('"what does X mean" prefers the glossary entry and drops weaker matches', () => {
    const hits = retrieveContext(bbb, 75, 'What does burrow mean?');
    expect(hits.map((h) => h.event.id)).toEqual(['evt_bbb_005']);
  });

  test('named-entity question finds the glossary entry', () => {
    const hits = retrieveContext(tos, 300, 'What is motion tracking?');
    expect(hits[0].event.id).toBe('evt_tos_009');
  });

  test('never retrieves entries after the current timestamp (no spoilers)', () => {
    const hits = retrieveContext(sintel, 200, 'What happens in the confrontation with the dragon lair?');
    for (const h of hits) expect(h.event.ts).toBeLessThanOrEqual(202);
    expect(hits.find((h) => h.event.id === 'evt_sin_020')).toBeUndefined();
  });

  test('irrelevant questions retrieve nothing', () => {
    expect(retrieveContext(bbb, 300, 'What is the capital of Australia?')).toEqual([]);
  });

  test('range query uses the ts-sorted timeline', () => {
    const r = eventsInRange(bbb.timeline, 150, 170);
    expect(r.map((e) => e.id)).toEqual(['evt_bbb_009', 'evt_bbb_010', 'evt_bbb_011', 'evt_bbb_012']);
    expect(eventsInRange(bbb.timeline, 1000, 2000)).toEqual([]);
  });
});

describe('grounded answers (extractive mode)', () => {
  test('answer cites the timeline entries it used, all of which exist in the title', async () => {
    const r = await engine.answerQuestion({ title: bbb, question: 'Who is Frank?', currentTs: 200 });
    expect(r.grounded).toBe(true);
    expect(r.sourceEvents.length).toBeGreaterThan(0);
    const ids = new Set(bbb.timeline.map((e) => e.id));
    for (const s of r.sourceEvents) expect(ids.has(s)).toBe(true);
    expect(r.answer).toMatch(/Frank/);
    expect(r.explanation).toMatch(/evt_bbb_/);
  });

  test('declines instead of fabricating when there is no relevant metadata', async () => {
    const r = await engine.answerQuestion({ title: bbb, question: 'Who won the 1998 World Cup?', currentTs: 300 });
    expect(r).toMatchObject({ grounded: false, sourceEvents: [] });
    expect(r.answer).toMatch(/rather not guess/);
  });

  test('every sentence of an extractive answer comes from a cited entry', async () => {
    const r = await engine.answerQuestion({ title: tos, question: 'What is the Oude Kerk?', currentTs: 270, verbosity: 'minimal' });
    expect(r.sourceEvents).toEqual(['evt_tos_012']);
    expect(r.answer).toContain(tos.timeline.find((e) => e.id === 'evt_tos_012').definition);
  });

  test('verbosity controls how many entries are used', async () => {
    const min = await engine.answerQuestion({ title: bbb, question: 'who are the bullies Frank Rinky Gimera', currentTs: 200, verbosity: 'minimal' });
    const chatty = await engine.answerQuestion({ title: bbb, question: 'who are the bullies Frank Rinky Gimera', currentTs: 200, verbosity: 'chatty' });
    expect(min.sourceEvents.length).toBe(1);
    expect(chatty.sourceEvents.length).toBe(3);
  });
});

describe('trivia tracks, variations and subtitles', () => {
  test('verbosity filters the trivia track', () => {
    const minimal = engine.triviaTrack(bbb, 'minimal');
    expect(minimal.every((e) => e.type === 'trivia' && e.importance === 'high')).toBe(true);
    expect(engine.triviaTrack(bbb, 'chatty').length).toBeGreaterThan(engine.triviaTrack(bbb, 'normal').length);
  });

  test('locale alternates replace default lines; applied variations override them', () => {
    const es = engine.resolveSubtitles(bbb, 'es');
    expect(es.lines.find((l) => l.id === 'sub_bbb_05')).toMatchObject({ text: '[El conejo suspira] Otra vez no...', source: 'locale:es' });
    expect(es.availableLocales).toEqual(expect.arrayContaining(['en', 'es', 'fr', 'hi']));
    const applied = engine.resolveSubtitles(bbb, 'es', { v_bbb_01: 'c' });
    expect(applied.lines.find((l) => l.id === 'sub_bbb_05')).toMatchObject({ text: "[Bunny sighs] I'm not mad. I'm just disappointed.", source: 'variation:v_bbb_01' });
    expect(engine.resolveSubtitles(bbb, 'de').lines[0].source).toBe('default');
  });

  test('upcoming variation points are offered only within the window and until applied', () => {
    expect(engine.evaluateVariations(bbb, 200).map((v) => v.id)).toEqual(['v_bbb_01']);
    expect(engine.evaluateVariations(bbb, 200, { v_bbb_01: 'a' })).toEqual([]);
    expect(engine.evaluateVariations(bbb, 0)).toEqual([]);
  });
});

describe('timeline schema validation', () => {
  test('authored fixtures are valid', () => {
    for (const f of ['big-buck-bunny.yaml', 'sintel.yaml', 'tears-of-steel.yaml']) {
      const { data } = parseTimeline(fs.readFileSync(path.resolve(__dirname, '../data/timelines', f), 'utf8'));
      expect(validateTimeline(data)).toEqual({ valid: true, errors: [] });
    }
  });

  test('malformed uploads are rejected with precise paths', () => {
    const bad = {
      title: { id: 'bad id', name: '', durationSeconds: 100, genres: [], videoAssetUrl: 'ftp://x' },
      characters: [{ id: 'c_1', name: 'A' }],
      events: [
        { id: 'evt_1', ts: 500, type: 'trivia', text: 'x' },
        { id: 'evt_1', ts: 5, type: 'character', characterId: 'c_404' },
        { id: 'evt_3', ts: 5, type: 'trivia', text: '<script>alert(1)</script>' },
        { id: 'evt_4', ts: 5, type: 'variation_point', variation: { id: 'v_1', kind: 'scene', prompt: 'p', defaultOptionId: 'z', options: [{ id: 'a', label: 'A', text: 'a' }] } },
        { id: 'evt_5', ts: 5, type: 'nonsense' },
      ],
    };
    const { valid, errors } = validateTimeline(bad);
    expect(valid).toBe(false);
    const paths = errors.map((e) => e.path);
    expect(paths).toEqual(expect.arrayContaining([
      'title.id', 'title.name', 'title.genres', 'title.videoAssetUrl', 'events[0].ts', 'events[1].id',
      'events[1].characterId', 'events[1].endTs', 'events[2].text', 'events[3].variation.options', 'events[4].type',
    ]));
  });

  test('YAML syntax errors report line numbers', () => {
    const r = parseTimeline('title:\n  id: t_1\n   name: broken', 'yaml');
    expect(r.error).toMatch(/line \d+/);
  });
});
