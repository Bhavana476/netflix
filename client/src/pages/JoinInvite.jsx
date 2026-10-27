import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { api } from '../api';

export default function JoinInvite() {
  const { code } = useParams();
  const nav = useNavigate();
  const [error, setError] = useState('');
  useEffect(() => {
    api('/watch-spaces/join', { method: 'POST', body: { inviteCode: code } })
      .then((r) => nav(`/room/${r.watchSpaceId}`, { replace: true }))
      .catch((e) => setError(e.message));
  }, [code, nav]);
  return <div className="page center">{error ? <div className="error">{error}</div> : <p>Joining {code}…</p>}</div>;
}
