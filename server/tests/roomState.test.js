const { RoomState } = require('../src/realtime/roomState');

function clock(start = 1_000_000) {
  let t = start;
  const now = () => t;
  now.advance = (ms) => { t += ms; };
  return now;
}

function room(opts = {}) {
  const now = clock();
  const r = new RoomState({ id: 'ws_1', titleId: 't_1', hostUserId: 'host', durationSeconds: 600, now, ...opts });
  r.addParticipant({ userId: 'host', displayName: 'H' }, 's-host');
  return { r, now };
}

const variation = {
  id: 'v_1', kind: 'subtitle', prompt: 'Pick', ts: 100, defaultOptionId: 'a',
  options: [{ id: 'a', label: 'A', text: 'a' }, { id: 'b', label: 'B', text: 'b' }, { id: 'c', label: 'C', text: 'c' }],
};

describe('playback state machine', () => {
  test('starts paused at 0 and position does not advance while paused', () => {
    const { r, now } = room();
    now.advance(5000);
    expect(r.snapshot()).toMatchObject({ state: 'paused', positionSeconds: 0 });
  });

  test('play advances the authoritative clock; pause freezes it', () => {
    const { r, now } = room();
    r.applyPlayback('host', { state: 'play', positionSeconds: 10 });
    now.advance(2500);
    expect(r.positionAt()).toBeCloseTo(12.5, 5);
    r.applyPlayback('host', { state: 'pause' });
    now.advance(4000);
    expect(r.snapshot()).toMatchObject({ state: 'paused' });
    expect(r.positionAt()).toBeCloseTo(12.5, 5);
  });

  test('seek keeps play/pause state and moves the position', () => {
    const { r, now } = room();
    r.applyPlayback('host', { state: 'play', positionSeconds: 0 });
    r.applyPlayback('host', { state: 'seek', positionSeconds: 300 });
    expect(r.playback.state).toBe('playing');
    now.advance(1000);
    expect(r.positionAt()).toBeCloseTo(301, 5);
    r.applyPlayback('host', { state: 'pause' });
    r.applyPlayback('host', { state: 'seek', positionSeconds: 50 });
    expect(r.playback.state).toBe('paused');
  });

  test('buffering halts the clock; seek out of buffering lands paused', () => {
    const { r, now } = room();
    r.applyPlayback('host', { state: 'play', positionSeconds: 20 });
    now.advance(1000);
    r.applyPlayback('host', { state: 'buffering' });
    now.advance(3000);
    expect(r.positionAt()).toBeCloseTo(21, 5);
    r.applyPlayback('host', { state: 'seek', positionSeconds: 40 });
    expect(r.playback.state).toBe('paused');
  });

  test('position is clamped to the title duration', () => {
    const { r, now } = room();
    r.applyPlayback('host', { state: 'play', positionSeconds: 599 });
    now.advance(10_000);
    expect(r.positionAt()).toBe(600);
  });

  test('sequence number increases on every transition', () => {
    const { r } = room();
    const a = r.applyPlayback('host', { state: 'play' }).seq;
    const b = r.applyPlayback('host', { state: 'pause' }).seq;
    expect(b).toBe(a + 1);
  });

  test('non-host playback updates are rejected (NOT_HOST)', () => {
    const { r } = room();
    r.addParticipant({ userId: 'p1', displayName: 'P' }, 's1');
    expect(() => r.applyPlayback('p1', { state: 'play' })).toThrow(expect.objectContaining({ code: 'NOT_HOST' }));
  });

  test('invalid states and positions are rejected', () => {
    const { r } = room();
    expect(() => r.applyPlayback('host', { state: 'rewind' })).toThrow(expect.objectContaining({ code: 'BAD_REQUEST' }));
    expect(() => r.applyPlayback('host', { state: 'seek', positionSeconds: -3 })).toThrow(expect.objectContaining({ code: 'BAD_REQUEST' }));
    expect(() => r.applyPlayback('host', { state: 'seek', positionSeconds: NaN })).toThrow(expect.objectContaining({ code: 'BAD_REQUEST' }));
  });
});

