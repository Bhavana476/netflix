// End-to-end real-time behaviour over real sockets: sync, chat ordering/persistence, reconnect,
// host failover, trivia triggering, voting and analytics reconciliation.
const { startTestServer, loadFixtureTitle, makeUser, connect, sleep } = require('./helpers');

let t, titleId;
beforeAll(async () => {
  t = await startTestServer();
  titleId = await loadFixtureTitle();
});
afterAll(() => t.stopAll());

async function setupRoom(nParticipants = 2, settings = {}) {
  const host = await makeUser(t, 'host', 'Host');
  const res = await t.http().post('/api/v1/watch-spaces').set('Authorization', `Bearer ${host.token}`).send({ titleId, privacy: 'public', ...settings });
  const wsId = res.body.watchSpaceId;
  const users = [host];
  for (let i = 0; i < nParticipants; i++) users.push(await makeUser(t, 'viewer', `P${i}`));
  const clients = users.map((u) => connect(t, u.token));
  await Promise.all(clients.map((c) => c.ready));
  for (const c of clients) expect((await c.send('room.join', wsId)).ok).toBe(true);
  return { wsId, users, clients, host: clients[0], others: clients.slice(1) };
}

test('host play/pause/seek reaches all clients within 1 second', async () => {
  const { wsId, host, others, clients } = await setupRoom(3);
  for (const action of [{ state: 'play', positionSeconds: 30 }, { state: 'pause' }, { state: 'seek', positionSeconds: 120 }]) {
    others.forEach((c) => c.clear());
    const sentAt = Date.now();
    await host.send('room.playback.update', wsId, action);
    const got = await Promise.all(others.map((c) => c.waitFor('room.playback.update', (p) => p.lastAction === action.state)));
    for (const g of got) expect(g.receivedAt - sentAt).toBeLessThan(1000);
  }
  const final = others[0].received.filter((e) => e.event === 'room.playback.update').pop().payload;
  expect(final).toMatchObject({ state: 'paused', positionSeconds: 120 });
  clients.forEach((c) => c.close());
});

test('a participant joining mid-playback gets the authoritative position (within 250ms)', async () => {
  const { wsId, host, clients } = await setupRoom(0);
  await host.send('room.playback.update', wsId, { state: 'play', positionSeconds: 100 });
  await sleep(700);
  const late = await makeUser(t, 'viewer');
  const c = connect(t, late.token);
  await c.ready;
  const res = await c.send('room.join', wsId);
  const p = res.room.playback;
  const projected = p.positionSeconds + (Date.now() - p.serverTime) / 1000;
  expect(p.state).toBe('playing');
  expect(Math.abs(projected - 100.7)).toBeLessThan(0.25);
  // The client's drift report is checked against the same authoritative clock.
  const report = await c.send('room.sync.report', wsId, { positionSeconds: projected, serverTimeEstimate: Date.now() });
  expect(report.correction.action).toBe('none');
  const lagging = await c.send('room.sync.report', wsId, { positionSeconds: projected - 3, serverTimeEstimate: Date.now() });
  expect(lagging.correction.action).toBe('seek');
  [...clients, c].forEach((x) => x.close());
});

test('sync ping/pong works before joining (clock sync precedes the join handshake)', async () => {
  const u = await makeUser(t, 'viewer');
  const fresh = connect(t, u.token);
  await fresh.ready;
  const early = await fresh.send('room.sync.ping', 'ws_not_joined', { clientSentAt: Date.now() });
  expect(early.serverReceivedAt).toBeGreaterThan(0);
  fresh.close();
});

test('sync ping/pong returns the server receive time', async () => {
  const { wsId, host, clients } = await setupRoom(0);
  const clientSentAt = Date.now();
  const pong = await host.send('room.sync.ping', wsId, { clientSentAt });
  expect(pong.clientSentAt).toBe(clientSentAt);
  expect(pong.serverReceivedAt).toBeGreaterThanOrEqual(clientSentAt);
  clients.forEach((c) => c.close());
});

