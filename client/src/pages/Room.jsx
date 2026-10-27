import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api, fmtTime } from '../api';
import { RoomConnection } from '../roomConnection';

const REACTIONS = ['👍', '😂', '😮', '😢', '❤️', '🔥', '👏'];

function appliedFromSnapshot(room) {
  const out = {};
  for (const [variationId, optionId] of Object.entries(room.appliedVariations || {})) {
    const v = room.variations.find((x) => x.id === variationId);
    if (v) out[variationId] = { variationId, winningOptionId: optionId, option: v.options.find((o) => o.id === optionId), kind: v.kind, targetLineId: v.targetLineId, applyAtTs: v.ts, endTs: v.endTs };
  }
  return out;
}

// ------------------------------------------------------------------ chat & co-pilot panels
function ChatPanel({ messages, onSend, onTyping, typing, muted, me }) {
  const [text, setText] = useState('');
  const endRef = useRef();
  useEffect(() => {
    if (endRef.current) endRef.current.scrollIntoView({ block: 'end' });
  }, [messages.length]);
  const submit = (e) => {
    e.preventDefault();
    if (!text.trim()) return;
    onSend(text);
    setText('');
    onTyping(false);
  };
  const chat = messages.filter((m) => m.kind !== 'ai_answer');
  return (
    <div className="panel-body">
      <div className="messages">
        {chat.map((m) => (
          <div key={m.messageId} className={`msg ${m.kind} ${m.userId === me ? 'mine' : ''}`}>
            {m.kind === 'system' ? <em>{m.body}</em> : (<><b>{m.displayName}</b> <span className="ts">{fmtTime(m.tsSeconds)}</span><div>{m.body}</div></>)}
          </div>
        ))}
        <div ref={endRef} />
      </div>
      <div className="typing">{Object.values(typing).length ? `${Object.values(typing).join(', ')} typing…` : ''}</div>
      <form className="composer" onSubmit={submit}>
        <input value={text} disabled={muted} placeholder={muted ? 'The host muted you' : 'Say something…'} maxLength={500}
          onChange={(e) => { setText(e.target.value); onTyping(!!e.target.value); }} />
        <button className="btn primary" disabled={muted}>Send</button>
      </form>
    </div>
  );
}

function CopilotPanel({ messages, onAsk, pending, isHost, onPin, aiVerbosity }) {
  const [q, setQ] = useState('');
  const endRef = useRef();
  const answers = messages.filter((m) => m.kind === 'ai_answer');
  useEffect(() => {
    if (endRef.current) endRef.current.scrollIntoView({ block: 'end' });
  }, [answers.length, pending]);
  const ask = (e) => {
    e.preventDefault();
    if (!q.trim()) return;
    onAsk(q);
    setQ('');
  };
  return (
    <div className="panel-body">
      <div className="messages">
        <div className="hint">Ask about what's on screen: <i>"Who is that?"</i>, <i>"What does that word mean?"</i>, <i>"What happened earlier?"</i>. Answers only use this title's timeline up to the current moment ({aiVerbosity} mode).</div>
        {answers.map((m) => (
          <div key={m.messageId} className="msg ai">
            <div className="q">{m.askedByName || m.displayNameAsked || 'Someone'} asked at {fmtTime(m.tsSeconds)}: “{m.question}”</div>
            <div className="a">{m.answer}</div>
            <div className="sources">
              {(m.sources || []).length ? m.sources.map((s) => (
                <span key={s.id} className="chip" title={s.id}>{s.type} · {s.label} @ {fmtTime(s.ts)}</span>
              )) : <span className="chip muted">no matching timeline entry - declined</span>}
              {m.latencyMs !== undefined && <span className="chip muted">{m.latencyMs} ms · {m.model}</span>}
              {isHost && (m.sources || []).length > 0 && <button className="link" onClick={() => onPin(m.answer, m.sourceEvents[0])}>📌 Pin</button>}
            </div>
          </div>
        ))}
        {pending && <div className="msg ai pending">Co-pilot is looking up “{pending}”…</div>}
        <div ref={endRef} />
      </div>
      <form className="composer" onSubmit={ask}>
        <input value={q} placeholder="Ask the AI co-pilot…" maxLength={300} onChange={(e) => setQ(e.target.value)} />
        <button className="btn primary">Ask</button>
      </form>
    </div>
  );
}

