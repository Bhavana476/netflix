// Scripted multi-client load test against a running server (npm start).
//   node scripts/loadtest.js [--clients 10] [--seconds 40] [--base http://localhost:4000]
// Each simulated participant runs a software "player" whose clock is deliberately skewed (+-0.6%) and whose
// snapshot handling is delayed (seek latency/jitter), then follows the real protocol: clock sync via
// room.sync.ping, drift reports every second, and rate/seek corrections from the server. All clients run on
// this machine, so they share one wall clock and drift can be measured exactly.
const fs = require('fs');
const path = require('path');
const { io } = require('socket.io-client');
const { summarize } = require('../src/metrics');

const arg = (name, def) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : def;
};
const BASE = arg('base', 'http://localhost:4000');
const N = Number(arg('clients', 10));
const SECONDS = Number(arg('seconds', 40));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function http(method, url, body, token) {
  const t0 = performance.now();
  const res = await fetch(BASE + url, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const ms = performance.now() - t0;
  const data = res.status === 204 ? null : await res.json();
  if (!res.ok) throw new Error(`${method} ${url} -> ${res.status} ${JSON.stringify(data)}`);
  return { data, ms };
}

async function register(role, i) {
  const email = `loadtest_${role}_${Date.now()}_${i}@example.test`;
  const { data } = await http('POST', '/api/v1/auth/register', { email, password: 'loadtest-password', displayName: `LT ${role} ${i}`, role });
  return { id: data.user.id, token: data.accessToken };
}

class SimPlayer {
  constructor(skew, applyDelayMs) {
    this.pos = 0; this.rate = 1; this.playing = false; this.skew = skew; this.applyDelayMs = applyDelayMs;
    this.last = Date.now();
  }
  advance() {
    const now = Date.now();
    if (this.playing) this.pos += ((now - this.last) / 1000) * this.rate * this.skew;
    this.last = now;
    return this.pos;
  }
}

class Client {
  constructor(user, wsId, isHost) {
    this.user = user; this.wsId = wsId; this.isHost = isHost; this.offset = 0; this.rtt = 0;
    this.player = new SimPlayer(1 + (Math.random() * 2 - 1) * 0.006, 40 + Math.random() * 160);
    this.received = [];
    this.snapshot = null;
  }
  async connect() {
    this.socket = io(`${BASE}/rooms`, { auth: { token: this.user.token }, transports: ['websocket'], forceNew: true });
    this.socket.on('message', (env) => {
      const at = Date.now();
      this.received.push({ event: env.event, ts: env.ts, at, payload: env.payload });
      if (env.event === 'room.playback.update') this.applySnapshot(env.payload);
    });
    await new Promise((res, rej) => { this.socket.on('connect', res); this.socket.on('connect_error', rej); });
    for (let i = 0; i < 5; i++) {
      const t0 = Date.now();
      const r = await this.send('room.sync.ping', { clientSentAt: t0 });
      const rtt = Date.now() - t0;
      if (!this.rtt || rtt < this.rtt) { this.rtt = rtt; this.offset = r.serverReceivedAt - (t0 + rtt / 2); }
    }
    const t0 = Date.now();
    const j = await this.send('room.join');
    this.joinMs = Date.now() - t0;
    if (!j.ok) throw new Error(`join failed for ${this.user.id}: ${JSON.stringify(j.error)}`);
    this.applySnapshot(j.room.playback);
  }
  send(event, payload = {}) {
    return new Promise((resolve) => this.socket.emit('message', { event, watchSpaceId: this.wsId, payload, ts: Date.now() }, resolve));
  }
  serverNow() { return Date.now() + this.offset; }
  applySnapshot(s) {
    this.snapshot = s;
    this.lastSnapAt = Date.now();
    // Simulated player latency: a real <video> takes time to seek/start.
    setTimeout(() => {
      this.player.advance();
      const target = s.positionSeconds + (s.state === 'playing' ? (this.serverNow() - s.serverTime) / 1000 : 0);
      if (Math.abs(this.player.pos - target) > 0.25) this.player.pos = target - this.player.applyDelayMs / 1000 * 0.5;
      this.player.rate = 1;
      this.player.playing = s.state === 'playing';
    }, this.player.applyDelayMs);
  }
  async report() {
    const sentAt = this.serverNow();
    const r = await this.send('room.sync.report', { positionSeconds: this.player.advance(), serverTimeEstimate: sentAt, rttMs: this.rtt });
    if (!r || !r.ok) return;
    const k = r.correction;
    if (k.action === 'rate') {
      this.player.advance(); this.player.rate = k.rate;
      clearTimeout(this.rateTimer);
      this.rateTimer = setTimeout(() => { this.player.advance(); this.player.rate = 1; }, Math.min(k.durationMs, 5000));
    } else if (k.action === 'seek') {
      this.player.advance();
      this.player.pos = k.targetPosition + (this.serverNow() - sentAt) / 1000;
    }
  }
  authoritative() {
    const s = this.snapshot;
    return s.positionSeconds + (s.state === 'playing' ? (Date.now() - s.serverTime) / 1000 : 0);
  }
}

(async () => {
  console.log(`Load test: ${N} participants + host, ${SECONDS}s against ${BASE}`);
  const host = await register('host', 0);
  const viewers = await Promise.all(Array.from({ length: N }, (_, i) => register('viewer', i + 1)));
  const { data: ws } = await http('POST', '/api/v1/watch-spaces', { titleId: 't_1001', maxParticipants: 50, privacy: 'public', aiVerbosity: 'normal' }, host.token);
  const wsId = ws.watchSpaceId;

  const hostClient = new Client(host, wsId, true);
  await hostClient.connect();
  await hostClient.send('room.playback.update', { state: 'play', positionSeconds: 0 });
  const clients = [hostClient];
  for (const v of viewers) { const c = new Client(v, wsId, false); await c.connect(); clients.push(c); }

  // Drift sampling: every 250ms, compare each player to the authoritative clock, and to each other.
  const driftSamples = []; const spreadSamples = []; const joinConvergence = [];
  let excludedTransitionSamples = 0;
  const reportTimers = clients.map((c) => setInterval(() => c.report(), 1000));
  const warmupMs = 4000;
  const started = Date.now();
  const sampler = setInterval(() => {
    if (Date.now() - started < warmupMs) return;
    // Steady-state drift only: skip the brief window in which a host pause/seek is still being applied
    // by the (simulated) players - that transition is measured separately as propagation latency.
    if (clients.some((c) => Date.now() - c.lastSnapAt < 400)) { excludedTransitionSamples++; return; }
    const positions = clients.map((c) => c.player.advance());
    clients.forEach((c, i) => driftSamples.push(Math.abs(positions[i] - c.authoritative()) * 1000));
    spreadSamples.push((Math.max(...positions) - Math.min(...positions)) * 1000);
  }, 250);

  // Mid-playback join: measure time until a late joiner is within 250ms of the authoritative position.
  await sleep(5000);
  for (let i = 0; i < 3; i++) {
    const late = new Client(await register('viewer', `late${i}`), wsId, false);
    const t0 = Date.now();
    await late.connect();
    while (Math.abs(late.player.advance() - late.authoritative()) > 0.25 && Date.now() - t0 < 5000) await sleep(10);
    joinConvergence.push(Date.now() - t0);
    late.socket.disconnect();
    await sleep(500);
  }

  // Playback propagation: host pause/seek/play -> time until every client received it.
  const propagation = [];
  for (const action of [{ state: 'pause' }, { state: 'seek', positionSeconds: 120 }, { state: 'play' }, { state: 'seek', positionSeconds: 200 }]) {
    const t0 = Date.now();
    await hostClient.send('room.playback.update', action);
    await sleep(800);
    const arrivals = clients.map((c) => (c.received.filter((r) => r.event === 'room.playback.update' && r.at >= t0)[0] || {}).at);
    propagation.push(Math.max(...arrivals.map((a) => (a ? a - t0 : 9999))));
    await sleep(1500);
  }

  // Chat fan-out: server send (envelope ts) -> last client receipt.
  const fanout = [];
  for (let i = 0; i < 30; i++) {
    const r = await clients[1 + (i % N)].send('room.chat.message', { body: `load ${i}` });
    await sleep(120);
    const arrivals = clients.map((c) => c.received.find((x) => x.event === 'room.chat.message' && x.payload.messageId === r.messageId)).filter(Boolean);
    if (arrivals.length === clients.length) fanout.push(Math.max(...arrivals.map((a) => a.at - a.ts)));
  }

  // AI co-pilot latency (REST, end-to-end).
  const questions = ['Who is the character that just walked in?', 'What is a burrow?', 'Who is Frank?', 'What happened earlier?', 'What is a flying squirrel?', 'Who made this film?', 'What is the capital of Peru?'];
  const ai = [];
  for (let i = 0; i < 28; i++) {
    const { ms } = await http('POST', `/api/v1/watch-spaces/${wsId}/ai/ask`, { question: questions[i % questions.length], currentTs: 60 + i * 15 }, viewers[0].token);
    ai.push(ms);
  }

  // Non-AI API latency.
  const api = [];
  for (let i = 0; i < 50; i++) {
    for (const url of ['/api/v1/titles', '/api/v1/titles/t_1001/timeline?from=0&to=300', `/api/v1/watch-spaces/${wsId}`, '/api/v1/me/recommendations']) {
      api.push((await http('GET', url, null, viewers[1].token)).ms);
    }
  }

  const remaining = Math.max(0, SECONDS * 1000 - (Date.now() - started));
  await sleep(remaining);
  clearInterval(sampler);
  reportTimers.forEach(clearInterval);
  const joinTimes = clients.map((c) => c.joinMs);
  await hostClient.send('room.end');
  clients.forEach((c) => c.socket.disconnect());

  const result = {
    generatedAt: new Date().toISOString(),
    setup: { base: BASE, participants: N + 1, durationSeconds: SECONDS, machine: `${process.platform} ${process.arch}, node ${process.version}`, note: 'All clients on one machine (loopback); simulated players with +-0.6% clock skew and 40-200ms snapshot-apply latency.' },
    excludedTransitionSamples,
    syncDriftVsAuthoritativeMs: summarize(driftSamples),
    maxSpreadBetweenAnyTwoClientsMs: summarize(spreadSamples),
    midPlaybackJoinToWithin250msMs: summarize(joinConvergence),
    roomJoinAckMs: summarize(joinTimes),
    hostActionPropagationToAllClientsMs: summarize(propagation),
    chatFanoutServerToLastClientMs: summarize(fanout),
    aiAnswerLatencyMs: summarize(ai),
    apiLatencyNonAiMs: summarize(api),
    joinSuccessRate: `${clients.length}/${clients.length}`,
  };
  const out = path.resolve(__dirname, `../../docs/evidence/perf-results-${N + 1}clients.json`);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
  process.exit(0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
