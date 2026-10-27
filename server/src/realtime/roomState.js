// Authoritative, in-memory state for one Watch Space. Pure logic (injectable clock), no sockets or DB,
// so the playback state machine, drift correction, host failover and voting are unit-testable.

class RoomError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

const PLAYBACK_ACTIONS = ['play', 'pause', 'seek', 'buffering'];

class RoomState {
  constructor({ id, titleId, hostUserId, durationSeconds = Infinity, settings = {}, locked = false, startPosition = 0, now = Date.now, tuning = {} }) {
    this.id = id;
    this.titleId = titleId;
    this.hostUserId = String(hostUserId);
    this.durationSeconds = durationSeconds;
    this.settings = { maxParticipants: 25, aiVerbosity: 'normal', votingEnabled: true, triviaEnabled: true, ...settings };
    this.locked = locked;
    this.now = now;
    this.tuning = { driftThresholdMs: 100, hardSeekThresholdMs: 1000, ...tuning };
    // 'playing' | 'paused' | 'buffering'. Position is extrapolated from (position, updatedAt) while playing.
    this.playback = { state: 'paused', position: startPosition, rate: 1, updatedAt: now(), seq: 0, issuedBy: null, lastAction: 'init' };
    this.participants = new Map(); // userId -> { userId, displayName, joinedAt, sockets:Set, connected, muted }
    this.removed = new Set();
    this.hostDisconnectedAt = null;
    this.firedTrivia = new Set();
    this.triviaCursor = startPosition;
    this.vote = null;
    this.appliedVariations = {};
    this.stats = { peakParticipants: 0, aiQuestions: 0, trivia: 0, chat: 0, reactions: 0 };
    this.maxPosition = startPosition;
  }

  // ---------- playback ----------
  positionAt(t = this.now()) {
    const p = this.playback;
    const pos = p.state === 'playing' ? p.position + ((t - p.updatedAt) / 1000) * p.rate : p.position;
    return Math.min(Math.max(0, pos), this.durationSeconds);
  }

  snapshot(t = this.now()) {
    const p = this.playback;
    return { state: p.state, positionSeconds: this.positionAt(t), serverTime: t, rate: p.rate, seq: p.seq, issuedBy: p.issuedBy, lastAction: p.lastAction };
  }

  isHost(userId) {
    return String(userId) === this.hostUserId;
  }

  /** Host-only transition. 'seek' keeps the current play/pause state; 'buffering' halts the clock for everyone. */
  applyPlayback(userId, { state, positionSeconds }) {
    if (!this.isHost(userId)) throw new RoomError('NOT_HOST', 'Only the current host controls playback');
    if (!PLAYBACK_ACTIONS.includes(state)) throw new RoomError('BAD_REQUEST', `state must be one of ${PLAYBACK_ACTIONS.join(', ')}`);
    if (positionSeconds !== undefined && (typeof positionSeconds !== 'number' || !Number.isFinite(positionSeconds) || positionSeconds < 0)) {
      throw new RoomError('BAD_REQUEST', 'positionSeconds must be a non-negative number');
    }
    if (this.hostDisconnectedAt) this.hostDisconnectedAt = null;
    const t = this.now();
    const current = this.positionAt(t);
    const pos = Math.min(positionSeconds ?? current, this.durationSeconds);
    const prev = this.playback.state;
    const next = state === 'play' ? 'playing' : state === 'pause' ? 'paused' : state === 'buffering' ? 'buffering' : prev === 'buffering' ? 'paused' : prev;
    this.playback = { state: next, position: pos, rate: 1, updatedAt: t, seq: this.playback.seq + 1, issuedBy: String(userId), lastAction: state };
    if (state === 'seek' || Math.abs(pos - current) > 1) this.triviaCursor = pos; // markers jumped over are not replayed
    this.maxPosition = Math.max(this.maxPosition, pos);
    return this.snapshot(t);
  }