test('chat is delivered in order to everyone and history is available after reconnect', async () => {
  const { wsId, host, others, clients, users } = await setupRoom(2);
  for (let i = 0; i < 10; i++) host.send('room.chat.message', wsId, { body: `m${i}` });
  await others[1].waitFor('room.chat.message', (p) => p.body === 'm9');
  for (const c of others) {
    expect(c.received.filter((e) => e.event === 'room.chat.message').map((e) => e.payload.body)).toEqual(Array.from({ length: 10 }, (_, i) => `m${i}`));
  }
  // Reconnect inside the grace window: history comes back and no duplicate "joined" is broadcast.
  others[0].close();
  await host.waitFor('room.presence.update', (p) => p.action === 'reconnecting');
  host.clear();
  const again = connect(t, users[1].token);
  await again.ready;
  const res = await again.send('room.join', wsId);
  expect(res.isNew).toBe(false);
  expect(res.room.history.filter((m) => m.kind === 'chat').map((m) => m.body)).toEqual(Array.from({ length: 10 }, (_, i) => `m${i}`));
  await host.waitFor('room.presence.update', (p) => p.action === 'resumed');
  expect(host.received.some((e) => e.event === 'room.presence.update' && e.payload.action === 'joined')).toBe(false);
  // Persisted (batched) history via REST.
  await sleep(150);
  const rest = await t.http().get(`/api/v1/watch-spaces/${wsId}/messages`).set('Authorization', `Bearer ${users[0].token}`);
  expect(rest.body.messages.filter((m) => m.type === 'chat').map((m) => m.body)).toEqual(Array.from({ length: 10 }, (_, i) => `m${i}`));
  [...clients, again].forEach((c) => c.close());
});

test('a client gone longer than the grace window is reported as left', async () => {
  const { host, others, clients } = await setupRoom(1);
  others[0].close();
  const left = await host.waitFor('room.presence.update', (p) => p.action === 'left', 2000);
  expect(left.payload.participantCount).toBe(1);
  clients.forEach((c) => c.close());
});

test('host disconnect: playback pauses for everyone, then the earliest participant is promoted', async () => {
  const { wsId, host, others, clients, users } = await setupRoom(2);
  await host.send('room.playback.update', wsId, { state: 'play', positionSeconds: 50 });
  await others[0].waitFor('room.playback.update', (p) => p.state === 'playing');
  host.close();
  const paused = await others[0].waitFor('room.playback.update', (p) => p.lastAction === 'host_disconnected');
  expect(paused.payload.state).toBe('paused');
  await others[1].waitFor('room.host.disconnected');
  const changed = await others[1].waitFor('room.host.changed', () => true, 2000);
  expect(changed.payload.hostUserId).toBe(users[1].id);
  // New host can now control playback; the other participant still cannot.
  expect((await others[0].send('room.playback.update', wsId, { state: 'play' })).ok).toBe(true);
  expect((await others[1].send('room.playback.update', wsId, { state: 'pause' })).ok).toBe(false);
  clients.forEach((c) => c.close());
});

test('host reconnecting within the grace window keeps the host role', async () => {
  const { wsId, host, others, clients, users } = await setupRoom(1);
  host.close();
  await others[0].waitFor('room.host.disconnected');
  const back = connect(t, users[0].token);
  await back.ready;
  await back.send('room.join', wsId);
  await others[0].waitFor('room.host.reconnected');
  await sleep(500);
  expect(others[0].received.some((e) => e.event === 'room.host.changed')).toBe(false);
  [...clients, back].forEach((c) => c.close());
});

