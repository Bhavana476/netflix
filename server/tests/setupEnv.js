// Test-only configuration (never used in dev/prod). Real secrets come from the environment.
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = process.env.TEST_JWT_SECRET || require('crypto').randomBytes(48).toString('hex');
process.env.ANTHROPIC_API_KEY = '';
process.env.SEED_ON_BOOT = 'false';
process.env.HOST_GRACE_MS = '400';
process.env.RECONNECT_GRACE_MS = '400';
process.env.CHAT_FLUSH_MS = '50';
process.env.HOST_ACCESS_CODE = 'TEST-HOST-CODE';
require('../src/mongoBinary').useCachedMongoBinary();
