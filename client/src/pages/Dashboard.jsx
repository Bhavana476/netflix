import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api, fmtTime } from '../api';

function Poster({ t, children, onClick }) {
  return (
    <div className="poster" style={{ '--poster': t.posterColor || '#444' }} onClick={onClick}>
      <div className="poster-art">
        <span className="poster-title">{t.name}</span>
        {t.hasFullTimeline && <span className="badge ai" title="Full AI co-pilot timeline">AI</span>}
      </div>
      <div className="poster-meta">{children}</div>
    </div>
  );
}

function Stars({ value, onRate }) {
  return (
    <span className="stars" onClick={(e) => e.stopPropagation()}>
      {[1, 2, 3, 4, 5].map((n) => (
        <button key={n} className={n <= (value || 0) ? 'on' : ''} onClick={() => onRate(n)} aria-label={`Rate ${n}`}>★</button>
      ))}
    </span>
  );
}

function CreateRoomModal({ title, onClose }) {
  const nav = useNavigate();
  const [f, setF] = useState({ name: `${title.name} night`, privacy: 'invite', maxParticipants: 25, aiVerbosity: 'normal', votingEnabled: true, triviaEnabled: true, scheduledFor: '' });
  const [error, setError] = useState('');
  const submit = async (e) => {
    e.preventDefault();
    try {
      const body = { ...f, titleId: title.id, maxParticipants: Number(f.maxParticipants), scheduledFor: f.scheduledFor ? new Date(f.scheduledFor).toISOString() : undefined };
      const r = await api('/watch-spaces', { method: 'POST', body });
      if (f.scheduledFor) onClose(true);
      else nav(`/room/${r.watchSpaceId}`);
    } catch (err) {
      setError(err.message);
    }
  };
  const set = (k) => (e) => setF({ ...f, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value });
  return (
    <div className="modal-backdrop" onClick={() => onClose(false)}>
      <form className="modal" onClick={(e) => e.stopPropagation()} onSubmit={submit}>
        <h2>New Watch Space · {title.name}</h2>
        <label>Room name<input value={f.name} onChange={set('name')} maxLength={80} /></label>
        <div className="row">
          <label>Privacy
            <select value={f.privacy} onChange={set('privacy')}>
              <option value="invite">Invite-only (code/link)</option>
              <option value="public">Public link</option>
            </select>
          </label>
          <label>Max participants<input type="number" min={2} max={50} value={f.maxParticipants} onChange={set('maxParticipants')} /></label>
        </div>
        <div className="row">
          <label>AI co-pilot verbosity
            <select value={f.aiVerbosity} onChange={set('aiVerbosity')}>
              <option value="minimal">Minimal</option>
              <option value="normal">Normal</option>
              <option value="chatty">Chatty</option>
            </select>
          </label>
          <label>Schedule for later (optional)<input type="datetime-local" value={f.scheduledFor} onChange={set('scheduledFor')} /></label>
        </div>
        <label className="check"><input type="checkbox" checked={f.triviaEnabled} onChange={set('triviaEnabled')} /> Show trivia cards automatically</label>
        <label className="check"><input type="checkbox" checked={f.votingEnabled} onChange={set('votingEnabled')} /> Allow group voting on variations</label>
        {error && <div className="error">{error}</div>}
        <div className="modal-actions">
          <button type="button" className="btn ghost" onClick={() => onClose(false)}>Cancel</button>
          <button className="btn primary">{f.scheduledFor ? 'Schedule' : 'Create & enter'}</button>
        </div>
      </form>
    </div>
  );
}