test('trivia cards fire within 1 second of crossing their authored marker', async () => {
  const { wsId, host, others, clients } = await setupRoom(1);
  // Markers at 5s (high) and 20s; start just before 5s.
  await host.send('room.playback.update', wsId, { state: 'play', positionSeconds: 4.3 });
  const card = await others[0].waitFor('room.ai.trivia', (p) => p.eventId === 'evt_bbb_002', 3000);
  expect(card.payload.lagMs).toBeLessThan(1000);
  expect(card.payload.text).toMatch(/Peach/);
  clients.forEach((c) => c.close());
});

test('variation vote result is applied identically to all clients', async () => {
  const { wsId, host, others, clients } = await setupRoom(2);
  const open = await host.send('room.variation.openVote', wsId, { variationId: 'v_bbb_01', durationSec: 5 });
  expect(open.ok).toBe(true);
  await Promise.all(others.map((c) => c.waitFor('room.variation.voteOpen')));
  await others[0].send('room.variation.vote', wsId, { variationId: 'v_bbb_01', optionId: 'b' });
  await others[1].send('room.variation.vote', wsId, { variationId: 'v_bbb_01', optionId: 'b' });
  await host.send('room.variation.vote', wsId, { variationId: 'v_bbb_01', optionId: 'c' });
  await host.send('room.variation.closeVote', wsId);
  const applied = await Promise.all(clients.map((c) => c.waitFor('room.variation.applied')));
  const payloads = applied.map((a) => a.payload);
  for (const p of payloads) expect(p).toEqual(payloads[0]);
  expect(payloads[0]).toMatchObject({ variationId: 'v_bbb_01', winningOptionId: 'b', applyAtTs: 228, targetLineId: 'sub_bbb_05' });
  // A subtitle swap does not touch playback state.
  expect(clients[1].received.some((e) => e.event === 'room.playback.update' && e.receivedAt > applied[1].receivedAt)).toBe(false);
  clients.forEach((c) => c.close());
});

test('AI ask over REST is grounded and broadcast to the room', async () => {
  const { wsId, others, clients, users } = await setupRoom(1);
  const res = await t.http().post(`/api/v1/watch-spaces/${wsId}/ai/ask`).set('Authorization', `Bearer ${users[1].token}`).send({ userId: users[1].id, currentTs: 152, question: 'Who is the character that just walked in?' });
  expect(res.status).toBe(200);
  expect(res.body.sourceEvents.length).toBeGreaterThan(0);
  expect(res.body.grounded).toBe(true);
  const b = await others[0].waitFor('room.ai.answer');
  expect(b.payload.sourceEvents).toEqual(res.body.sourceEvents);
  clients.forEach((c) => c.close());
});

test('ending a session persists a summary that reconciles with the event log', async () => {
  const { wsId, host, others, clients, users } = await setupRoom(2);
  await host.send('room.chat.message', wsId, { body: 'hello' });
  await others[0].send('room.chat.message', wsId, { body: 'hey' });
  await others[1].send('room.chat.reaction', wsId, { emoji: '🔥' });
  await others[0].send('room.ai.ask', wsId, { question: 'What is a burrow?', currentTs: 100 });
  await host.send('room.playback.update', wsId, { state: 'play', positionSeconds: 4.5 });
  await others[0].waitFor('room.ai.trivia', () => true, 3000);
  const end = await host.send('room.end', wsId);
  expect(end.ok).toBe(true);
  expect(end.summary).toMatchObject({ peakParticipants: 3, chatMessages: 2, aiQuestions: 1, triviaSurfaced: 1, reactions: 1 });
  const a = await t.http().get(`/api/v1/watch-spaces/${wsId}/analytics`).set('Authorization', `Bearer ${users[0].token}`);
  expect(a.body.reconciles).toBe(true);
  // Participation was recorded as interaction data for the recommender.
  const hist = await t.http().get('/api/v1/me/history').set('Authorization', `Bearer ${users[1].token}`);
  expect(hist.body.history.map((h) => h.titleId)).toContain(titleId);
  clients.forEach((c) => c.close());
});
