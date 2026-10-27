// Offline Precision@5 evaluation of the hybrid recommender on the generated interaction dataset.
// Runs without a database: builds the catalog from the same seed sources, generates the same synthetic
// dataset, holds out 5 positive interactions per user, trains on the rest and scores the held-out set.
const fs = require('fs');
const path = require('path');
const { parseTimeline, toTitleDoc } = require('../src/ai/timelineSchema');
const { evaluate, implicitScore } = require('../src/recs/recommender');
const { CATALOG, generateSyntheticInteractions, mulberry32, shuffle } = require('./seedData');

const K = 5;
const HOLDOUT = 5;

function loadCatalog() {
  const dir = path.resolve(__dirname, '../data/timelines');
  const titles = fs.readdirSync(dir).map((f) => toTitleDoc(parseTimeline(fs.readFileSync(path.join(dir, f), 'utf8')).data));
  const V = { ed: 653, fun: 60, blazes: 15, escapes: 15, joy: 15, melt: 15, subaru: 594, gti: 579, bullrun: 47, grand: 609, bbb: 596, sintel: 888 };
  for (const [id, name, year, genres, tags, video] of CATALOG) titles.push({ _id: id, name, year, genres, tags, durationSeconds: V[video] });
  return titles;
}

function run({ seed = 42, users = 60 } = {}) {
  const titles = loadCatalog();
  const durations = Object.fromEntries(titles.map((t) => [t._id, t.durationSeconds]));
  const userIds = Array.from({ length: users }, (_, i) => `u_${i}`);
  const all = generateSyntheticInteractions(userIds, durations, { seed });
  const rnd = mulberry32(seed + 1);

  const testByUser = new Map();
  const train = [];
  for (const u of userIds) {
    const mine = all.filter((i) => i.userId === u);
    const positives = mine.filter((i) => implicitScore(i, durations[i.titleId]) > 0.2);
    const held = new Set(shuffle(positives, rnd).slice(0, HOLDOUT).map((i) => i.titleId));
    testByUser.set(u, held);
    for (const i of mine) if (!held.has(i.titleId)) train.push(i);
  }
  return {
    ...evaluate({ trainInteractions: train, testByUser, titles, k: K }),
    dataset: { users, titles: titles.length, interactions: all.length, trainInteractions: train.length, heldOutPerUser: HOLDOUT, seed },
  };
}

if (require.main === module) {
  const seeds = [42, 7, 1234];
  const runs = seeds.map((seed) => run({ seed }));
  const result = { generatedAt: new Date().toISOString(), metric: `Precision@${K}`, target: 0.6, runs, mean: Math.round((runs.reduce((a, r) => a + r.precisionAtK, 0) / runs.length) * 1000) / 1000 };
  const out = path.resolve(__dirname, '../../docs/evidence/recs-eval.json');
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
}

module.exports = { run };
