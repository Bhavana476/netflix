import { useEffect, useState } from 'react';
import { api } from '../api';

const EXAMPLE = `# Paste or upload a title timeline (YAML or JSON). Schema: docs/TIMELINE_SCHEMA.md
title:
  id: t_2001
  name: My Test Title
  durationSeconds: 596
  genres: [Animation]
  videoAssetUrl: https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/BigBuckBunny.mp4
characters:
  - { id: c_01, name: Hero, description: the main character }
events:
  - { id: evt_0001, ts: 10, type: trivia, text: "A fact about this moment." }
  - { id: evt_0002, ts: 12, endTs: 90, type: character, characterId: c_01 }
`;

export default function Admin() {
  const [content, setContent] = useState(EXAMPLE);
  const [format, setFormat] = useState('auto');
  const [result, setResult] = useState(null);
  const [busy, setBusy] = useState(false);
  const [metrics, setMetrics] = useState(null);
  const [retrain, setRetrain] = useState(null);

  const loadMetrics = () => api('/admin/metrics').then(setMetrics).catch(() => {});
  useEffect(() => {
    loadMetrics();
  }, []);

  const onFile = async (e) => {
    const f = e.target.files[0];
    if (!f) return;
    if (f.size > 1.5 * 1024 * 1024) return setResult({ valid: false, errors: [{ path: '$', message: 'File is larger than 1.5 MB.' }] });
    setContent(await f.text());
    setFormat(f.name.endsWith('.json') ? 'json' : 'yaml');
    setResult(null);
  };

  const submit = async (dryRun) => {
    setBusy(true);
    setResult(null);
    try {
      const r = await api(dryRun ? '/admin/timelines/validate' : '/admin/timelines', { method: 'POST', body: { content, format } });
      setResult({ ...r, uploaded: !dryRun });
    } catch (err) {
      setResult(err.data && err.data.errors ? err.data : { valid: false, errors: [{ path: '$', message: err.message }] });
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="page">
      <h1>Admin · Content management</h1>
      <section className="admin-grid">
        <div className="card">
          <h2>Upload a title timeline</h2>
          <p className="muted small">Scene markers, characters, trivia, glossary terms, subtitle lines and pre-approved variation points. Uploads are validated against the schema before anything is saved; uploading an existing title id replaces its timeline (version is bumped).</p>
          <div className="row">
            <input type="file" accept=".yaml,.yml,.json" onChange={onFile} />
            <select value={format} onChange={(e) => setFormat(e.target.value)}>
              <option value="auto">Auto-detect</option>
              <option value="yaml">YAML</option>
              <option value="json">JSON</option>
            </select>
          </div>
          <textarea className="code" rows={18} value={content} onChange={(e) => setContent(e.target.value)} spellCheck={false} />
          <div className="row">
            <button className="btn" disabled={busy} onClick={() => submit(true)}>Validate only</button>
            <button className="btn primary" disabled={busy} onClick={() => submit(false)}>Validate & upload</button>
          </div>
          {result && (result.valid ? (
            <div className="ok-box">
              ✓ {result.uploaded ? `Uploaded ${result.titleId} (timeline v${result.timelineVersion}, ${result.eventCount} events).` : `Valid: ${result.summary.titleId} with ${result.summary.events} events ${JSON.stringify(result.summary.byType)}.`}
            </div>
          ) : (
            <div className="error-box">
              <b>Upload rejected - {result.errors.length} problem(s):</b>
              <ul>{result.errors.map((e, i) => <li key={i}><code>{e.path}</code> {e.message}</li>)}</ul>
            </div>
          ))}
        </div>

        <div className="card">
          <h2>Recommender</h2>
          <p className="muted small">The rail always scores against each user's latest interactions; retraining refreshes the item-item similarity model from all interaction data.</p>
          <button className="btn" onClick={async () => setRetrain(await api('/admin/recommendations/retrain', { method: 'POST' }))}>Retrain now</button>
          {retrain && <pre className="code">{JSON.stringify(retrain, null, 2)}</pre>}
          <h2>Live metrics <button className="btn small ghost" onClick={loadMetrics}>Refresh</button></h2>
          {metrics && (
            <>
              <p className="muted small">Rooms in memory: {metrics.realtime.rooms} · sockets: {metrics.realtime.sockets} · uptime {metrics.uptimeSec}s</p>
              <table className="table small">
                <thead><tr><th>Metric (ms)</th><th>n</th><th>p50</th><th>p95</th><th>max</th></tr></thead>
                <tbody>
                  {Object.entries(metrics.metrics).filter(([k]) => !k.startsWith('route')).map(([k, v]) => (
                    <tr key={k}><td>{k}</td><td>{v.count}</td><td>{v.p50}</td><td>{v.p95}</td><td>{v.max}</td></tr>
                  ))}
                </tbody>
              </table>
            </>
          )}
        </div>
      </section>
    </main>
  );
}
