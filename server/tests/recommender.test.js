const { train, recommend, implicitScore } = require('../src/recs/recommender');
const { run } = require('../scripts/evalRecs');

const titles = [
  { _id: 'a1', name: 'A1', genres: ['Animation'], tags: ['family'], durationSeconds: 100 },
  { _id: 'a2', name: 'A2', genres: ['Animation'], tags: ['family'], durationSeconds: 100 },
  { _id: 'a3', name: 'A3', genres: ['Animation'], tags: [], durationSeconds: 100 },
  { _id: 's1', name: 'S1', genres: ['Sci-Fi'], tags: ['robots'], durationSeconds: 100 },
  { _id: 's2', name: 'S2', genres: ['Sci-Fi'], tags: ['robots'], durationSeconds: 100 },
];
const like = (userId, titleId) => ({ userId, titleId, watchedSeconds: 100, completed: true, rating: 5 });

test('implicit score: completion + high rating is positive, abandonment + low rating negative', () => {
  expect(implicitScore(like('u', 'a1'), 100)).toBeGreaterThan(0.5);
  expect(implicitScore({ watchedSeconds: 5, rating: 1 }, 100)).toBeLessThan(0);
});

test('collaborative signal: users who liked a1 also liked a2', () => {
  const data = [like('u1', 'a1'), like('u1', 'a2'), like('u2', 'a1'), like('u2', 'a2'), like('u3', 's1'), like('u3', 's2')];
  const model = train(data, titles);
  const recs = recommend({ userInteractions: [like('me', 'a1')], titles, model, k: 3 });
  expect(recs[0].titleId).toBe('a2');
  expect(recs.find((r) => r.titleId === 'a1')).toBeUndefined(); // seen items excluded
  expect(recs[0].reason).toMatch(/A1|Animation/);
});

test('rail reacts to new interactions without retraining', () => {
  const model = train([like('u1', 's1'), like('u1', 's2')], titles);
  const before = recommend({ userInteractions: [], titles, model, k: 5, genreAffinity: [] });
  const after = recommend({ userInteractions: [like('me', 's1')], titles, model, k: 5 });
  expect(after[0].titleId).toBe('s2');
  expect(after.map((r) => r.titleId)).not.toEqual(before.map((r) => r.titleId));
});

test('cold start uses declared genre affinity', () => {
  const model = train([], titles);
  const recs = recommend({ userInteractions: [], titles, model, k: 2, genreAffinity: ['Sci-Fi'] });
  expect(recs.map((r) => r.titleId).sort()).toEqual(['s1', 's2']);
});

test('offline Precision@5 on the generated dataset meets the >= 0.6 target', () => {
  const r = run({ seed: 42 });
  expect(r.users).toBe(60);
  expect(r.precisionAtK).toBeGreaterThanOrEqual(0.6);
});
