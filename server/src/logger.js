// Structured JSON-lines logger. Sensitive fields are redacted before writing.
const SENSITIVE = new Set(['password', 'passwordHash', 'token', 'accessToken', 'refreshToken', 'authorization']);
const silent = process.env.NODE_ENV === 'test' && !process.env.LOG_IN_TESTS;

function redact(obj) {
  if (!obj || typeof obj !== 'object') return obj;
  const out = Array.isArray(obj) ? [] : {};
  for (const [k, v] of Object.entries(obj)) out[k] = SENSITIVE.has(k) ? '[redacted]' : redact(v);
  return out;
}

function write(level, msg, fields = {}) {
  if (silent) return;
  const line = JSON.stringify({ t: new Date().toISOString(), level, msg, ...redact(fields) });
  (level === 'error' ? process.stderr : process.stdout).write(line + '\n');
}

module.exports = {
  info: (msg, f) => write('info', msg, f),
  warn: (msg, f) => write('warn', msg, f),
  error: (msg, f) => write('error', msg, f),
  // Room-scoped child logger: every line carries the session correlation id.
  room: (watchSpaceId, sessionId) => ({
    info: (msg, f) => write('info', msg, { correlationId: sessionId, watchSpaceId, ...f }),
    warn: (msg, f) => write('warn', msg, { correlationId: sessionId, watchSpaceId, ...f }),
  }),
};
