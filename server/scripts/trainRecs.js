// Offline/batch retrain of the recommender's item-item model (also available as POST /api/v1/admin/recommendations/retrain).
const { assertConfig } = require('../src/config');
const db = require('../src/db');
const recs = require('../src/recs/service');

(async () => {
  assertConfig();
  await db.connect();
  console.log(await recs.retrain());
  await db.disconnect();
})().catch((e) => { console.error(e); process.exit(1); });
