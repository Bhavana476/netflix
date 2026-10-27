import { useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { api, setSession } from '../api';

export default function Login() {
  const [mode, setMode] = useState('login');
  const [form, setForm] = useState({ email: '', password: '', displayName: '', role: 'viewer' });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const nav = useNavigate();
  const [params] = useSearchParams();

  const submit = async (e) => {
    e.preventDefault();
    setError('');
    setBusy(true);
    try {
      const body = mode === 'login' ? { email: form.email, password: form.password } : form;
      const r = await api(`/auth/${mode === 'login' ? 'login' : 'register'}`, { method: 'POST', body });
      setSession({ user: r.user, accessToken: r.accessToken, refreshToken: r.refreshToken });
      nav(params.get('next') || '/');
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };
  const set = (k) => (e) => setForm({ ...form, [k]: e.target.value });

  return (
    <div className="auth-page">
      <form className="auth-card" onSubmit={submit}>
        <h1><span className="brand-mark">▶</span> Watch Spaces</h1>
        <p className="muted">Watch together, in sync, with an AI co-pilot that knows the story.</p>
        <div className="tabs">
          <button type="button" className={mode === 'login' ? 'active' : ''} onClick={() => setMode('login')}>Sign in</button>
          <button type="button" className={mode === 'register' ? 'active' : ''} onClick={() => setMode('register')}>Create account</button>
        </div>
        {mode === 'register' && (
          <>
            <label>Display name<input value={form.displayName} onChange={set('displayName')} maxLength={40} required /></label>
            <label>
              Account type
              <select value={form.role} onChange={set('role')}>
                <option value="viewer">Viewer - join Watch Spaces</option>
                <option value="host">Host - create and run Watch Spaces</option>
              </select>
            </label>
          </>
        )}
        <label>Email<input type="email" value={form.email} onChange={set('email')} required autoComplete="email" /></label>
        <label>Password<input type="password" value={form.password} onChange={set('password')} minLength={8} required autoComplete={mode === 'login' ? 'current-password' : 'new-password'} /></label>
        {error && <div className="error">{error}</div>}
        <button className="btn primary" disabled={busy}>{busy ? 'Please wait…' : mode === 'login' ? 'Sign in' : 'Create account'}</button>
      </form>
    </div>
  );
}
