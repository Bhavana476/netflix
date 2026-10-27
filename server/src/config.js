const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../../.env') });

const env = (key, fallback) => {
  const v = process.env[key];
  return v === undefined || v === '' ? fallback : v;
};
const num = (key, fallback) => Number(env(key, fallback));

const config = {
  nodeEnv: env('NODE_ENV', 'development'),
  port: num('PORT', 4000),
  corsOrigin: env('CORS_ORIGIN', 'http://localhost:5173'),

  mongoUri: env('MONGO_URI', ''),
  useMemoryDb: env('USE_MEMORY_DB', 'true') === 'true',
  memoryDbPath: env('MEMORY_DB_PATH', path.resolve(__dirname, '../../.data/db')),
  seedOnBoot: env('SEED_ON_BOOT', 'true') === 'true',

  jwtSecret: env('JWT_SECRET', ''),
  accessTtlSec: num('ACCESS_TOKEN_TTL_SEC', 900),
  refreshTtlSec: num('REFRESH_TOKEN_TTL_SEC', 7 * 24 * 3600),

  anthropicApiKey: env('ANTHROPIC_API_KEY', ''),
  aiModel: env('AI_MODEL', 'claude-haiku-5-5'),
  aiTimeoutMs: num('AI_TIMEOUT_MS', 2500),

  hostGraceMs: num('HOST_GRACE_MS', 10000),
  reconnectGraceMs: num('RECONNECT_GRACE_MS', 8000),
  // Corrections below 100ms use imperceptible playbackRate nudges, so correcting from 50ms keeps P95 under 100ms.
  driftThresholdMs: num('DRIFT_THRESHOLD_MS', 50),
  hardSeekThresholdMs: num('HARD_SEEK_THRESHOLD_MS', 1000),
  chatFlushMs: num('CHAT_FLUSH_MS', 2000),
  chatFlushCount: num('CHAT_FLUSH_COUNT', 20),
  maxRoomParticipants: 50,
};

function assertConfig() {
  if (!config.jwtSecret || config.jwtSecret.length < 32) {
    throw new Error('JWT_SECRET must be set (>= 32 chars) via environment variable. See .env.example.');
  }
}

module.exports = { config, assertConfig };
