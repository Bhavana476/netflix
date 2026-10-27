const fs = require('fs');
const mongoose = require('mongoose');
const { config } = require('./config');
const log = require('./logger');

let memServer = null;

// Connects to MONGO_URI, or boots an embedded mongod (persisted to .data/db) when no URI is configured.
async function connect(uri) {
  let target = uri || config.mongoUri;
  if (!target) {
    if (!config.useMemoryDb) throw new Error('MONGO_URI is not set and USE_MEMORY_DB=false');
    require('./mongoBinary').useCachedMongoBinary();
    const { MongoMemoryServer } = require('mongodb-memory-server');
    fs.mkdirSync(config.memoryDbPath, { recursive: true });
    memServer = await MongoMemoryServer.create({
      instance: { dbPath: config.memoryDbPath, storageEngine: 'wiredTiger' },
    });
    target = memServer.getUri('watch_spaces');
    log.info('embedded mongodb started', { dbPath: config.memoryDbPath });
  }
  // One pooled connection shared by Express and Socket.io.
  await mongoose.connect(target, { maxPoolSize: 20 });
  log.info('mongodb connected');
}

async function disconnect() {
  await mongoose.disconnect();
  if (memServer) await memServer.stop();
  memServer = null;
}

module.exports = { connect, disconnect };