  /**
   * Drift correction for a participant report. reportedAt is the report time on the server clock
   * (client converts using its measured clock offset). Small drift -> temporary playbackRate nudge; large -> seek.
   */
  computeCorrection(reportedPosition, reportedAt = this.now()) {
    const expected = this.positionAt(reportedAt);
    const driftSec = reportedPosition - expected;
    const driftMs = Math.round(driftSec * 1000);
    const abs = Math.abs(driftMs);
    if (this.playback.state !== 'playing') {
      return abs > 250 ? { action: 'seek', driftMs, targetPosition: expected } : { action: 'none', driftMs };
    }
    if (abs <= this.tuning.driftThresholdMs) return { action: 'none', driftMs };
    if (abs < this.tuning.hardSeekThresholdMs) {
      // Close the gap over ~2s: rate = 1 - drift/2, clamped to +-8% so it is not noticeable.
      const rate = Math.round(Math.min(1.08, Math.max(0.92, 1 - driftSec / 2)) * 1000) / 1000;
      return { action: 'rate', driftMs, rate, durationMs: Math.round((Math.abs(driftSec) / Math.abs(1 - rate)) * 1000), targetPosition: expected };
    }
    // Seek slightly ahead to absorb the time the seek itself takes on the client.
    return { action: 'seek', driftMs, targetPosition: expected + 0.15 };
  }

  // ---------- presence ----------
  connectedCount() {
    let n = 0;
    for (const p of this.participants.values()) if (p.connected) n++;
    return n;
  }

  /** Adds a socket for a user. Returns { isNew } - a reconnect within the grace window is not a new join. */
  addParticipant({ userId, displayName }, socketId) {
    userId = String(userId);
    if (this.removed.has(userId)) throw new RoomError('REMOVED', 'You were removed from this Watch Space');
    const existing = this.participants.get(userId);
    if (existing) {
      existing.sockets.add(socketId);
      const wasConnected = existing.connected;
      existing.connected = true;
      return { isNew: false, resumed: !wasConnected, participant: existing };
    }
    if (this.locked && !this.isHost(userId)) throw new RoomError('LOCKED', 'This Watch Space is locked by the host');
    if (this.participants.size >= this.settings.maxParticipants) throw new RoomError('ROOM_FULL', 'This Watch Space is full');
    const participant = { userId, displayName, joinedAt: this.now(), sockets: new Set([socketId]), connected: true, muted: false };
    this.participants.set(userId, participant);
    this.stats.peakParticipants = Math.max(this.stats.peakParticipants, this.connectedCount());
    return { isNew: true, resumed: false, participant };
  }

  /** Removes one socket. Returns true when the user has no sockets left (now 'disconnected', pending grace). */
  removeSocket(userId, socketId) {
    const p = this.participants.get(String(userId));
    if (!p) return false;
    p.sockets.delete(socketId);
    if (p.sockets.size === 0) {
      p.connected = false;
      return true;
    }
    return false;
  }

  markLeft(userId) {
    return this.participants.delete(String(userId));
  }

  participantList() {
    return [...this.participants.values()].map((p) => ({
      userId: p.userId,
      displayName: p.displayName,
      isHost: this.isHost(p.userId),
      connected: p.connected,
      muted: p.muted,
      joinedAt: p.joinedAt,
      quality: p.quality || 'unknown',
      rttMs: p.rttMs ?? null,
    }));
  }

  // ---------- host failover (deterministic) ----------
  /** Host lost all sockets: playback pauses for everyone at the current position. */
  onHostDisconnected() {
    const t = this.now();
    const pos = this.positionAt(t);
    this.hostDisconnectedAt = t;
    this.playback = { ...this.playback, state: 'paused', position: pos, updatedAt: t, seq: this.playback.seq + 1, issuedBy: 'system', lastAction: 'host_disconnected' };
    return this.snapshot(t);
  }

  /** After the grace period: promote the longest-present connected participant (ties broken by userId). */
  promoteHost() {
    const candidates = [...this.participants.values()]
      .filter((p) => p.connected && !this.isHost(p.userId))
      .sort((a, b) => a.joinedAt - b.joinedAt || (a.userId < b.userId ? -1 : 1));
    if (!candidates.length) return null;
    this.hostUserId = candidates[0].userId;
    this.hostDisconnectedAt = null;
    return candidates[0].userId;
  }

  transferHost(byUserId, toUserId) {
    if (!this.isHost(byUserId)) throw new RoomError('NOT_HOST', 'Only the host can transfer host');
    const target = this.participants.get(String(toUserId));
    if (!target || !target.connected) throw new RoomError('BAD_REQUEST', 'Target must be a connected participant');
    this.hostUserId = String(toUserId);
    return this.hostUserId;
  }

  // ---------- moderation ----------
  requireHost(userId) {
    if (!this.isHost(userId)) throw new RoomError('NOT_HOST', 'Only the host can do that');
  }