describe('drift correction', () => {
  test('no correction inside the 100ms window', () => {
    const { r } = room();
    r.applyPlayback('host', { state: 'play', positionSeconds: 10 });
    expect(r.computeCorrection(10.08).action).toBe('none');
  });

  test('moderate drift is corrected with a gentle playbackRate nudge, not a seek', () => {
    const { r } = room();
    r.applyPlayback('host', { state: 'play', positionSeconds: 10 });
    const ahead = r.computeCorrection(10.4);
    expect(ahead).toMatchObject({ action: 'rate', driftMs: 400 });
    expect(ahead.rate).toBeLessThan(1);
    expect(ahead.rate).toBeGreaterThanOrEqual(0.92);
    const behind = r.computeCorrection(9.7);
    expect(behind.action).toBe('rate');
    expect(behind.rate).toBeGreaterThan(1);
    expect(behind.rate).toBeLessThanOrEqual(1.08);
  });

  test('large drift triggers a seek to the authoritative position', () => {
    const { r, now } = room();
    r.applyPlayback('host', { state: 'play', positionSeconds: 10 });
    now.advance(1000);
    const c = r.computeCorrection(5);
    expect(c.action).toBe('seek');
    expect(c.targetPosition).toBeCloseTo(11.15, 5);
  });

  test('uses the report timestamp (server clock) rather than arrival time', () => {
    const { r, now } = room();
    r.applyPlayback('host', { state: 'play', positionSeconds: 0 });
    const reportedAt = now();
    now.advance(800); // message took 800ms to arrive
    expect(r.computeCorrection(0, reportedAt).action).toBe('none');
  });

  test('while paused, only a meaningful offset triggers a seek', () => {
    const { r } = room();
    r.applyPlayback('host', { state: 'pause', positionSeconds: 30 });
    expect(r.computeCorrection(30.2).action).toBe('none');
    expect(r.computeCorrection(32).action).toBe('seek');
  });
});

describe('presence, capacity and moderation', () => {
  test('a reconnect for an existing participant is not a new join', () => {
    const { r } = room();
    expect(r.addParticipant({ userId: 'p1', displayName: 'P' }, 's1').isNew).toBe(true);
    expect(r.removeSocket('p1', 's1')).toBe(true);
    const again = r.addParticipant({ userId: 'p1', displayName: 'P' }, 's2');
    expect(again).toMatchObject({ isNew: false, resumed: true });
  });

  test('second tab of the same user does not mark them disconnected when one closes', () => {
    const { r } = room();
    r.addParticipant({ userId: 'p1', displayName: 'P' }, 's1');
    r.addParticipant({ userId: 'p1', displayName: 'P' }, 's2');
    expect(r.removeSocket('p1', 's1')).toBe(false);
    expect(r.participants.get('p1').connected).toBe(true);
  });

  test('capacity, lock and removal are enforced', () => {
    const { r } = room({ settings: { maxParticipants: 2 } });
    r.addParticipant({ userId: 'p1', displayName: 'P1' }, 's1');
    expect(() => r.addParticipant({ userId: 'p2', displayName: 'P2' }, 's2')).toThrow(expect.objectContaining({ code: 'ROOM_FULL' }));
    r.removeParticipant('host', 'p1');
    expect(() => r.addParticipant({ userId: 'p1', displayName: 'P1' }, 's3')).toThrow(expect.objectContaining({ code: 'REMOVED' }));
    r.setLocked('host', true);
    expect(() => r.addParticipant({ userId: 'p3', displayName: 'P3' }, 's4')).toThrow(expect.objectContaining({ code: 'LOCKED' }));
  });

  test('only the host can moderate', () => {
    const { r } = room();
    r.addParticipant({ userId: 'p1', displayName: 'P1' }, 's1');
    r.addParticipant({ userId: 'p2', displayName: 'P2' }, 's2');
    expect(() => r.setMuted('p1', 'p2', true)).toThrow(expect.objectContaining({ code: 'NOT_HOST' }));
    expect(() => r.removeParticipant('p1', 'p2')).toThrow(expect.objectContaining({ code: 'NOT_HOST' }));
    expect(() => r.transferHost('p1', 'p2')).toThrow(expect.objectContaining({ code: 'NOT_HOST' }));
    r.setMuted('host', 'p2', true);
    expect(r.participants.get('p2').muted).toBe(true);
  });

  test('peak participants tracks the maximum concurrently connected', () => {
    const { r } = room();
    r.addParticipant({ userId: 'p1', displayName: 'P1' }, 's1');
    r.addParticipant({ userId: 'p2', displayName: 'P2' }, 's2');
    r.removeSocket('p2', 's2');
    r.markLeft('p2');
    expect(r.stats.peakParticipants).toBe(3);
  });
});