export default function Dashboard({ user }) {
  const nav = useNavigate();
  const [data, setData] = useState({ recs: null, history: [], rooms: [], sessions: [], titles: [] });
  const [creating, setCreating] = useState(null);
  const [code, setCode] = useState('');
  const [joinError, setJoinError] = useState('');
  const canHost = user.role === 'host' || user.role === 'admin';

  const load = useCallback(async () => {
    const [recs, history, rooms, sessions, titles] = await Promise.all([
      api('/me/recommendations?k=10'),
      api('/me/history'),
      api('/watch-spaces?status=live,scheduled'),
      api('/me/sessions'),
      api('/titles'),
    ]);
    setData({ recs, history: history.history, rooms: rooms.watchSpaces, sessions: sessions.sessions, titles: titles.titles });
  }, []);
  useEffect(() => {
    load().catch(() => {});
  }, [load]);

  const rate = async (titleId, rating) => {
    await api('/me/interactions', { method: 'POST', body: { titleId, rating } });
    load();
  };
  const join = async (e) => {
    e.preventDefault();
    setJoinError('');
    try {
      const r = await api('/watch-spaces/join', { method: 'POST', body: { inviteCode: code } });
      nav(`/room/${r.watchSpaceId}`);
    } catch (err) {
      setJoinError(err.message);
    }
  };

  const live = data.rooms.filter((r) => r.status === 'live');
  const upcoming = data.rooms.filter((r) => r.status === 'scheduled');

  return (
    <main className="page">
      <section className="hero">
        <div>
          <h1>Welcome back, {user.displayName.split(' ')[0]}</h1>
          <p className="muted">Pick something to watch together, or jump back into a room.</p>
        </div>
        <form className="join-code" onSubmit={join}>
          <input placeholder="Invite code, e.g. NX-4Q7K" value={code} onChange={(e) => setCode(e.target.value)} />
          <button className="btn primary">Join</button>
          {joinError && <div className="error">{joinError}</div>}
        </form>
      </section>

      {(live.length > 0 || upcoming.length > 0) && (
        <section>
          <h2>Your Watch Spaces</h2>
          <div className="room-list">
            {[...live, ...upcoming].map((r) => (
              <div key={r.watchSpaceId} className="room-card">
                <div>
                  <span className={`status status-${r.status}`}>{r.status === 'live' ? '● Live' : 'Scheduled'}</span>
                  <h3>{r.name}</h3>
                  <p className="muted">
                    {r.titleName} · {r.isHost ? 'You host' : 'Participant'} · code <code>{r.inviteCode}</code>
                    {r.scheduledFor && ` · ${new Date(r.scheduledFor).toLocaleString()}`}
                  </p>
                </div>
                <button className="btn primary" onClick={() => nav(`/room/${r.watchSpaceId}`)}>{r.status === 'live' ? 'Rejoin' : 'Open'}</button>
              </div>
            ))}
          </div>
        </section>
      )}

      <section>
        <h2>
          Recommended for you
          {data.recs && <span className="muted small"> · based on {data.recs.basedOnInteractions} interactions · model trained {new Date(data.recs.modelTrainedAt).toLocaleString()}</span>}
        </h2>
        <div className="rail">
          {data.recs && data.recs.items.map((r) => (
            <Poster key={r.titleId} t={r.title} onClick={() => canHost && setCreating({ id: r.titleId, name: r.title.name })}>
              <div className="reason">{r.reason}</div>
              <div className="score" title={`cf=${r.cf} cb=${r.cb}`}>match {(r.score * 100).toFixed(0)}</div>
            </Poster>
          ))}
        </div>
      </section>

      {data.history.length > 0 && (
        <section>
          <h2>Recently watched</h2>
          <div className="rail">
            {data.history.map((h) => (
              <Poster key={h.titleId} t={{ ...h, name: h.name }}>
                <div className="progress"><div style={{ width: `${Math.round(h.progress * 100)}%` }} /></div>
                <Stars value={h.rating} onRate={(n) => rate(h.titleId, n)} />
              </Poster>
            ))}
          </div>
        </section>
      )}

      <section>
        <h2>Catalog {canHost ? <span className="muted small">· click a title to start a Watch Space</span> : <span className="muted small">· viewers join rooms by invite code</span>}</h2>
        <div className="grid">
          {data.titles.map((t) => (
            <Poster key={t.id} t={t} onClick={() => canHost && setCreating(t)}>
              <div className="muted small">{t.year} · {t.genres.join(', ')} · {fmtTime(t.durationSeconds)}</div>
              <Stars value={(data.history.find((h) => h.titleId === t.id) || {}).rating} onRate={(n) => rate(t.id, n)} />
            </Poster>
          ))}
        </div>
      </section>

      {data.sessions.length > 0 && (
        <section>
          <h2>Past sessions</h2>
          <table className="table">
            <thead>
              <tr><th>Room</th><th>Title</th><th>Ended</th><th>Duration</th><th>Peak</th><th>AI Qs</th><th>Trivia</th><th>Chat</th><th /></tr>
            </thead>
            <tbody>
              {data.sessions.map((s) => (
                <tr key={s.watchSpaceId}>
                  <td>{s.name}</td>
                  <td>{s.titleName}</td>
                  <td>{s.endedAt && new Date(s.endedAt).toLocaleString()}</td>
                  <td>{s.summary ? fmtTime(s.summary.durationSeconds) : '-'}</td>
                  <td>{s.summary?.peakParticipants ?? '-'}</td>
                  <td>{s.summary?.aiQuestions ?? '-'}</td>
                  <td>{s.summary?.triviaSurfaced ?? '-'}</td>
                  <td>{s.summary?.chatMessages ?? '-'}</td>
                  <td><Link to={`/sessions/${s.watchSpaceId}`}>Details</Link></td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}

      {creating && <CreateRoomModal title={creating} onClose={(reload) => { setCreating(null); if (reload) load(); }} />}
    </main>
  );
}
