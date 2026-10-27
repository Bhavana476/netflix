// Generates the PRD Section 12.2 evidence against a running server using the seeded demo accounts:
//   node scripts/evidence.js            (server must be running: npm start)
// Writes JSON artifacts to docs/evidence/.
require('../src/config');
const fs = require('fs');
const path = require('path');
const { io } = require('socket.io-client');
const { summarize } = require('../src/metrics');

const BASE = process.env.EVIDENCE_BASE || `http://localhost:${process.env.PORT || 4000}`;
const OUT = path.resolve(__dirname, '../../docs/evidence');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const save = (name, data) => {
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(path.join(OUT, name), JSON.stringify(data, null, 2));
  console.log(`  wrote docs/evidence/${name}`);
};

async function http(method, url, token, body) {
  const res = await fetch(BASE + url, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, body: res.status === 204 ? null : await res.json() };
}
async function login(email, envKey) {
  const r = await http('POST', '/api/v1/auth/login', null, { email, password: process.env[envKey] });
  if (r.status !== 200) throw new Error(`login ${email} failed (${r.status}); set ${envKey} to the seeded password`);
  return { ...r.body.user, token: r.body.accessToken };
}
function socketFor(user, wsId) {
  const s = io(`${BASE}/rooms`, { auth: { token: user.token }, transports: ['websocket'], forceNew: true });
  const got = [];
  s.on('message', (e) => got.push({ ...e, at: Date.now() }));
  return {
    got,
    ready: new Promise((r) => s.on('connect', r)),
    send: (event, payload = {}) => new Promise((r) => s.emit('message', { event, watchSpaceId: wsId, payload, ts: Date.now() }, r)),
    close: () => s.disconnect(),
  };
}

