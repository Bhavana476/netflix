// Seed data: 3 fully authored titles (YAML timelines) + 27 catalog titles, demo accounts, and a
// deterministic synthetic interaction dataset (taste clusters) for training/evaluating the recommender.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { User, Title, Interaction, WatchSpace, SessionEvent, RefreshToken, RecModel } = require('../src/models');
const engine = require('../src/ai/engine');
const log = require('../src/logger');

// Creative Commons Blender open movies on the Internet Archive. The Google sample bucket these
// used to point at now returns 403, so placeholder catalog titles reuse these four films.
const A = 'https://archive.org/download/';
const BBB = [A + 'BigBuckBunny_124/Content/big_buck_bunny_720p_surround.mp4', 596];
const SINTEL = [A + 'Sintel/sintel-2048-surround_512kb.mp4', 888];
const ED = [A + 'ElephantsDream/ed_1024_512kb.mp4', 653];
const TOS = [A + 'Tears-of-Steel/tears_of_steel_720p.mp4', 734];
const VIDEOS = {
  ed: ED,
  fun: BBB,
  blazes: TOS,
  escapes: TOS,
  joy: TOS,
  melt: TOS,
  subaru: ED,
  gti: ED,
  bullrun: SINTEL,
  grand: ED,
  bbb: BBB,
  sintel: SINTEL,
};

// [id, name, year, genres, tags, video, color, synopsis]
const CATALOG = [
  // Cluster A - animation / family / fantasy
  ['t_1004', 'Elephants Dream', 2006, ['Animation', 'Fantasy', 'Surreal'], ['open-movie', 'blender', 'machines'], 'ed', '#6b5b3e', 'Two men explore a vast, strange machine that may only exist in one of their minds.'],
  ['t_1005', 'Paper Lantern Parade', 2021, ['Animation', 'Family'], ['festival', 'friendship'], 'fun', '#c9772b', 'A shy paper lantern dreams of leading the city festival parade.'],
  ['t_1006', 'The Clockwork Fox', 2019, ['Animation', 'Adventure', 'Family'], ['steampunk', 'quest'], 'bbb', '#a0522d', 'A wind-up fox sets out to find the inventor who built her.'],
  ['t_1007', 'Moss & Pebble', 2022, ['Animation', 'Comedy', 'Family'], ['animals', 'friendship'], 'fun', '#5f7f3a', 'Two very small creatures attempt a very big garden adventure.'],
  ['t_1008', 'Sky Whale Lullaby', 2020, ['Animation', 'Fantasy'], ['dreams', 'music'], 'sintel', '#3d5a80', 'A girl rides a whale through the clouds to find the song that will let her sleep.'],
  ['t_1009', 'Tiny Dragon Academy', 2023, ['Animation', 'Fantasy', 'Family'], ['dragons', 'school'], 'sintel', '#8e3b46', 'The smallest dragon in class has the biggest ambitions.'],
  ['t_1010', 'The Acorn Heist', 2018, ['Animation', 'Comedy'], ['animals', 'heist'], 'bbb', '#7b5e3b', 'A crew of squirrels plans the most daring nut robbery the forest has ever seen.'],
  ['t_1011', 'Lighthouse Mouse', 2017, ['Animation', 'Family', 'Adventure'], ['sea', 'animals'], 'fun', '#2a6f97', 'A mouse keeps the lighthouse burning through the worst storm in a century.'],
  // Cluster B - sci-fi / action / thriller
  ['t_1012', 'Neon Meridian', 2024, ['Sci-Fi', 'Thriller'], ['cyberpunk', 'heist'], 'blazes', '#6a0dad', 'A data courier discovers the city grid is rewriting her memories.'],
  ['t_1013', 'Orbital Debt', 2023, ['Sci-Fi', 'Drama'], ['space', 'corporate'], 'escapes', '#264653', 'Stranded miners must pay off their station before the air bill comes due.'],
  ['t_1014', 'Signal Zero', 2022, ['Action', 'Thriller'], ['espionage', 'hackers'], 'joy', '#343a40', 'A burned spy has twelve hours to find who switched off every satellite.'],
  ['t_1015', 'Rust Belt Androids', 2021, ['Sci-Fi', 'Action'], ['robots', 'uprising'], 'melt', '#9c6644', 'Factory androids walk off the line - and keep walking.'],
  ['t_1016', 'The Quiet Reactor', 2020, ['Sci-Fi', 'Thriller'], ['nuclear', 'mystery'], 'blazes', '#1d3557', 'An engineer notices the reactor has started answering back.'],
  ['t_1017', 'Hardline Courier', 2019, ['Action', 'Thriller'], ['chase', 'city'], 'joy', '#b5179e', 'One package, one night, and every gang in the city wants it.'],
  ['t_1018', 'Ninth Lagrange', 2024, ['Sci-Fi', 'Drama'], ['space', 'first-contact'], 'escapes', '#023e8a', 'A lonely relay station picks up a message addressed to its crew by name.'],
  ['t_1019', 'Glass Citadel', 2023, ['Sci-Fi', 'Action'], ['robots', 'siege'], 'melt', '#457b9d', 'The last human city is protected by a dome that is starting to crack.'],
  ['t_1020', 'Blackout Protocol', 2022, ['Action', 'Thriller'], ['espionage', 'cyberpunk'], 'blazes', '#212529', 'When the power grid fails, a security analyst becomes the only one who can see.'],
  // Cluster C - documentary / automotive / travel
  ['t_1021', 'Outback on Street and Dirt', 2014, ['Documentary', 'Automotive'], ['cars', 'off-road'], 'subaru', '#606c38', 'An everyday wagon is put through its paces on pavement and gravel.'],
  ['t_1022', 'GTI: The Review', 2014, ['Automotive', 'Documentary'], ['cars', 'reviews'], 'gti', '#c1121f', 'An in-depth look at a hot hatchback icon.'],
  ['t_1023', 'Going On Bullrun', 2014, ['Automotive', 'Travel'], ['road-trip', 'cars'], 'bullrun', '#fb8500', 'A crew joins a cross-country rally of supercars and characters.'],
  ['t_1024', 'What Car for a Grand?', 2014, ['Automotive', 'Documentary'], ['budget', 'cars'], 'grand', '#588157', 'How far can a thousand dollars go on the used-car market?'],
  ['t_1025', 'Salt Flats Speed Week', 2021, ['Documentary', 'Automotive'], ['racing', 'desert'], 'subaru', '#e9c46a', 'Home-built machines chase records on the salt.'],
  ['t_1026', 'Alpine Passes by Night', 2020, ['Travel', 'Documentary'], ['road-trip', 'mountains'], 'bullrun', '#264653', 'A slow drive over Europe\'s highest roads after dark.'],
  ['t_1027', 'Garage Restoration Diaries', 2022, ['Documentary', 'Automotive'], ['restoration', 'cars'], 'grand', '#bc6c25', 'A rusted classic, a tiny garage, and one very patient mechanic.'],
  ['t_1028', 'Coastal Road Trip: Route 1', 2019, ['Travel', 'Documentary'], ['road-trip', 'sea'], 'gti', '#0077b6', 'Small towns and big views along a famous coastal highway.'],
  ['t_1029', 'Rally School', 2023, ['Automotive', 'Documentary'], ['racing', 'off-road'], 'subaru', '#d62828', 'Beginners learn to drive sideways - on purpose.'],
  ['t_1030', 'Engines of the Desert', 2018, ['Documentary', 'Travel'], ['desert', 'machines'], 'bullrun', '#dda15e', 'The people who keep old trucks alive in the world\'s driest places.'],
];

