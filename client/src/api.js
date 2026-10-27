// REST client with access-token refresh (single-flight) and session persistence.
const KEY = 'watchspaces.session';
let session = null;
try {
  session = JSON.parse(localStorage.getItem(KEY) || 'null');
} catch {
  session = null;
}
const listeners = new Set();

export const getSession = () => session;
export const getToken = () => (session ? session.accessToken : null);
export function onSessionChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
export function setSession(s) {
  session = s;
  try {
    if (s) localStorage.setItem(KEY, JSON.stringify(s));
    else localStorage.removeItem(KEY);
  } catch {
    /* storage unavailable: session lives in memory only */
  }
  listeners.forEach((fn) => fn(s));
}

let refreshing = null;
export function refreshSession() {
  if (!session || !session.refreshToken) return Promise.resolve(false);
  if (!refreshing) {
    refreshing = fetch('/api/v1/auth/refresh', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refreshToken: session.refreshToken }),
    })
      .then(async (r) => {
        if (!r.ok) {
          setSession(null);
          return false;
        }
        const d = await r.json();
        setSession({ user: d.user, accessToken: d.accessToken, refreshToken: d.refreshToken });
        return true;
      })
      .catch(() => false)
      .finally(() => {
        refreshing = null;
      });
  }
  return refreshing;
}

export class ApiError extends Error {
  constructor(message, status, data) {
    super(message);
    this.status = status;
    this.data = data;
  }
}

export async function api(path, { method = 'GET', body } = {}) {
  const doFetch = () =>
    fetch(`/api/v1${path}`, {
      method,
      headers: { 'Content-Type': 'application/json', ...(getToken() ? { Authorization: `Bearer ${getToken()}` } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  let res = await doFetch();
  if (res.status === 401 && session && session.refreshToken && !path.startsWith('/auth/')) {
    if (await refreshSession()) res = await doFetch();
  }
  if (res.status === 204) return null;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = (data.error && data.error.message) || (data.errors && data.errors[0] && data.errors[0].message) || res.statusText;
    throw new ApiError(msg, res.status, data);
  }
  return data;
}

export const fmtTime = (sec) => {
  const s = Math.max(0, Math.floor(sec || 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${r}` : `${m}:${r}`;
};
