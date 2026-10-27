const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');
const { MongoMemoryServer } = require('mongodb-memory-server');
const { io: ioClient } = require('socket.io-client');
const request = require('supertest');
const { start } = require('../src/index');
const { User } = require('../src/models');
const engine = require('../src/ai/engine');

async function startTestServer() {
  const mongo = await MongoMemoryServer.create();
  const srv = await start({ port: 0, mongoUri: mongo.getUri('test') });
  const base = `http://127.0.0.1:${srv.port}`;
  return {
    ...srv,
    base,
    http: () => request(base),
    async stopAll() {
      await srv.stop();
      await mongo.stop();
    },
  };
}

async function loadFixtureTitle(file = 'big-buck-bunny.yaml') {
  const text = fs.readFileSync(path.resolve(__dirname, '../data/timelines', file), 'utf8');
  const r = await engine.ingestTimeline(text);
  if (!r.valid) throw new Error(JSON.stringify(r.errors));
  return r.titleId;
}

let n = 0;
async function makeUser(t, role = 'viewer', name) {
  const email = `${role}${++n}_${Date.now()}@test.local`;
  const password = 'password-123';
  if (role === 'admin') {
    await User.create({ email, displayName: name || `Admin ${n}`, role: 'admin', passwordHash: await bcrypt.hash(password, 4) });
    const res = await t.http().post('/api/v1/auth/login').send({ email, password });
    return { ...res.body.user, token: res.body.accessToken, refreshToken: res.body.refreshToken };
  }
  const res = await t.http().post('/api/v1/auth/register').send({ email, password, displayName: name || `${role} ${n}`, role });
  if (res.status !== 201) throw new Error(`register failed ${res.status} ${JSON.stringify(res.body)}`);
  return { ...res.body.user, token: res.body.accessToken, refreshToken: res.body.refreshToken };
}

/** Socket client with promise helpers around the { event, watchSpaceId, payload } envelope. */
function connect(t, token) {
  const socket = ioClient(`${t.base}/rooms`, { auth: { token }, transports: ['websocket'], forceNew: true, reconnection: false });
  const received = [];
  const waiters = [];
  socket.on('message', (env) => {
    env.receivedAt = Date.now();
    received.push(env);
    for (const w of [...waiters]) if (w.match(env)) { waiters.splice(waiters.indexOf(w), 1); w.resolve(env); }
  });
  const api = {
    socket,
    received,
    ready: new Promise((resolve, reject) => { socket.on('connect', resolve); socket.on('connect_error', reject); }),
    send(event, watchSpaceId, payload = {}) {
      return new Promise((resolve) => socket.emit('message', { event, watchSpaceId, payload, ts: Date.now() }, resolve));
    },
    waitFor(event, pred = () => true, timeoutMs = 3000) {
      const found = received.find((e) => e.event === event && pred(e.payload));
      if (found) return Promise.resolve(found);
      return new Promise((resolve, reject) => {
        const w = { match: (e) => e.event === event && pred(e.payload), resolve };
        waiters.push(w);
        setTimeout(() => { if (waiters.includes(w)) { waiters.splice(waiters.indexOf(w), 1); reject(new Error(`timeout waiting for ${event}`)); } }, timeoutMs);
      });
    },
    clear() { received.length = 0; },
    close() { socket.disconnect(); },
  };
  return api;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

module.exports = { startTestServer, loadFixtureTitle, makeUser, connect, sleep };