(async () => {
  const admin = await login('admin@watchspaces.local', 'SEED_ADMIN_PASSWORD');
  const host = await login('host@watchspaces.local', 'SEED_HOST_PASSWORD');
  const viewer = await login('viewer@watchspaces.local', 'SEED_VIEWER_PASSWORD');
  const viewer2 = await login('viewer2@watchspaces.local', 'SEED_VIEWER_PASSWORD');

  // ---------------- RBAC evidence
  console.log('RBAC');
  const tl = { title: { id: 't_9999', name: 'Nope', durationSeconds: 10, genres: ['X'], videoAssetUrl: '/media/x.mp4' }, events: [] };
  save('rbac-rejections.json', {
    viewerUploadsTimeline: await http('POST', '/api/v1/admin/timelines', viewer.token, { timeline: tl }),
    hostUploadsTimeline: await http('POST', '/api/v1/admin/timelines', host.token, { timeline: tl }),
    viewerCreatesWatchSpace: await http('POST', '/api/v1/watch-spaces', viewer.token, { titleId: 't_1001' }),
    viewerReadsMetrics: await http('GET', '/api/v1/admin/metrics', viewer.token),
    noToken: await http('GET', '/api/v1/titles', null),
    adminValidatesMalformedTimeline: await http('POST', '/api/v1/admin/timelines/validate', admin.token, { content: 'title:\n  id: bad id\n  durationSeconds: -5\nevents:\n  - { id: evt_1, ts: 3, type: trivia }\n', format: 'yaml' }),
  });

  // ---------------- room: Q&A, trivia timing, vote, subtitle swap, analytics
  console.log('Watch Space session');
  const created = await http('POST', '/api/v1/watch-spaces', host.token, { titleId: 't_1001', name: 'Evidence session', maxParticipants: 10, aiVerbosity: 'chatty', votingEnabled: true });
  const ws = created.body;
  await http('POST', '/api/v1/watch-spaces/join', viewer.token, { inviteCode: ws.inviteCode });
  await http('POST', '/api/v1/watch-spaces/join', viewer2.token, { inviteCode: ws.inviteCode });
  const H = socketFor(host, ws.watchSpaceId), V = socketFor(viewer, ws.watchSpaceId), V2 = socketFor(viewer2, ws.watchSpaceId);
  await Promise.all([H.ready, V.ready, V2.ready]);
  const viewerRejectedOverWs = await V.send('room.join').then(() => V.send('room.playback.update', { state: 'play' }));
  await H.send('room.join');
  await V2.send('room.join');
  save('rbac-websocket-rejection.json', { event: 'room.playback.update sent by a viewer (not host)', response: viewerRejectedOverWs });

  // Trivia timing: for every marker on the chatty track (trivia + glossary + scene), seek just before it, play, measure.
  const title = (await http('GET', '/api/v1/titles/t_1001/timeline', viewer.token)).body;
  const markers = title.events.filter((e) => ['trivia', 'glossary', 'scene'].includes(e.type) && e.ts >= 1);
  const triviaResults = [];
  for (const m of markers) {
    V.got.length = 0;
    await H.send('room.playback.update', { state: 'seek', positionSeconds: m.ts - 0.6 });
    await H.send('room.playback.update', { state: 'play' });
    const crossAt = Date.now() + 600;
    await sleep(1800);
    const card = V.got.find((e) => e.event === 'room.ai.trivia' && e.payload.eventId === m.id);
    triviaResults.push({ eventId: m.id, ts: m.ts, type: m.type, received: !!card, appearedAfterCrossingMs: card ? card.at - crossAt : null, serverLagMs: card ? card.payload.lagMs : null });
    await H.send('room.playback.update', { state: 'pause' });
  }
  const within1s = triviaResults.filter((r) => r.received && r.appearedAfterCrossingMs < 1000).length;
  save('trivia-timing.json', { title: 't_1001', markers: triviaResults.length, within1s, ratio: within1s / triviaResults.length, target: '>= 95% within 1s', lagSummaryMs: summarize(triviaResults.filter((r) => r.received).map((r) => r.appearedAfterCrossingMs)), results: triviaResults });

  // Grounded Q&A exchanges (REST) at specific timestamps.
  const qa = [];
  for (const [currentTs, question] of [[152, 'Who is the character that just walked in?'], [75, 'What does burrow mean?'], [265, 'What happened earlier?'], [300, 'Who directed this?'], [300, 'Who won the 1998 World Cup?']]) {
    const t0 = Date.now();
    const r = await http('POST', `/api/v1/watch-spaces/${ws.watchSpaceId}/ai/ask`, viewer.token, { userId: viewer.id, currentTs, question });
    qa.push({ request: { currentTs, question }, latencyMs: Date.now() - t0, response: r.body });
  }
  const timeline = (await http('GET', '/api/v1/titles/t_1001/timeline', viewer.token)).body.events;
  save('ai-qa-exchanges.json', { exchanges: qa, citedEntries: Object.fromEntries([...new Set(qa.flatMap((x) => x.response.sourceEvents))].map((id) => [id, timeline.find((e) => e.id === id)])) });

  // Subtitle swap (viewer locale es vs default en) + group vote applied to all clients.
  const subsEn = (await http('GET', '/api/v1/titles/t_1001/subtitles?locale=en', viewer.token)).body;
  const subsEs = (await http('GET', '/api/v1/titles/t_1001/subtitles?locale=es', viewer.token)).body;
  await H.send('room.playback.update', { state: 'seek', positionSeconds: 200 });
  await H.send('room.playback.update', { state: 'play' });
  const open = await H.send('room.variation.openVote', { variationId: 'v_bbb_01', durationSec: 6 });
  await V.send('room.variation.vote', { variationId: 'v_bbb_01', optionId: 'c' });
  await V2.send('room.variation.vote', { variationId: 'v_bbb_01', optionId: 'c' });
  await H.send('room.variation.vote', { variationId: 'v_bbb_01', optionId: 'b' });
  await sleep(6500);
  const applied = [H, V, V2].map((c, i) => ({ client: ['host', 'viewer', 'viewer2'][i], event: c.got.find((e) => e.event === 'room.variation.applied') }));
  const playbackAfterSwap = [V, V2].map((c) => c.got.filter((e) => e.event === 'room.playback.update' && e.at > applied[1].event.at).length);
  save('variation-and-subtitles.json', {
    subtitleLocaleSwap: { line: 'sub_bbb_05', en: subsEn.lines.find((l) => l.id === 'sub_bbb_05'), es: subsEs.lines.find((l) => l.id === 'sub_bbb_05') },
    voteOpened: open,
    appliedOnEachClient: applied.map((a) => ({ client: a.client, receivedAt: a.event.at, payload: a.event.payload })),
    identicalPayloads: applied.every((a) => JSON.stringify(a.event.payload) === JSON.stringify(applied[0].event.payload)),
    receiveSpreadMs: Math.max(...applied.map((a) => a.event.at)) - Math.min(...applied.map((a) => a.event.at)),
    playbackUpdatesCausedBySwap: playbackAfterSwap,
  });

  // Chat + end session -> analytics reconciliation.
  await V.send('room.chat.message', { body: 'This bunny is huge' });
  await V2.send('room.chat.message', { body: 'Frank is the worst' });
  await H.send('room.chat.reaction', { emoji: '😂' });
  await sleep(300);
  const end = await H.send('room.end');
  await sleep(300);
  const analytics = (await http('GET', `/api/v1/watch-spaces/${ws.watchSpaceId}/analytics`, host.token)).body;
  save('session-analytics-reconciliation.json', { endAck: end, analytics });
  [H, V, V2].forEach((c) => c.close());

  // ---------------- recommendation rail with the interaction data behind it
  console.log('Recommendations');
  const rail = (await http('GET', '/api/v1/me/recommendations?k=8', viewer.token)).body;
  const history = (await http('GET', '/api/v1/me/history', viewer.token)).body;
  save('recommendation-rail-viewer.json', { user: viewer.email, interactions: history.history, rail });
  await http('POST', '/api/v1/me/interactions', viewer.token, { titleId: 't_1003', rating: 5, watchedSeconds: 734, completed: true });
  const railAfter = (await http('GET', '/api/v1/me/recommendations?k=8', viewer.token)).body;
  save('recommendation-rail-update.json', { action: 'viewer rated Tears of Steel 5 stars (no retrain)', before: rail.items.map((i) => `${i.title.name} (${i.score}) - ${i.reason}`), after: railAfter.items.map((i) => `${i.title.name} (${i.score}) - ${i.reason}`), sameModelTrainedAt: rail.modelTrainedAt === railAfter.modelTrainedAt });

  save('server-metrics.json', (await http('GET', '/api/v1/admin/metrics', admin.token)).body);
  console.log('Evidence complete.');
  process.exit(0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