describe('host disconnect policy (deterministic)', () => {
  test('host disconnect pauses playback at the current position for everyone', () => {
    const { r, now } = room();
    r.applyPlayback('host', { state: 'play', positionSeconds: 10 });
    now.advance(3000);
    const snap = r.onHostDisconnected();
    expect(snap).toMatchObject({ state: 'paused', issuedBy: 'system', lastAction: 'host_disconnected' });
    expect(snap.positionSeconds).toBeCloseTo(13, 5);
    now.advance(5000);
    expect(r.positionAt()).toBeCloseTo(13, 5);
  });

  test('promotes the longest-present connected participant; ties broken by userId', () => {
    const { r, now } = room();
    now.advance(10);
    r.addParticipant({ userId: 'zed', displayName: 'Z' }, 's1');
    r.addParticipant({ userId: 'amy', displayName: 'A' }, 's2'); // same joinedAt as zed
    now.advance(10);
    r.addParticipant({ userId: 'bob', displayName: 'B' }, 's3');
    r.removeSocket('host', 's-host');
    r.onHostDisconnected();
    expect(r.promoteHost()).toBe('amy');
    expect(r.isHost('amy')).toBe(true);
  });

  test('disconnected participants are never promoted; empty room keeps no host change', () => {
    const { r } = room();
    r.addParticipant({ userId: 'p1', displayName: 'P1' }, 's1');
    r.removeSocket('p1', 's1');
    r.removeSocket('host', 's-host');
    expect(r.promoteHost()).toBeNull();
    expect(r.isHost('host')).toBe(true);
  });
});

describe('timeline trivia triggering', () => {
  const track = [{ id: 'e1', ts: 5 }, { id: 'e2', ts: 10 }, { id: 'e3', ts: 20 }];

  test('fires markers crossed during playback, each exactly once', () => {
    const { r, now } = room();
    r.applyPlayback('host', { state: 'play', positionSeconds: 0 });
    now.advance(6000);
    expect(r.dueTrivia(track).map((e) => e.id)).toEqual(['e1']);
    now.advance(5000);
    expect(r.dueTrivia(track).map((e) => e.id)).toEqual(['e2']);
    expect(r.dueTrivia(track)).toEqual([]);
  });

  test('markers jumped over by a seek are skipped; nothing fires while paused', () => {
    const { r, now } = room();
    r.applyPlayback('host', { state: 'play', positionSeconds: 0 });
    r.applyPlayback('host', { state: 'seek', positionSeconds: 15 });
    now.advance(1000);
    expect(r.dueTrivia(track)).toEqual([]);
    r.applyPlayback('host', { state: 'pause' });
    now.advance(10_000);
    expect(r.dueTrivia(track)).toEqual([]);
  });
});

describe('narrative-variation voting', () => {
  function withVoters() {
    const ctx = room();
    ctx.r.addParticipant({ userId: 'p1', displayName: 'P1' }, 's1');
    ctx.r.addParticipant({ userId: 'p2', displayName: 'P2' }, 's2');
    return ctx;
  }

  test('majority wins and is recorded as applied', () => {
    const { r } = withVoters();
    r.openVote('host', variation, 10);
    r.castVote('p1', 'v_1', 'b');
    r.castVote('p2', 'v_1', 'b');
    r.castVote('host', 'v_1', 'c');
    expect(r.closeVote()).toMatchObject({ winningOptionId: 'b', counts: { a: 0, b: 2, c: 1 }, totalVotes: 3, applyAtTs: 100 });
    expect(r.appliedVariations.v_1).toBe('b');
  });

  test('voters can change their vote; one vote per user', () => {
    const { r } = withVoters();
    r.openVote('host', variation, 10);
    r.castVote('p1', 'v_1', 'b');
    const t = r.castVote('p1', 'v_1', 'c');
    expect(t).toMatchObject({ counts: { a: 0, b: 0, c: 1 }, totalVotes: 1 });
  });

  test('ties resolve to the authored default option, else authored order', () => {
    const { r } = withVoters();
    r.openVote('host', variation, 10);
    r.castVote('p1', 'v_1', 'b');
    r.castVote('p2', 'v_1', 'a');
    expect(r.closeVote().winningOptionId).toBe('a');
    const v2 = { ...variation, id: 'v_2' };
    r.openVote('host', v2, 10);
    r.castVote('p1', 'v_2', 'c');
    r.castVote('p2', 'v_2', 'b');
    expect(r.closeVote().winningOptionId).toBe('b');
  });

  test('only the host opens votes; voting must be enabled; one vote at a time', () => {
    const { r } = withVoters();
    expect(() => r.openVote('p1', variation)).toThrow(expect.objectContaining({ code: 'NOT_HOST' }));
    r.openVote('host', variation);
    expect(() => r.openVote('host', { ...variation, id: 'v_9' })).toThrow(expect.objectContaining({ code: 'VOTE_ACTIVE' }));
    expect(() => r.castVote('p1', 'v_1', 'zzz')).toThrow(expect.objectContaining({ code: 'BAD_REQUEST' }));
    const { r: r2 } = room({ settings: { votingEnabled: false } });
    expect(() => r2.openVote('host', variation)).toThrow(expect.objectContaining({ code: 'VOTING_DISABLED' }));
  });
});