function PeoplePanel({ participants, hostId, me, isHost, send, locked, settings, variations, applied, vote }) {
  return (
    <div className="panel-body scroll">
      <ul className="people">
        {participants.map((p) => (
          <li key={p.userId} className={p.connected ? '' : 'offline'}>
            <span className={`dot q-${p.quality}`} title={`connection: ${p.quality}${p.rttMs ? `, ${p.rttMs} ms` : ''}`} />
            <span className="name">{p.displayName}{p.userId === me && ' (you)'}</span>
            {p.userId === hostId && <span className="badge">HOST</span>}
            {p.muted && <span className="badge muted">muted</span>}
            {!p.connected && <span className="badge muted">reconnecting</span>}
            {isHost && p.userId !== me && (
              <span className="actions">
                <button className="link" onClick={() => send(p.muted ? 'room.mod.unmute' : 'room.mod.mute', { userId: p.userId })}>{p.muted ? 'Unmute' : 'Mute'}</button>
                <button className="link" onClick={() => send('room.mod.transferHost', { userId: p.userId })}>Make host</button>
                <button className="link danger" onClick={() => window.confirm(`Remove ${p.displayName}?`) && send('room.mod.remove', { userId: p.userId })}>Remove</button>
              </span>
            )}
          </li>
        ))}
      </ul>
      {isHost && (
        <div className="host-tools">
          <h4>Room settings</h4>
          <label className="check"><input type="checkbox" checked={locked} onChange={(e) => send(e.target.checked ? 'room.mod.lock' : 'room.mod.unlock')} /> Lock room (no new joins)</label>
          <label className="check"><input type="checkbox" checked={settings.triviaEnabled} onChange={(e) => send('room.settings.update', { triviaEnabled: e.target.checked })} /> Auto trivia cards</label>
          <label className="check"><input type="checkbox" checked={settings.votingEnabled} onChange={(e) => send('room.settings.update', { votingEnabled: e.target.checked })} /> Group voting</label>
          <label>AI verbosity
            <select value={settings.aiVerbosity} onChange={(e) => send('room.settings.update', { aiVerbosity: e.target.value })}>
              <option value="minimal">Minimal</option><option value="normal">Normal</option><option value="chatty">Chatty</option>
            </select>
          </label>
          <button className="btn" onClick={() => send('room.ai.triviaRound')}>🎲 Trivia round now</button>
          <h4>Pre-approved variations</h4>
          {variations.map((v) => (
            <div key={v.id} className="variation">
              <div><b>{v.prompt}</b> <span className="muted small">{v.kind} @ {fmtTime(v.ts)}</span></div>
              {applied[v.id] ? (
                <div className="muted small">Applied: {applied[v.id].option.label}</div>
              ) : (
                <div className="variation-actions">
                  <button className="btn small" disabled={!settings.votingEnabled || !!vote} onClick={() => send('room.variation.openVote', { variationId: v.id, durationSec: 20 })}>Open vote</button>
                  {v.options.map((o) => (
                    <button key={o.id} className="btn small ghost" onClick={() => send('room.variation.apply', { variationId: v.id, optionId: o.id })} title={o.text}>Apply “{o.label}”</button>
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function VoteCard({ vote, onVote, isHost, onClose }) {
  const [left, setLeft] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setLeft(Math.max(0, Math.ceil((vote.closesAt - Date.now()) / 1000))), 250);
    return () => clearInterval(t);
  }, [vote.closesAt]);
  return (
    <div className="vote-card">
      <div className="vote-head"><b>🗳 {vote.prompt}</b><span>{left}s</span></div>
      {vote.options.map((o) => (
        <button key={o.id} className={`vote-opt ${vote.myVote === o.id ? 'mine' : ''}`} onClick={() => onVote(o.id)}>
          <span>{o.label}</span><span className="count">{(vote.counts || {})[o.id] || 0}</span>
        </button>
      ))}
      <div className="muted small">{vote.totalVotes || 0} vote(s) · ties go to the original</div>
      {isHost && <button className="btn small" onClick={onClose}>Close vote now</button>}
    </div>
  );
}

// ------------------------------------------------------------------ main room
export default function Room({ user }) {
  const { id } = useParams();
  const videoRef = useRef(null);
  const connRef = useRef(null);
  const playbackRef = useRef(null);
  const isHostRef = useRef(false);
  const rateTimer = useRef(null);

  const [info, setInfo] = useState(null);
  const [room, setRoom] = useState(null);
  const [error, setError] = useState('');
  const [toast, setToast] = useState('');
  const [connected, setConnected] = useState(false);
  const [participants, setParticipants] = useState([]);
  const [hostId, setHostId] = useState(null);
  const [messages, setMessages] = useState([]);
  const [trivia, setTrivia] = useState([]);
  const [pinned, setPinned] = useState(null);
  const [vote, setVote] = useState(null);
  const [applied, setApplied] = useState({});
  const [suggestions, setSuggestions] = useState([]);
  const [settings, setSettings] = useState({});
  const [locked, setLocked] = useState(false);
  const [hostDisconnected, setHostDisconnected] = useState(false);
  const [typing, setTyping] = useState({});
  const [floating, setFloating] = useState([]);
  const [needsGesture, setNeedsGesture] = useState(false);
  const [sync, setSync] = useState({ driftMs: 0, action: 'none' });
  const [now, setNow] = useState(0);
  const [tab, setTab] = useState('chat');
  const [aiPending, setAiPending] = useState(null);
  const [ended, setEnded] = useState(null);
  const [subs, setSubs] = useState(null);
  const [playState, setPlayState] = useState('paused');

  const isHost = hostId === user.id;
  isHostRef.current = isHost;
  const me = participants.find((p) => p.userId === user.id);
  const locale = (user.preferences && user.preferences.subtitleLocale) || 'en';

  const flash = useCallback((msg) => {
    setToast(msg);
    setTimeout(() => setToast(''), 4000);
  }, []);
  const send = useCallback(async (event, payload) => {
    const res = await connRef.current.send(event, payload);
    if (res && !res.ok) flash(res.error.message);
    return res;
  }, [flash]);
  const addSystem = useCallback((body) => setMessages((m) => [...m, { kind: 'system', messageId: `sys-${Date.now()}-${Math.random()}`, body }]), []);

  // Apply an authoritative playback snapshot to the local <video>.
  const applyPlayback = useCallback((snap) => {
    playbackRef.current = snap;
    setPlayState(snap.state);
    const v = videoRef.current;
    const c = connRef.current;
    if (!v || !c || v.readyState < 1) return;
    const target = snap.positionSeconds + (snap.state === 'playing' ? (c.serverNow() - snap.serverTime) / 1000 : 0);
    if (Math.abs(v.currentTime - target) > 0.25) v.currentTime = target;
    v.playbackRate = 1;
    if (snap.state === 'playing') v.play().then(() => setNeedsGesture(false)).catch(() => setNeedsGesture(true));
    else v.pause();
  }, []);

  useEffect(() => {
    api(`/watch-spaces/${id}`).then(setInfo).catch((e) => setError(e.message));
    const c = new RoomConnection(id);
    connRef.current = c;
    const offs = [
      c.on('connection', (s) => setConnected(s.connected)),
      c.on('joined', (res) => {
        if (!res || !res.ok) return setError((res && res.error && res.error.message) || 'Could not join');
        const r = res.room;
        setRoom(r);
        setHostId(r.hostUserId);
        setParticipants(r.participants);
        setMessages(r.history);
        setSettings(r.settings);
        setLocked(r.locked);
        setHostDisconnected(r.hostDisconnected);
        setApplied(appliedFromSnapshot(r));
        setVote(r.vote);
        applyPlayback(r.playback);
      }),
      c.on('room.playback.update', applyPlayback),
      c.on('room.presence.update', (p) => setParticipants(p.participants)),
      c.on('room.chat.message', (m) => setMessages((list) => [...list, m])),
      c.on('room.chat.typing', (p) => setTyping((t) => {
        const n = { ...t };
        if (p.isTyping) n[p.userId] = p.displayName;
        else delete n[p.userId];
        return n;
      })),
      c.on('room.chat.reaction', (p) => {
        const key = `${Date.now()}-${Math.random()}`;
        setFloating((f) => [...f, { key, emoji: p.emoji, left: 10 + Math.random() * 80 }]);
        setTimeout(() => setFloating((f) => f.filter((x) => x.key !== key)), 2500);
      }),
      c.on('room.ai.thinking', (p) => setAiPending(p.question)),
      c.on('room.ai.answer', (p) => {
        setAiPending(null);
        setMessages((list) => [...list, { kind: 'ai_answer', messageId: p.questionId, ...p, askedByName: p.displayName }]);
        setTab((t) => (p.userId === user.id ? 'ai' : t));
      }),
      c.on('room.ai.trivia', (card) => {
        setTrivia((t) => [card, ...t].slice(0, 3));
        setTimeout(() => setTrivia((t) => t.filter((x) => x.eventId !== card.eventId)), 12000);
      }),
      c.on('room.ai.pinned', (p) => setPinned(p)),
      c.on('room.variation.suggested', (p) => setSuggestions((s) => [...s.filter((x) => x.variationId !== p.variationId), p])),
      c.on('room.variation.voteOpen', (p) => setVote({ ...p, counts: {}, totalVotes: 0 })),
      c.on('room.variation.voteTally', (p) => setVote((v) => (v && v.variationId === p.variationId ? { ...v, counts: p.counts, totalVotes: p.totalVotes } : v))),
      c.on('room.variation.applied', (p) => {
        setApplied((a) => ({ ...a, [p.variationId]: p }));
        setVote(null);
        setSuggestions((s) => s.filter((x) => x.variationId !== p.variationId));
        addSystem(`Variation applied (${p.via === 'vote' ? `vote ${Object.entries(p.counts || {}).map(([k, n]) => `${k}:${n}`).join(' ')}` : 'host'}): “${p.option.label}” at ${fmtTime(p.applyAtTs)}`);
      }),
      c.on('room.settings.update', (p) => setSettings(p.settings)),
      c.on('room.lock.update', (p) => setLocked(p.locked)),
      c.on('room.host.changed', (p) => {
        setHostId(p.hostUserId);
        setHostDisconnected(false);
        addSystem(p.reason === 'transfer' ? 'Host role was transferred.' : 'The host disconnected - a new host was promoted.');
      }),
      c.on('room.host.disconnected', () => {
        setHostDisconnected(true);
        addSystem('Host disconnected - playback paused.');
      }),
      c.on('room.host.reconnected', () => setHostDisconnected(false)),
      c.on('room.removed', () => setError('The host removed you from this Watch Space.')),
      c.on('room.ended', (p) => setEnded(p.summary)),
      c.on('room.error', (e) => flash(e.message)),
    ];
    return () => {
      offs.forEach((off) => off());
      c.close();
    };
  }, [id, user.id, applyPlayback, addSystem, flash]);

  // Subtitles for the viewer's locale (swappable without touching playback).
  const titleId = room && room.title.id;
  useEffect(() => {
    if (titleId) api(`/titles/${titleId}/subtitles?locale=${locale}`).then(setSubs).catch(() => {});
  }, [titleId, locale]);

  // Drift reporting + correction loop, and UI clock.
  useEffect(() => {
    const report = setInterval(async () => {
      const v = videoRef.current;
      const c = connRef.current;
      if (!v || !c || !c.socket.connected || !playbackRef.current || v.readyState < 1) return;
      const sentAt = c.serverNow();
      const res = await c.send('room.sync.report', { positionSeconds: v.currentTime, serverTimeEstimate: sentAt, rttMs: c.rtt, buffering: v.readyState < 3 || v.seeking });
      if (!res || !res.ok || !res.correction) return;
      const k = res.correction;
      setSync({ driftMs: k.driftMs || 0, action: k.action });
      if (k.action === 'rate') {
        v.playbackRate = k.rate;
        clearTimeout(rateTimer.current);
        rateTimer.current = setTimeout(() => { v.playbackRate = 1; }, Math.min(k.durationMs, 5000));
      } else if (k.action === 'seek') {
        const elapsed = playbackRef.current.state === 'playing' ? (c.serverNow() - sentAt) / 1000 : 0;
        v.currentTime = k.targetPosition + elapsed;
      }
    }, 1000);
    const ui = setInterval(() => videoRef.current && setNow(videoRef.current.currentTime), 250);
    return () => {
      clearInterval(report);
      clearInterval(ui);
    };
  }, []);

  // Host-side buffering propagates to the room so everyone waits together.
  const onWaiting = () => {
    const pb = playbackRef.current;
    if (isHostRef.current && pb && pb.state === 'playing') connRef.current.send('room.playback.update', { state: 'buffering', positionSeconds: videoRef.current.currentTime });
  };
  const onCanPlay = () => {
    const pb = playbackRef.current;
    if (isHostRef.current && pb && pb.state === 'buffering') connRef.current.send('room.playback.update', { state: 'play', positionSeconds: videoRef.current.currentTime });
  };

  const togglePlay = () => send('room.playback.update', { state: playState === 'playing' ? 'pause' : 'play', positionSeconds: videoRef.current.currentTime });
  const seekTo = (sec) => send('room.playback.update', { state: 'seek', positionSeconds: Math.max(0, sec) });

  const typingSent = useRef(false);
  const onTyping = (isTyping) => {
    if (typingSent.current === isTyping) return;
    typingSent.current = isTyping;
    connRef.current.send('room.chat.typing', { isTyping });
  };

  // Current subtitle line, with any applied subtitle variation overriding the authored line.
  const subtitle = useMemo(() => {
    if (!subs) return null;
    const line = subs.lines.find((l) => now >= l.start && now <= l.end);
    if (!line) return null;
    const override = Object.values(applied).find((a) => a.kind === 'subtitle' && a.targetLineId === line.id);
    return override ? { text: override.option.text, varied: true } : { text: line.text, varied: line.source !== 'default' };
  }, [subs, now, applied]);
  const sceneInsert = Object.values(applied).find((a) => a.kind === 'scene' && now >= a.applyAtTs && now <= (a.endTs || a.applyAtTs + 8) && !a.option.text.startsWith('('));

  if (error) return <main className="page center"><div className="error big">{error}</div><Link to="/">Back to dashboard</Link></main>;
  if (ended) {
    return (
      <main className="page center">
        <h1>Session ended</h1>
        <p className="muted">Duration {fmtTime(ended.durationSeconds)} · peak {ended.peakParticipants} participants · {ended.aiQuestions} AI questions · {ended.triviaSurfaced} trivia cards · {ended.chatMessages} chat messages</p>
        <Link className="btn primary" to={`/sessions/${id}`}>Session analytics</Link> <Link to="/">Dashboard</Link>
      </main>
    );
  }
  if (!room) return <main className="page center">Connecting to Watch Space…</main>;

  const inviteLink = info ? `${window.location.origin}/join/${info.inviteCode}` : '';
  const duration = room.title.durationSeconds;

  return (
    <main className="room">
      <section className="stage">
        <div className="room-bar">
          <div>
            <h2>{info ? info.name : 'Watch Space'} <span className="muted">· {room.title.name}</span></h2>
            <span className={`status ${connected ? 'status-live' : 'status-off'}`}>{connected ? '● Connected' : '○ Reconnecting…'}</span>
            <span className="muted small"> · {participants.filter((p) => p.connected).length} watching · drift {sync.driftMs} ms ({sync.action}) · rtt {connRef.current ? connRef.current.rtt : '-'} ms</span>
            {locked && <span className="badge">🔒 locked</span>}
          </div>
          {info && (
            <div className="invite">
              Invite <code>{info.inviteCode}</code>
              <button className="btn small ghost" onClick={() => navigator.clipboard && navigator.clipboard.writeText(inviteLink).then(() => flash('Invite link copied'))}>Copy link</button>
            </div>
          )}
        </div>

        <div className="player">
          <video ref={videoRef} src={room.title.videoAssetUrl} playsInline preload="auto"
            onLoadedMetadata={() => playbackRef.current && applyPlayback(playbackRef.current)}
            onWaiting={onWaiting} onCanPlay={onCanPlay} />
          {subtitle && <div className={`subtitle ${subtitle.varied ? 'varied' : ''}`}>{subtitle.text}</div>}
          {sceneInsert && <div className="scene-insert">{sceneInsert.option.text}</div>}
          {hostDisconnected && <div className="overlay-banner">Host disconnected - playback paused. A new host will be promoted shortly.</div>}
          {needsGesture && (
            <button className="gesture" onClick={() => { setNeedsGesture(false); applyPlayback(playbackRef.current); }}>▶ Click to join playback</button>
          )}
          <div className="trivia-stack">
            {pinned && <div className="trivia pinned">📌 {pinned.text} <button className="link" onClick={() => setPinned(null)}>×</button></div>}
            {trivia.map((t) => (
              <div key={t.eventId} className="trivia">
                <span className="label">{t.onDemand ? 'Trivia round' : t.type === 'trivia' ? 'Did you know?' : t.type}</span> {t.text}
              </div>
            ))}
          </div>
          <div className="floating">{floating.map((f) => <span key={f.key} style={{ left: `${f.left}%` }}>{f.emoji}</span>)}</div>
          {vote && <VoteCard vote={vote} isHost={isHost} onClose={() => send('room.variation.closeVote')}
            onVote={(optionId) => { setVote((v) => ({ ...v, myVote: optionId })); send('room.variation.vote', { variationId: vote.variationId, optionId }); }} />}
        </div>

        <div className="controls">
          <button className="btn" onClick={togglePlay} disabled={!isHost} title={isHost ? '' : 'Only the host controls playback'}>{playState === 'playing' ? '❚❚ Pause' : '▶ Play'}</button>
          <button className="btn ghost" disabled={!isHost} onClick={() => seekTo(now - 10)}>-10s</button>
          <input type="range" min={0} max={duration} step={0.5} value={Math.min(now, duration)} disabled={!isHost}
            onChange={(e) => seekTo(Number(e.target.value))} />
          <span className="time">{fmtTime(now)} / {fmtTime(duration)}</span>
          <button className="btn ghost" disabled={!isHost} onClick={() => seekTo(now + 10)}>+10s</button>
          <span className="reactions">{REACTIONS.map((r) => <button key={r} onClick={() => send('room.chat.reaction', { emoji: r })}>{r}</button>)}</span>
          {isHost && <button className="btn danger" onClick={() => window.confirm('End this Watch Space for everyone?') && send('room.end')}>End session</button>}
        </div>
        {isHost && suggestions.length > 0 && (
          <div className="suggestions">
            {suggestions.map((s) => (
              <div key={s.variationId} className="suggestion">
                🤖 Co-pilot: upcoming variation point at {fmtTime(s.ts)} - <b>{s.prompt}</b>
                <button className="btn small" disabled={!settings.votingEnabled || !!vote} onClick={() => send('room.variation.openVote', { variationId: s.variationId, durationSec: 20 })}>Open group vote</button>
                {s.options.map((o) => <button key={o.id} className="btn small ghost" onClick={() => send('room.variation.apply', { variationId: s.variationId, optionId: o.id })}>Approve “{o.label}”</button>)}
                <button className="link" onClick={() => setSuggestions((x) => x.filter((y) => y.variationId !== s.variationId))}>dismiss</button>
              </div>
            ))}
          </div>
        )}
        {!isHost && <p className="muted small">Playback follows the host. Subtitles: {subs ? `${locale} (available: ${subs.availableLocales.join(', ')})` : '…'} - change language with the CC menu.</p>}
      </section>

      <aside className="side">
        <div className="tabs">
          <button className={tab === 'chat' ? 'active' : ''} onClick={() => setTab('chat')}>Chat</button>
          <button className={tab === 'ai' ? 'active' : ''} onClick={() => setTab('ai')}>AI Co-Pilot</button>
          <button className={tab === 'people' ? 'active' : ''} onClick={() => setTab('people')}>People ({participants.filter((p) => p.connected).length})</button>
        </div>
        {tab === 'chat' && <ChatPanel messages={messages} me={user.id} typing={typing} muted={me && me.muted} onTyping={onTyping} onSend={(body) => send('room.chat.message', { body })} />}
        {tab === 'ai' && <CopilotPanel messages={messages} pending={aiPending} isHost={isHost} aiVerbosity={settings.aiVerbosity}
          onAsk={(question) => send('room.ai.ask', { question, currentTs: videoRef.current ? videoRef.current.currentTime : undefined })}
          onPin={(text, sourceEventId) => send('room.ai.pin', { text, sourceEventId })} />}
        {tab === 'people' && <PeoplePanel participants={participants} hostId={hostId} me={user.id} isHost={isHost} send={send} locked={locked} settings={settings} variations={room.variations} applied={applied} vote={vote} />}
      </aside>
      {toast && <div className="toast">{toast}</div>}
    </main>
  );
}
