// Socket.io client for one Watch Space. Wraps the { event, watchSpaceId, payload, ts } envelope,
// measures the server clock offset (room.sync.ping/pong) and re-joins automatically after reconnects.
import { io } from 'socket.io-client';
import { getToken, refreshSession } from './api';

export class RoomConnection {
  constructor(watchSpaceId) {
    this.id = watchSpaceId;
    this.offset = 0;
    this.rtt = 0;
    this.listeners = new Map();
    this.socket = io('/rooms', {
      auth: (cb) => cb({ token: getToken() }),
      transports: ['websocket'],
      reconnectionDelay: 500,
      reconnectionDelayMax: 3000,
    });
    this.socket.on('message', (env) => {
      this.emit(env.event, env.payload, env);
      this.emit('*', env.payload, env);
    });
    this.socket.on('connect', () => this.join());
    this.socket.on('disconnect', (reason) => this.emit('connection', { connected: false, reason }));
    this.socket.on('connect_error', async (err) => {
      this.emit('connection', { connected: false, reason: err.message });
      if (err.message === 'UNAUTHENTICATED' && (await refreshSession())) this.socket.connect();
    });
    // Keep the socket's server-side token fresh for host-sensitive actions.
    this.reauthTimer = setInterval(async () => {
      if (await refreshSession()) this.send('session.reauth', { accessToken: getToken() });
    }, 10 * 60 * 1000);
    this.clockTimer = setInterval(() => this.measureClock(3), 30000);
  }

  async join() {
    if (this.closed) return;
    await this.measureClock(5);
    if (this.closed) return;
    const res = await this.send('room.join');
    this.emit('connection', { connected: true });
    this.emit('joined', res);
  }

  send(event, payload = {}) {
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve({ ok: false, error: { code: 'TIMEOUT', message: 'No response from server' } }), 8000);
      this.socket.emit('message', { event, watchSpaceId: this.id, payload, ts: Date.now() }, (res) => {
        clearTimeout(timer);
        resolve(res);
      });
    });
  }

  /** NTP-style offset estimate; keeps the lowest-RTT sample. */
  async measureClock(samples = 5) {
    let best = null;
    for (let i = 0; i < samples; i++) {
      const t0 = Date.now();
      const r = await this.send('room.sync.ping', { clientSentAt: t0 });
      const t1 = Date.now();
      if (!r || !r.serverReceivedAt) continue;
      const rtt = t1 - t0;
      if (!best || rtt < best.rtt) best = { rtt, offset: r.serverReceivedAt - (t0 + rtt / 2) };
    }
    if (best) {
      this.rtt = best.rtt;
      this.offset = best.offset;
    }
  }

  serverNow() {
    return Date.now() + this.offset;
  }

  on(event, fn) {
    if (!this.listeners.has(event)) this.listeners.set(event, new Set());
    this.listeners.get(event).add(fn);
    return () => this.listeners.get(event).delete(fn);
  }

  emit(event, payload, env) {
    const set = this.listeners.get(event);
    if (set) set.forEach((fn) => fn(payload, env));
  }

  close() {
    this.closed = true;
    clearInterval(this.reauthTimer);
    clearInterval(this.clockTimer);
    // An explicit leave (no reconnect grace) only makes sense for a socket that actually joined.
    if (this.socket.connected) this.send('room.leave').finally(() => this.socket.disconnect());
    else this.socket.disconnect();
  }
}
