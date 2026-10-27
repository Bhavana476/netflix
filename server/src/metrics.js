// In-process latency/drift recorder. Keeps a bounded ring of samples per metric and reports percentiles.
const MAX = 5000;
const series = new Map();

function record(name, value) {
  let s = series.get(name);
  if (!s) series.set(name, (s = []));
  s.push(value);
  if (s.length > MAX) s.shift();
}

function percentile(sorted, p) {
  if (!sorted.length) return null;
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, idx)];
}

function summarize(values) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  const round = (v) => (v == null ? null : Math.round(v * 10) / 10);
  return {
    count: sorted.length,
    p50: round(percentile(sorted, 50)),
    p95: round(percentile(sorted, 95)),
    p99: round(percentile(sorted, 99)),
    max: round(sorted[sorted.length - 1] ?? null),
  };
}

function snapshot() {
  const out = {};
  for (const [k, v] of series) out[k] = summarize(v);
  return out;
}

function reset() {
  series.clear();
}

// Express middleware: records per-route latency, grouped under api.* (non-AI) or ai.* (AI endpoints).
function httpLatency(req, res, next) {
  const start = process.hrtime.bigint();
  res.on('finish', () => {
    const ms = Number(process.hrtime.bigint() - start) / 1e6;
    const route = req.route ? req.baseUrl + req.route.path : req.path;
    const isAi = route.includes('/ai/');
    record(isAi ? 'http.ai' : 'http.api', ms);
    record(`route ${req.method} ${route}`, ms);
  });
  next();
}

module.exports = { record, snapshot, reset, summarize, httpLatency };
