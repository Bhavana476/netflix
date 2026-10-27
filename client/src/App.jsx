import { useEffect, useState } from 'react';
import { Routes, Route, Navigate, Link, useNavigate, useLocation } from 'react-router-dom';
import { api, getSession, onSessionChange, setSession } from './api';
import Login from './pages/Login.jsx';
import Dashboard from './pages/Dashboard.jsx';
import Room from './pages/Room.jsx';
import Admin from './pages/Admin.jsx';
import JoinInvite from './pages/JoinInvite.jsx';
import SessionDetail from './pages/SessionDetail.jsx';

const LOCALES = [['en', 'English'], ['es', 'Español'], ['fr', 'Français'], ['hi', 'हिन्दी']];

function Nav({ user }) {
  const nav = useNavigate();
  const logout = async () => {
    const s = getSession();
    await api('/auth/logout', { method: 'POST', body: { refreshToken: s && s.refreshToken } }).catch(() => {});
    setSession(null);
    nav('/login');
  };
  const setLocale = async (e) => {
    const r = await api('/auth/me/preferences', { method: 'PATCH', body: { subtitleLocale: e.target.value } });
    setSession({ ...getSession(), user: r.user });
  };
  return (
    <header className="nav">
      <Link to="/" className="brand">
        <span className="brand-mark">▶</span> Watch Spaces
      </Link>
      <nav>
        <Link to="/">Home</Link>
        {user.role === 'admin' && <Link to="/admin">Admin</Link>}
      </nav>
      <div className="nav-right">
        <label className="locale" title="Subtitle language">
          CC
          <select value={(user.preferences && user.preferences.subtitleLocale) || 'en'} onChange={setLocale}>
            {LOCALES.map(([v, l]) => (
              <option key={v} value={v}>{l}</option>
            ))}
          </select>
        </label>
        <span className="who">
          {user.displayName} <span className={`role role-${user.role}`}>{user.role}</span>
        </span>
        <button className="btn ghost" onClick={logout}>Sign out</button>
      </div>
    </header>
  );
}

function RequireAuth({ user, children }) {
  const loc = useLocation();
  if (!user) return <Navigate to={`/login?next=${encodeURIComponent(loc.pathname)}`} replace />;
  return children;
}

export default function App() {
  const [session, setS] = useState(getSession());
  useEffect(() => onSessionChange(setS), []);
  useEffect(() => {
    if (session) api('/auth/me').then((r) => setSession({ ...getSession(), user: r.user })).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const user = session && session.user;

  return (
    <div className="app">
      {user && <Nav user={user} />}
      <Routes>
        <Route path="/login" element={user ? <Navigate to="/" replace /> : <Login />} />
        <Route path="/" element={<RequireAuth user={user}><Dashboard user={user} /></RequireAuth>} />
        <Route path="/join/:code" element={<RequireAuth user={user}><JoinInvite /></RequireAuth>} />
        <Route path="/room/:id" element={<RequireAuth user={user}><Room user={user} /></RequireAuth>} />
        <Route path="/sessions/:id" element={<RequireAuth user={user}><SessionDetail /></RequireAuth>} />
        <Route path="/admin" element={<RequireAuth user={user}>{user && user.role === 'admin' ? <Admin /> : <Navigate to="/" replace />}</RequireAuth>} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </div>
  );
}