  setMuted(byUserId, userId, muted) {
    this.requireHost(byUserId);
    const p = this.participants.get(String(userId));
    if (!p) throw new RoomError('NOT_FOUND', 'Participant not found');
    if (this.isHost(userId)) throw new RoomError('BAD_REQUEST', 'Host cannot mute themselves');
    p.muted = !!muted;
  }

  removeParticipant(byUserId, userId) {
    this.requireHost(byUserId);
    if (this.isHost(userId)) throw new RoomError('BAD_REQUEST', 'Host cannot remove themselves');
    const p = this.participants.get(String(userId));
    this.removed.add(String(userId));
    this.participants.delete(String(userId));
    return p;
  }

  setLocked(byUserId, locked) {
    this.requireHost(byUserId);
    this.locked = !!locked;
  }

  // ---------- trivia ----------
  /** Timeline entries crossed since the last check (only while playing). Each fires at most once per session. */
  dueTrivia(track, t = this.now()) {
    if (this.playback.state !== 'playing') return [];
    const pos = this.positionAt(t);
    if (pos < this.triviaCursor) {
      this.triviaCursor = pos;
      return [];
    }
    const due = track.filter((e) => e.ts > this.triviaCursor - 1e-9 && e.ts <= pos && !this.firedTrivia.has(e.id));
    this.triviaCursor = pos;
    this.maxPosition = Math.max(this.maxPosition, pos);
    for (const e of due) this.firedTrivia.add(e.id);
    return due;
  }

  // ---------- narrative-variation voting ----------
  openVote(byUserId, variation, durationSec = 20) {
    this.requireHost(byUserId);
    if (!this.settings.votingEnabled) throw new RoomError('VOTING_DISABLED', 'Group voting is disabled for this room');
    if (!variation) throw new RoomError('NOT_FOUND', 'Unknown variation');
    if (this.vote) throw new RoomError('VOTE_ACTIVE', 'A vote is already open');
    if (this.appliedVariations[variation.id]) throw new RoomError('ALREADY_APPLIED', 'That variation has already been decided');
    const d = Math.min(120, Math.max(5, Number(durationSec) || 20));
    this.vote = { variationId: variation.id, variation, votes: new Map(), openedAt: this.now(), closesAt: this.now() + d * 1000 };
    return { variationId: variation.id, prompt: variation.prompt, kind: variation.kind, options: variation.options.map(({ id, label }) => ({ id, label })), closesAt: this.vote.closesAt, applyAtTs: variation.ts };
  }

  castVote(userId, variationId, optionId) {
    const v = this.vote;
    if (!v || v.variationId !== variationId) throw new RoomError('NO_VOTE', 'No open vote for that variation');
    if (!this.participants.has(String(userId))) throw new RoomError('NOT_PARTICIPANT', 'Join the room to vote');
    if (!v.variation.options.some((o) => o.id === optionId)) throw new RoomError('BAD_REQUEST', 'Unknown option');
    v.votes.set(String(userId), optionId);
    return this.tally();
  }

  tally() {
    const counts = {};
    for (const o of this.vote.variation.options) counts[o.id] = 0;
    for (const opt of this.vote.votes.values()) counts[opt]++;
    return { variationId: this.vote.variationId, counts, totalVotes: this.vote.votes.size };
  }

  /** Winner = most votes; ties (incl. zero votes) resolve to the authored default, then authored option order. */
  closeVote() {
    const v = this.vote;
    if (!v) return null;
    const { counts, totalVotes } = this.tally();
    const max = Math.max(...Object.values(counts));
    const tied = v.variation.options.filter((o) => counts[o.id] === max).map((o) => o.id);
    const winningOptionId = tied.includes(v.variation.defaultOptionId) ? v.variation.defaultOptionId : tied[0];
    this.appliedVariations[v.variationId] = winningOptionId;
    this.vote = null;
    return { variationId: v.variationId, winningOptionId, counts, totalVotes, applyAtTs: v.variation.ts, via: 'vote' };
  }

  /** Host directly approves a pre-authored option (e.g. a localized asset suggested by the co-pilot). */
  applyVariation(byUserId, variation, optionId) {
    this.requireHost(byUserId);
    if (!variation || !variation.options.some((o) => o.id === optionId)) throw new RoomError('BAD_REQUEST', 'Unknown variation option');
    if (this.vote && this.vote.variationId === variation.id) this.vote = null;
    this.appliedVariations[variation.id] = optionId;
    return { variationId: variation.id, winningOptionId: optionId, applyAtTs: variation.ts, via: 'host' };
  }
}

module.exports = { RoomState, RoomError };
