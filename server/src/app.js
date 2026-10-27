const path = require('path');
const fs = require('fs');
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const mongoose = require('mongoose');
const { config } = require('./config');
const metrics = require('./metrics');
const gateway = require('./realtime/gateway');
const log = require('./logger');
const { HttpError } = require('./util');

function createApp() {
  const app = express();
  app.disable('x-powered-by');
  app.use(helmet({ contentSecurityPolicy: false, crossOriginEmbedderPolicy: false }));
  app.use(cors({ origin: config.corsOrigin.split(','), credentials: false }));
  app.use(express.json({ limit: '2mb' }));
  app.use(metrics.httpLatency);

  // Health checks for an orchestrator / uptime probe.
  app.get('/health', (req, res) => {
    const dbUp = mongoose.connection.readyState === 1;
    res.status(dbUp ? 200 : 503).json({ status: dbUp ? 'ok' : 'degraded', db: dbUp ? 'up' : 'down', uptimeSec: Math.round(process.uptime()) });
  });
  app.get('/health/realtime', (req, res) => res.json({ status: 'ok', ...gateway.getStats() }));

  app.use('/api/v1/auth', require('./routes/auth'));
  app.use('/api/v1/titles', require('./routes/titles'));
  app.use('/api/v1/watch-spaces', require('./routes/watchSpaces'));
  app.use('/api/v1/me', require('./routes/me'));
  app.use('/api/v1/admin', require('./routes/admin'));

  // Local media (optional): drop .mp4 files in server/media and reference them as /media/<file>.
  app.use('/media', express.static(path.resolve(__dirname, '../media'), { maxAge: '1h' }));

  // Serve the built React client in production mode.
  const dist = path.resolve(__dirname, '../../client/dist');
  if (fs.existsSync(dist)) {
    app.use(express.static(dist));
    app.get(/^\/(?!api|health|media|socket\.io).*/, (req, res) => res.sendFile(path.join(dist, 'index.html')));
  }

  app.use('/api', (req, res, next) => next(new HttpError(404, 'NOT_FOUND', 'Route not found')));
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (err.type === 'entity.parse.failed') err = new HttpError(400, 'BAD_JSON', 'Malformed JSON body');
    if (!(err instanceof HttpError)) {
      log.error('unhandled error', { path: req.path, error: err.message, stack: err.stack });
      err = new HttpError(500, 'INTERNAL', 'Internal server error');
    }
    res.status(err.status).json({ error: { code: err.code, message: err.message, details: err.details } });
  });
  return app;
}

module.exports = { createApp };
