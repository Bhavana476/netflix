// Usage: npm run seed            (idempotent: adds missing data)
//        npm run seed -- --reset (wipes all collections first)
// Stop the server first when using the embedded database (it holds a lock on .data/db).
const { assertConfig } = require('../src/config');
const db = require('../src/db');
const { seedAll } = require('./seedData');

(async () => {
  assertConfig();
  await db.connect();
  await seedAll({ reset: process.argv.includes('--reset') });
  await db.disconnect();
  console.log('Seed finished.');
})().catch(async (e) => {
  console.error(e);
  await db.disconnect().catch(() => {});
  process.exit(1);
});