const CLUSTERS = {
  A: ['t_1001', 't_1002', 't_1004', 't_1005', 't_1006', 't_1007', 't_1008', 't_1009', 't_1010', 't_1011'],
  B: ['t_1003', 't_1012', 't_1013', 't_1014', 't_1015', 't_1016', 't_1017', 't_1018', 't_1019', 't_1020'],
  C: ['t_1021', 't_1022', 't_1023', 't_1024', 't_1025', 't_1026', 't_1027', 't_1028', 't_1029', 't_1030'],
};

function catalogTimeline([id, name, year, genres, tags, video, color, synopsis]) {
  const [url, duration] = VIDEOS[video];
  const third = Math.max(2, Math.round(duration / 3));
  return {
    title: { id, name, year, genres, tags, durationSeconds: duration, videoAssetUrl: url, posterColor: color, synopsis },
    characters: [],
    events: [
      { id: `evt_${id}_1`, ts: 1, type: 'scene', title: 'Opening', text: synopsis },
      { id: `evt_${id}_2`, ts: third, type: 'trivia', text: `${name} is placeholder catalog content for this project, played over a public sample clip.` },
    ],
  };
}

// Deterministic PRNG so the synthetic dataset (and the offline eval) is reproducible.
function mulberry32(seed) {
  return () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const shuffle = (arr, rnd) => {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
};

/**
 * Synthetic users with a latent taste cluster. Each user positively engages with 9 of the 10 titles in their
 * cluster, abandons 2 titles from other clusters (low completion, low rating) and sometimes enjoys 1 outsider.
 */
function generateSyntheticInteractions(userIds, durations, { seed = 42 } = {}) {
  const rnd = mulberry32(seed);
  const keys = Object.keys(CLUSTERS);
  const out = [];
  userIds.forEach((userId, idx) => {
    const cluster = keys[idx % keys.length];
    const others = keys.filter((k) => k !== cluster).flatMap((k) => CLUSTERS[k]);
    const liked = shuffle(CLUSTERS[cluster], rnd).slice(0, 9);
    const disliked = shuffle(others, rnd).slice(0, 2);
    const bonus = rnd() < 0.4 ? shuffle(others.filter((t) => !disliked.includes(t)), rnd).slice(0, 1) : [];
    const base = Date.now() - 60 * 86400000;
    let n = 0;
    const push = (titleId, completion, rating) => {
      const d = durations[titleId];
      out.push({ userId, titleId, watchedSeconds: Math.round(d * completion), completed: completion >= 0.9, rating, source: 'synthetic', coWatchedWith: [], createdAt: new Date(base + n++ * 3600000 + idx * 1000) });
    };
    for (const t of liked) push(t, 0.75 + rnd() * 0.25, rnd() < 0.7 ? (rnd() < 0.6 ? 5 : 4) : null);
    for (const t of disliked) push(t, 0.05 + rnd() * 0.2, rnd() < 0.6 ? (rnd() < 0.5 ? 1 : 2) : null);
    for (const t of bonus) push(t, 0.6 + rnd() * 0.4, rnd() < 0.5 ? 4 : null);
    // Co-watch pattern: pair users from the same cluster on one shared title.
    if (idx >= keys.length) {
      const partner = userIds[idx - keys.length];
      const last = out[out.length - 1 - disliked.length - bonus.length];
      last.coWatchedWith = [partner];
    }
  });
  return out;
}

function seedPassword(envKey, label) {
  if (process.env[envKey]) return process.env[envKey];
  const pw = crypto.randomBytes(9).toString('base64url');
  log.warn(`${envKey} not set - generated a random password for ${label}`, { account: label, password: pw });
  console.log(`\n  ${label} password (generated, set ${envKey} in .env to fix it): ${pw}\n`);
  return pw;
}

async function seedAll({ reset = false, syntheticUsers = 60 } = {}) {
  if (reset) {
    await Promise.all([User, Title, Interaction, WatchSpace, SessionEvent, RefreshToken, RecModel].map((M) => M.deleteMany({})));
  }

  // Titles: every one goes through the same validation pipeline as an admin upload.
  const dir = path.resolve(__dirname, '../data/timelines');
  for (const f of fs.readdirSync(dir).filter((x) => /\.ya?ml$|\.json$/.test(x))) {
    const r = await engine.ingestTimeline(fs.readFileSync(path.join(dir, f), 'utf8'));
    if (!r.valid) throw new Error(`Seed timeline ${f} invalid: ${JSON.stringify(r.errors)}`);
  }
  for (const row of CATALOG) {
    const r = await engine.ingestTimeline(catalogTimeline(row), 'json');
    if (!r.valid) throw new Error(`Catalog title ${row[0]} invalid: ${JSON.stringify(r.errors)}`);
  }

  // Demo accounts.
  const accounts = [
    { email: 'admin@watchspaces.local', displayName: 'Ada (Admin)', role: 'admin', pw: ['SEED_ADMIN_PASSWORD', 'admin'] },
    { email: 'host@watchspaces.local', displayName: 'Hana (Host)', role: 'host', pw: ['SEED_HOST_PASSWORD', 'host'] },
    { email: 'viewer@watchspaces.local', displayName: 'Vik (Viewer)', role: 'viewer', pw: ['SEED_VIEWER_PASSWORD', 'viewer'], prefs: { subtitleLocale: 'es' } },
    { email: 'viewer2@watchspaces.local', displayName: 'Mo (Viewer)', role: 'viewer', pw: ['SEED_VIEWER_PASSWORD', 'viewer2'] },
  ];
  const pwCache = {};
  const demo = {};
  for (const a of accounts) {
    let user = await User.findOne({ email: a.email });
    if (!user) {
      pwCache[a.pw[0]] = pwCache[a.pw[0]] || seedPassword(a.pw[0], a.pw[1]);
      user = await User.create({ email: a.email, displayName: a.displayName, role: a.role, passwordHash: await bcrypt.hash(pwCache[a.pw[0]], 10), preferences: a.prefs || {} });
    }
    demo[a.pw[1]] = user;
  }

  // Synthetic users + interactions (only if not already generated).
  const durations = Object.fromEntries((await Title.find({}, { durationSeconds: 1 }).lean()).map((t) => [t._id, t.durationSeconds]));
  if (!(await Interaction.exists({ source: 'synthetic' }))) {
    const unusable = await bcrypt.hash(crypto.randomBytes(24).toString('hex'), 4);
    const users = await User.insertMany(
      Array.from({ length: syntheticUsers }, (_, i) => ({ email: `synthetic_${String(i).padStart(3, '0')}@example.test`, displayName: `Synthetic ${i}`, role: 'viewer', passwordHash: unusable, synthetic: true }))
    );
    await Interaction.insertMany(generateSyntheticInteractions(users.map((u) => u._id), durations));
  }
  // Demo viewer has an animation-leaning history so the rail is visibly personalised.
  if (!(await Interaction.exists({ userId: demo.viewer._id }))) {
    await Interaction.insertMany([
      { userId: demo.viewer._id, titleId: 't_1001', watchedSeconds: 596, completed: true, rating: 5, source: 'rating' },
      { userId: demo.viewer._id, titleId: 't_1004', watchedSeconds: 500, completed: false, rating: 4, source: 'rating' },
      { userId: demo.viewer._id, titleId: 't_1013', watchedSeconds: 2, completed: false, rating: 2, source: 'rating' },
    ]);
  }
  await require('../src/recs/service').retrain();
  log.info('seed complete', { titles: await Title.countDocuments(), interactions: await Interaction.countDocuments() });
  return demo;
}

module.exports = { seedAll, generateSyntheticInteractions, CLUSTERS, CATALOG, mulberry32, shuffle };
