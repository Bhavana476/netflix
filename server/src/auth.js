const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const { config } = require('./config');
const { User, RefreshToken } = require('./models');
const { HttpError, sha256 } = require('./util');

function signAccess(user) {
  return jwt.sign({ sub: String(user._id), role: user.role, name: user.displayName }, config.jwtSecret, {
    algorithm: 'HS256',
    expiresIn: config.accessTtlSec,
  });
}

function verifyAccess(token) {
  return jwt.verify(token, config.jwtSecret, { algorithms: ['HS256'] });
}

// Refresh tokens are opaque random strings; only their hash is stored. Each use rotates the token.
async function issueTokens(user) {
  const raw = crypto.randomBytes(32).toString('hex');
  await RefreshToken.create({
    userId: user._id,
    tokenHash: sha256(raw),
    expiresAt: new Date(Date.now() + config.refreshTtlSec * 1000),
  });
  return { accessToken: signAccess(user), refreshToken: raw, expiresIn: config.accessTtlSec };
}

async function rotateRefresh(raw) {
  if (typeof raw !== 'string' || !raw) throw new HttpError(401, 'INVALID_REFRESH', 'Refresh token required');
  const doc = await RefreshToken.findOneAndUpdate(
    { tokenHash: sha256(raw), revokedAt: null, expiresAt: { $gt: new Date() } },
    { revokedAt: new Date() }
  );
  if (!doc) throw new HttpError(401, 'INVALID_REFRESH', 'Refresh token is invalid or expired');
  const user = await User.findById(doc.userId);
  if (!user) throw new HttpError(401, 'INVALID_REFRESH', 'User no longer exists');
  return { user, tokens: await issueTokens(user) };
}

async function revokeRefresh(raw) {
  if (typeof raw === 'string' && raw) await RefreshToken.updateOne({ tokenHash: sha256(raw) }, { revokedAt: new Date() });
}

function tokenFromHeader(req) {
  const h = req.headers.authorization || '';
  return h.startsWith('Bearer ') ? h.slice(7) : null;
}

function requireAuth(req, res, next) {
  const token = tokenFromHeader(req);
  if (!token) return next(new HttpError(401, 'UNAUTHENTICATED', 'Missing bearer token'));
  try {
    const claims = verifyAccess(token);
    req.user = { id: claims.sub, role: claims.role, name: claims.name };
    next();
  } catch (e) {
    next(new HttpError(401, e.name === 'TokenExpiredError' ? 'TOKEN_EXPIRED' : 'UNAUTHENTICATED', 'Invalid or expired token'));
  }
}

const requireRole = (...roles) => (req, res, next) => {
  if (!req.user) return next(new HttpError(401, 'UNAUTHENTICATED', 'Not authenticated'));
  if (!roles.includes(req.user.role)) {
    return next(new HttpError(403, 'FORBIDDEN', `Requires role: ${roles.join(' or ')}`));
  }
  next();
};

module.exports = { signAccess, verifyAccess, issueTokens, rotateRefresh, revokeRefresh, requireAuth, requireRole };
