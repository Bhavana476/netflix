import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api, fmtTime } from '../api';

const ROWS = [
  ['durationSeconds', 'Duration', fmtTime],
  ['peakParticipants', 'Peak concurrent participants'],
  ['aiQuestions', 'AI questions asked'],
  ['triviaSurfaced', 'Trivia cards surfaced'],
  ['chatMessages', 'Chat messages'],
  ['reactions', 'Reactions'],
];

export default function SessionDetail() {
  const { id } = useParams();
  const [a, setA] = useState(null);
  const [error, setError] = useState('');
  useEffect(() => {
    api(`/watch-spaces/${id}/analytics`).then(setA).catch((e) => setError(e.message));
  }, [id]);
  if (error) return <main className="page"><div className="error">{error}</div></main>;
  if (!a) return <main className="page">Loading…</main>;
  return (
    <main className="page narrow">
      <Link to="/">← Back</Link>
      <h1>Session analytics</h1>
      <p className="muted">
        Stored summary vs. a fresh recount of the raw event log ({a.fromEventLog.totalEvents} events).{' '}
        {a.reconciles === null ? 'Session has not ended yet.' : a.reconciles ? <b className="ok">✓ Reconciles exactly</b> : <b className="error">✗ Mismatch</b>}
      </p>
      <table className="table">
        <thead><tr><th>Metric</th><th>Stored summary</th><th>Recomputed from log</th></tr></thead>
        <tbody>
          {ROWS.map(([k, label, f]) => (
            <tr key={k}>
              <td>{label}</td>
              <td>{a.summary ? (f ? f(a.summary[k]) : a.summary[k]) : '-'}</td>
              <td>{f ? f(a.fromEventLog[k]) : a.fromEventLog[k]}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <h3>Event log breakdown</h3>
      <pre className="code">{JSON.stringify(a.fromEventLog.eventCounts, null, 2)}</pre>
    </main>
  );
}
