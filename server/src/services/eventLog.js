// Batched writer for the session event log: flushes every CHAT_FLUSH_MS or CHAT_FLUSH_COUNT events,
// whichever comes first, instead of one DB write per chat message.
const crypto = require('crypto');
const { SessionEvent } = require('../models');
const { config } = require('../config');
const log = require('../logger');

let buffer = [];
let timer = null;
let flushing = Promise.resolve();

function schedule() {
  if (!timer) {
    timer = setTimeout(() => flush(), config.chatFlushMs);
    timer.unref();
  }
}

function append(evt) {
  const doc = { msgId: evt.msgId || crypto.randomUUID(), createdAt: new Date(), ...evt };
  buffer.push(doc);
  if (buffer.length >= config.chatFlushCount) flush();
  else schedule();
  return doc;
}

function flush() {
  if (timer) clearTimeout(timer);
  timer = null;
  if (!buffer.length) return flushing;
  const batch = buffer;
  buffer = [];
  flushing = flushing
    .then(() => SessionEvent.insertMany(batch, { ordered: false }))
    .catch((e) => log.error('event log flush failed', { error: e.message, count: batch.length }));
  return flushing;
}

module.exports = { append, flush };
