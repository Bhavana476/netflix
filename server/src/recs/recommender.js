// Hybrid recommender: content-based (genre/tag profile) + item-item collaborative filtering.
// The CF similarity matrix is trained in batch; per-user scoring always reads the user's *latest*
// interactions, so the rail reacts to new activity without a retrain.

/** Implicit preference in [-1, 1] from rating, completion and co-watching. */
function implicitScore(i, durationSeconds) {
  const completion = durationSeconds ? Math.min(1, (i.watchedSeconds || 0) / durationSeconds) : 0;
  let s = completion * 0.6 + (i.completed ? 0.2 : 0) - 0.3;
  if (i.rating) s += ((i.rating - 3) / 2) * 0.7;
  if (i.coWatchedWith && i.coWatchedWith.length) s += 0.1;
  return Math.max(-1, Math.min(1, s));
}

/** Collapses multiple interactions per (user, title) into one score (strongest signal wins). */
function userItemScores(interactions, titlesById) {
  const users = new Map();
  for (const i of interactions) {
    const t = titlesById.get(String(i.titleId));
    if (!t) continue;
    const u = String(i.userId);
    if (!users.has(u)) users.set(u, new Map());
    const m = users.get(u);
    const s = implicitScore(i, t.durationSeconds);
    const prev = m.get(t._id);
    m.set(t._id, prev === undefined ? s : Math.abs(s) > Math.abs(prev) ? s : prev);
  }
  return users;
}

function contentVector(t) {
  const v = {};
  for (const g of t.genres || []) v[`g:${g.toLowerCase()}`] = 1;
  for (const tag of t.tags || []) v[`t:${tag.toLowerCase()}`] = 0.5;
  return v;
}

function cosine(a, b) {
  let dot = 0, na = 0, nb = 0;
  for (const k in a) { na += a[k] * a[k]; if (k in b) dot += a[k] * b[k]; }
  for (const k in b) nb += b[k] * b[k];
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}

/** Batch training: item-item cosine similarity over positive user preferences, top-N neighbours per item. */
function train(interactions, titles, { neighbors = 20 } = {}) {
  const titlesById = new Map(titles.map((t) => [t._id, t]));
  const users = userItemScores(interactions, titlesById);
  const itemVecs = new Map(); // titleId -> { userId: score }
  const popularity = {};
  for (const [u, m] of users) {
    for (const [tid, s] of m) {
      if (s <= 0) continue;
      if (!itemVecs.has(tid)) itemVecs.set(tid, {});
      itemVecs.get(tid)[u] = s;
      popularity[tid] = (popularity[tid] || 0) + s;
    }
  }
  const ids = [...itemVecs.keys()];
  const sims = {};
  for (const a of ids) {
    const row = [];
    for (const b of ids) if (a !== b) {
      const s = cosine(itemVecs.get(a), itemVecs.get(b));
      if (s > 0) row.push([b, Math.round(s * 1000) / 1000]);
    }
    row.sort((x, y) => y[1] - x[1]);
    sims[a] = Object.fromEntries(row.slice(0, neighbors));
  }
  const maxPop = Math.max(1, ...Object.values(popularity));
  for (const k in popularity) popularity[k] = Math.round((popularity[k] / maxPop) * 1000) / 1000;
  return { sims, popularity, users: users.size, items: ids.length, interactions: interactions.length };
}

/**
 * Ranked rail for one user. userInteractions are the user's current interactions (not the training snapshot).
 * Returns [{ titleId, score, cf, cb, reason }].
 */
function recommend({ userInteractions, titles, model, k = 10, genreAffinity = [], excludeSeen = true }) {
  const titlesById = new Map(titles.map((t) => [t._id, t]));
  const mine = userItemScores(userInteractions, titlesById).values().next().value || new Map();
  const vecs = new Map(titles.map((t) => [t._id, contentVector(t)]));

  // Content profile: preference-weighted sum of watched titles' vectors (+ declared genre affinity).
  const profile = {};
  for (const [tid, s] of mine) for (const [f, w] of Object.entries(vecs.get(tid) || {})) profile[f] = (profile[f] || 0) + s * w;
  for (const g of genreAffinity) profile[`g:${g.toLowerCase()}`] = (profile[`g:${g.toLowerCase()}`] || 0) + 0.5;

  const n = [...mine.values()].filter((s) => s > 0).length;
  const alpha = Math.min(0.75, (n / 6) * 0.75); // CF weight grows with history; cold-start leans on content/popularity
  const sims = (model && model.sims) || {};
  const pop = (model && model.popularity) || {};

  const out = [];
  for (const t of titles) {
    if (excludeSeen && mine.has(t._id)) continue;
    let num = 0, den = 0, best = null;
    for (const [j, s] of mine) {
      const sim = (sims[j] && sims[j][t._id]) || (sims[t._id] && sims[t._id][j]) || 0;
      if (!sim) continue;
      num += sim * s;
      den += Math.abs(sim);
      if (s > 0 && (!best || sim * s > best.w)) best = { titleId: j, w: sim * s };
    }
    const cf = den ? num / den : 0;
    const cb = Object.keys(profile).length ? cosine(profile, vecs.get(t._id)) : 0;
    const score = alpha * cf + (1 - alpha) * cb + 0.08 * (pop[t._id] || 0);
    let reason;
    if (best && alpha * cf >= (1 - alpha) * cb) reason = `Because you watched ${titlesById.get(best.titleId).name}`;
    else if (cb > 0) {
      const top = (t.genres || []).find((g) => (profile[`g:${g.toLowerCase()}`] || 0) > 0);
      reason = top ? `Matches your taste in ${top}` : 'Similar to titles you enjoyed';
    } else reason = 'Popular with other viewers';
    out.push({ titleId: t._id, score: Math.round(score * 1000) / 1000, cf: Math.round(cf * 1000) / 1000, cb: Math.round(cb * 1000) / 1000, reason });
  }
  return out.sort((a, b) => b.score - a.score || (a.titleId < b.titleId ? -1 : 1)).slice(0, k);
}

/** Offline evaluation: Precision@k over a per-user held-out set of positive interactions. */
function evaluate({ trainInteractions, testByUser, titles, k = 5 }) {
  const model = train(trainInteractions, titles);
  const trainByUser = new Map();
  for (const i of trainInteractions) {
    const u = String(i.userId);
    if (!trainByUser.has(u)) trainByUser.set(u, []);
    trainByUser.get(u).push(i);
  }
  const perUser = [];
  for (const [u, held] of testByUser) {
    if (!held.size) continue;
    const recs = recommend({ userInteractions: trainByUser.get(u) || [], titles, model, k });
    const hits = recs.filter((r) => held.has(r.titleId)).length;
    perUser.push(hits / k);
  }
  const mean = perUser.reduce((a, b) => a + b, 0) / (perUser.length || 1);
  return { k, users: perUser.length, precisionAtK: Math.round(mean * 1000) / 1000, model: { users: model.users, items: model.items } };
}

module.exports = { implicitScore, train, recommend, evaluate, contentVector, cosine };
