const jwt = require('jsonwebtoken');
const { startTestServer, loadFixtureTitle, makeUser, connect } = require('./helpers');

let t, admin, host, viewer, outsider, titleId;

beforeAll(async () => {
  t = await startTestServer();
  titleId = await loadFixtureTitle();
  [admin, host, viewer, outsider] = await Promise.all([makeUser(t, 'admin'), makeUser(t, 'host'), makeUser(t, 'viewer'), makeUser(t, 'viewer')]);
});
afterAll(() => t.stopAll());

const auth = (u) => ({ Authorization: `Bearer ${u.token}` });
const minimalTimeline = { title: { id: 't_rbac', name: 'RBAC', durationSeconds: 60, genres: ['Test'], videoAssetUrl: '/media/x.mp4' }, characters: [], events: [] };

describe('authentication', () => {
  test('protected routes reject missing, forged and expired tokens', async () => {
    expect((await t.http().get('/api/v1/titles')).status).toBe(401);
    expect((await t.http().get('/api/v1/titles').set('Authorization', 'Bearer not-a-jwt')).status).toBe(401);
    const forged = jwt.sign({ sub: admin.id, role: 'admin' }, 'some-other-secret-that-is-long-enough-123456');
    expect((await t.http().get('/api/v1/admin/metrics').set('Authorization', `Bearer ${forged}`)).status).toBe(401);
    const expired = jwt.sign({ sub: admin.id, role: 'admin', exp: Math.floor(Date.now() / 1000) - 10 }, process.env.JWT_SECRET);
    const res = await t.http().get('/api/v1/admin/metrics').set('Authorization', `Bearer ${expired}`);
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('TOKEN_EXPIRED');
  });

  test('access tokens are short-lived (<= 1 hour)', () => {
    const { exp, iat } = jwt.decode(viewer.token);
    expect(exp - iat).toBeLessThanOrEqual(3600);
  });

  test('refresh rotates the token; a used refresh token cannot be replayed', async () => {
    const u = await makeUser(t, 'viewer');
    const r1 = await t.http().post('/api/v1/auth/refresh').send({ refreshToken: u.refreshToken });
    expect(r1.status).toBe(200);
    expect(r1.body.accessToken).toBeTruthy();
    const replay = await t.http().post('/api/v1/auth/refresh').send({ refreshToken: u.refreshToken });
    expect(replay.status).toBe(401);
  });

  test('self-registration cannot grant admin', async () => {
    const res = await t.http().post('/api/v1/auth/register').send({ email: `x${Date.now()}@t.local`, password: 'password-123', displayName: 'X', role: 'admin' });
    expect(res.status).toBe(201);
    expect(res.body.user.role).toBe('viewer');
  });
});

describe('admin-only actions are enforced server-side', () => {
  test.each([
    ['post', '/api/v1/admin/timelines', { timeline: minimalTimeline }],
    ['post', '/api/v1/admin/timelines/validate', { timeline: minimalTimeline }],
    ['post', '/api/v1/admin/recommendations/retrain', {}],
    ['get', '/api/v1/admin/metrics', null],
    ['get', '/api/v1/admin/users', null],
    ['delete', '/api/v1/admin/titles/t_1001', null],
  ])('%s %s -> 403 for viewer and host', async (method, url, body) => {
    for (const u of [viewer, host]) {
      const req = t.http()[method](url).set(auth(u));
      const res = await (body ? req.send(body) : req);
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('FORBIDDEN');
    }
  });

  test('admin can upload a timeline; malformed uploads get a clear 422', async () => {
    const ok = await t.http().post('/api/v1/admin/timelines').set(auth(admin)).send({ content: JSON.stringify(minimalTimeline), format: 'json' });
    expect(ok.status).toBe(201);
    expect(ok.body).toMatchObject({ valid: true, titleId: 't_rbac' });
    const bad = await t.http().post('/api/v1/admin/timelines').set(auth(admin)).send({ content: 'title:\n  id: nope\nevents: 5', format: 'yaml' });
    expect(bad.status).toBe(422);
    expect(bad.body.errors.map((e) => e.path)).toEqual(expect.arrayContaining(['title.id', 'events']));
  });
});

