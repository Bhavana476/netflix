const crypto = require('crypto');

class HttpError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

// Plain-text sanitizer for user input stored and re-broadcast (chat, questions, names).
// Strips tags/angle brackets and control chars; the client additionally renders as text, never HTML.
function sanitizeText(value, maxLen = 500) {
  if (typeof value !== 'string') return '';
  return value
    .replace(/<[^>]*>/g, '')
    .replace(/[<>]/g, '')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .trim()
    .slice(0, maxLen);
}

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function inviteCode() {
  const bytes = crypto.randomBytes(4);
  return 'NX-' + Array.from(bytes, (b) => ALPHABET[b % ALPHABET.length]).join('');
}
const id = (prefix) => `${prefix}_${crypto.randomBytes(5).toString('hex')}`;
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

function fmtTs(sec) {
  const s = Math.max(0, Math.floor(sec));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
  return [h, m, r].map((n) => String(n).padStart(2, '0')).join(':');
}

const asyncRoute = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

module.exports = { HttpError, sanitizeText, inviteCode, id, sha256, fmtTs, asyncRoute };
