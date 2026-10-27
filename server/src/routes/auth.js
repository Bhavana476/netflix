const express = require('express');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { config } = require('../config');
const { User } = require('../models');
const { issueTokens, rotateRefresh, revokeRefresh, requireAuth } = require('../auth');
const { HttpError, sanitizeText, asyncRoute } = require('../util');

const router = express.Router();
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const LOCALE_RE = /^[a-z]{2}(-[A-Z]{2})?$/;

router.post('/register', asyncRoute(async (req, res) => {
  const { email, password, displayName, role } = req.body || {};
  if (typeof email !== 'string' || !EMAIL_RE.test(email) || email.length > 200) throw new HttpError(400, 'BAD_REQUEST', 'A valid email is required');
  if (typeof password !== 'string' || password.length < 8 || password.length > 200) throw new HttpError(400, 'BAD_REQUEST', 'Password must be at least 8 characters');
  const name = sanitizeText(displayName, 40);
  if (!name) throw new HttpError(400, 'BAD_REQUEST', 'displayName is required');
  // Self-registration may choose viewer or host; admin is granted only by an existing admin.
  const chosenRole = role === 'host' ? 'host' : 'viewer';
  if (await User.exists({ email: email.toLowerCase() })) throw new HttpError(409, 'EMAIL_TAKEN', 'An account with that email already exists');
  const user = await User.create({ email, displayName: name, passwordHash: await bcrypt.hash(password, 10), role: chosenRole });
  res.status(201).json({ user: user.toPublic(), ...(await issueTokens(user)) });
}));

router.post('/login', asyncRoute(async (req, res) => {
  const { email, password } = req.body || {};
  const user = typeof email === 'string' ? await User.findOne({ email: email.toLowerCase(), synthetic: { $ne: true } }) : null;
  if (!user || typeof password !== 'string' || !(await bcrypt.compare(password, user.passwordHash))) {
    throw new HttpError(401, 'INVALID_CREDENTIALS', 'Email or password is incorrect');
  }
  res.json({ user: user.toPublic(), ...(await issueTokens(user)) });
}));

router.post('/refresh', asyncRoute(async (req, res) => {
  const { user, tokens } = await rotateRefresh((req.body || {}).refreshToken);
  res.json({ user: user.toPublic(), ...tokens });
}));

router.post('/logout', asyncRoute(async (req, res) => {
  await revokeRefresh((req.body || {}).refreshToken);
  res.status(204).end();
}));

router.get('/me', requireAuth, asyncRoute(async (req, res) => {
  const user = await User.findById(req.user.id);
  if (!user) throw new HttpError(404, 'NOT_FOUND', 'User not found');
  res.json({ user: user.toPublic() });
}));

// Viewer -> host upgrade gated by HOST_ACCESS_CODE. Attempts are limited per user (in memory,
// fine for the single-process deployment) so the code can't be brute-forced.
const HOST_CODE_MAX_ATTEMPTS = 5;
const HOST_CODE_WINDOW_MS = 15 * 60 * 1000;
const hostCodeAttempts = new Map();
const sha = (s) => crypto.createHash('sha256').update(String(s)).digest();

router.post('/host-code', requireAuth, asyncRoute(async (req, res) => {
  if (!config.hostAccessCode) throw new HttpError(503, 'HOST_CODE_DISABLED', 'Host access codes are not enabled on this server');
  const now = Date.now();
  const a = hostCodeAttempts.get(req.user.id);
  const recent = a && now - a.first < HOST_CODE_WINDOW_MS ? a : { first: now, count: 0 };
  if (recent.count >= HOST_CODE_MAX_ATTEMPTS) throw new HttpError(429, 'TOO_MANY_ATTEMPTS', 'Too many wrong codes. Try again in 15 minutes');
  const { code } = req.body || {};
  if (typeof code !== 'string' || !crypto.timingSafeEqual(sha(code.trim()), sha(config.hostAccessCode))) {
    hostCodeAttempts.set(req.user.id, { ...recent, count: recent.count + 1 });
    throw new HttpError(403, 'INVALID_HOST_CODE', 'That host code is not valid');
  }
  hostCodeAttempts.delete(req.user.id);
  const user = await User.findById(req.user.id);
  if (!user) throw new HttpError(404, 'NOT_FOUND', 'User not found');
  if (user.role === 'viewer') {
    user.role = 'host';
    await user.save();
  }
  // Fresh tokens so the new role is in the JWT immediately (REST and socket handshake).
  res.json({ user: user.toPublic(), ...(await issueTokens(user)) });
}));

router.patch('/me/preferences', requireAuth, asyncRoute(async (req, res) => {
  const { subtitleLocale, genreAffinity } = req.body || {};
  const update = {};
  if (subtitleLocale !== undefined) {
    if (typeof subtitleLocale !== 'string' || !LOCALE_RE.test(subtitleLocale)) throw new HttpError(400, 'BAD_REQUEST', 'subtitleLocale must look like "es" or "en-IN"');
    update['preferences.subtitleLocale'] = subtitleLocale;
  }
  if (genreAffinity !== undefined) {
    if (!Array.isArray(genreAffinity) || genreAffinity.length > 10) throw new HttpError(400, 'BAD_REQUEST', 'genreAffinity must be a list (max 10)');
    update['preferences.genreAffinity'] = genreAffinity.map((g) => sanitizeText(g, 40)).filter(Boolean);
  }
  const user = await User.findByIdAndUpdate(req.user.id, update, { new: true });
  res.json({ user: user.toPublic() });
}));

module.exports = router;