describe('host-only actions', () => {
  let wsId;
  test('viewers cannot create Watch Spaces; hosts can', async () => {
    const denied = await t.http().post('/api/v1/watch-spaces').set(auth(viewer)).send({ titleId });
    expect(denied.status).toBe(403);
    const ok = await t.http().post('/api/v1/watch-spaces').set(auth(host)).send({ titleId, maxParticipants: 25, aiVerbosity: 'normal', votingEnabled: true });
    expect(ok.status).toBe(201);
    expect(ok.body).toMatchObject({ status: 'scheduled', hostUserId: host.id });
    expect(ok.body.inviteCode).toMatch(/^NX-[A-Z2-9]{4}$/);
    wsId = ok.body.watchSpaceId;
  });

  test('invite-only rooms are closed to non-members until they use the invite code', async () => {
    expect((await t.http().get(`/api/v1/watch-spaces/${wsId}`).set(auth(outsider))).status).toBe(403);
    expect((await t.http().post(`/api/v1/watch-spaces/${wsId}/ai/ask`).set(auth(outsider)).send({ question: 'who?', currentTs: 1 })).status).toBe(403);
    const ws = (await t.http().get(`/api/v1/watch-spaces/${wsId}`).set(auth(host))).body;
    expect((await t.http().post('/api/v1/watch-spaces/join').set(auth(viewer)).send({ inviteCode: ws.inviteCode })).status).toBe(200);
    expect((await t.http().get(`/api/v1/watch-spaces/${wsId}`).set(auth(viewer))).status).toBe(200);
  });

  test('a participant cannot end the room; the host can', async () => {
    const denied = await t.http().post(`/api/v1/watch-spaces/${wsId}/end`).set(auth(viewer));
    expect(denied.status).toBe(403);
    expect(denied.body.error.code).toBe('NOT_HOST');
  });

  test('WebSocket handshake requires a valid JWT', async () => {
    const c = connect(t, 'garbage');
    await expect(c.ready).rejects.toThrow('UNAUTHENTICATED');
    c.close();
  });

  test('over WebSocket, only the current host may issue playback/moderation/vote events', async () => {
    const h = connect(t, host.token);
    const v = connect(t, viewer.token);
    await Promise.all([h.ready, v.ready]);
    expect((await h.send('room.join', wsId)).ok).toBe(true);
    expect((await v.send('room.join', wsId)).ok).toBe(true);
    for (const [event, payload] of [
      ['room.playback.update', { state: 'play', positionSeconds: 10 }],
      ['room.mod.lock', {}],
      ['room.mod.mute', { userId: host.id }],
      ['room.variation.openVote', { variationId: 'v_bbb_01' }],
      ['room.settings.update', { triviaEnabled: false }],
      ['room.end', {}],
    ]) {
      const res = await v.send(event, wsId, payload);
      expect(res).toMatchObject({ ok: false, error: { code: 'NOT_HOST' } });
    }
    expect((await h.send('room.playback.update', wsId, { state: 'play', positionSeconds: 10 })).ok).toBe(true);
    h.close();
    v.close();
  });

  test('outsiders cannot join an invite-only room over WebSocket', async () => {
    const o = connect(t, outsider.token);
    await o.ready;
    expect(await o.send('room.join', wsId)).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } });
    o.close();
  });

  test('chat input is sanitized server-side (no stored XSS)', async () => {
    const h = connect(t, host.token);
    await h.ready;
    await h.send('room.join', wsId);
    await h.send('room.chat.message', wsId, { body: 'hi <img src=x onerror=alert(1)><script>alert(2)</script>there' });
    const msg = await h.waitFor('room.chat.message');
    expect(msg.payload.body).not.toMatch(/[<>]/);
    expect(msg.payload.body).toBe('hi alert(2)there');
    h.close();
  });
});

describe('host access code', () => {
  const upgrade = (u, code) => t.http().post('/api/v1/auth/host-code').set(auth(u)).send({ code });

  test('requires authentication', async () => {
    expect((await t.http().post('/api/v1/auth/host-code').send({ code: 'TEST-HOST-CODE' })).status).toBe(401);
  });

  test('a wrong code is rejected and the viewer stays a viewer', async () => {
    const u = await makeUser(t, 'viewer');
    const res = await upgrade(u, 'WRONG');
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('INVALID_HOST_CODE');
    expect((await t.http().post('/api/v1/watch-spaces').set(auth(u)).send({ titleId })).status).toBe(403);
  });

  test('the right code promotes to host and the new token can create a Watch Space', async () => {
    const u = await makeUser(t, 'viewer');
    const res = await upgrade(u, 'TEST-HOST-CODE');
    expect(res.status).toBe(200);
    expect(res.body.user.role).toBe('host');
    expect(jwt.decode(res.body.accessToken).role).toBe('host');
    const created = await t.http().post('/api/v1/watch-spaces').set('Authorization', `Bearer ${res.body.accessToken}`).send({ titleId });
    expect(created.status).toBe(201);
  });

  test('attempts are rate-limited per user', async () => {
    const u = await makeUser(t, 'viewer');
    for (let i = 0; i < 5; i++) expect((await upgrade(u, `bad-${i}`)).status).toBe(403);
    expect((await upgrade(u, 'TEST-HOST-CODE')).status).toBe(429);
  });

  test('does not demote an admin', async () => {
    const res = await upgrade(admin, 'TEST-HOST-CODE');
    expect(res.status).toBe(200);
    expect(res.body.user.role).toBe('admin');
  });
});
