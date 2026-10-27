// Reuse the mongod binary that `npm install` already downloaded (mongodb-memory-server postinstall),
// so the embedded DB never re-downloads a ~600 MB archive at startup.
const fs = require('fs');
const os = require('os');
const path = require('path');

function useCachedMongoBinary() {
  if (process.env.MONGOMS_SYSTEM_BINARY) return;
  const dirs = [
    path.resolve(__dirname, '../../node_modules/.cache/mongodb-memory-server'),
    path.resolve(__dirname, '../node_modules/.cache/mongodb-memory-server'),
    path.join(os.homedir(), '.cache', 'mongodb-binaries'),
  ];
  for (const dir of dirs) {
    if (!fs.existsSync(dir)) continue;
    const bin = fs.readdirSync(dir).find((f) => /^mongod-.*?(\.exe)?$/.test(f) && fs.statSync(path.join(dir, f)).size > 10e6);
    if (bin) {
      process.env.MONGOMS_SYSTEM_BINARY = path.join(dir, bin);
      process.env.MONGOMS_VERSION = process.env.MONGOMS_VERSION || (bin.match(/(\d+\.\d+\.\d+)/) || [])[1] || '';
      if (!process.env.MONGOMS_VERSION) delete process.env.MONGOMS_VERSION;
      return;
    }
  }
}

module.exports = { useCachedMongoBinary };
