const http = require('http');
const { Server } = require('socket.io');
const { config, assertConfig } = require('./config');
const db = require('./db');
const { createApp } = require('./app');
const gateway = require('./realtime/gateway');
const eventLog = require('./services/eventLog');
const { Title } = require('./models');
const log = require('./logger');

async function start({ port = config.port, mongoUri } = {}) {
  assertConfig();
  await db.connect(mongoUri);
  if (config.seedOnBoot && !(await Title.estimatedDocumentCount())) {
    log.info('empty database: seeding sample data');
    await require('../scripts/seedData').seedAll();
  }
  const app = createApp();
  const server = http.createServer(app);
  const io = new Server(server, { cors: { origin: config.corsOrigin.split(',') }, pingInterval: 10000, pingTimeout: 8000 });
  gateway.init(io);
  await new Promise((resolve) => server.listen(port, resolve));
  log.info('server listening', { port: server.address().port });

  const stop = async () => {
    gateway.shutdown();
    await eventLog.flush();
    io.close();
    await new Promise((r) => server.close(() => r()));
    await db.disconnect();
  };
  return { server, io, stop, port: server.address().port };
}

if (require.main === module) {
  start().then(({ stop }) => {
    const bye = async () => {
      log.info('shutting down');
      await stop().catch(() => {});
      process.exit(0);
    };
    process.on('SIGINT', bye);
    process.on('SIGTERM', bye);
  }).catch((e) => {
    log.error('failed to start', { error: e.message });
    process.exit(1);
  });
}

module.exports = { start };
