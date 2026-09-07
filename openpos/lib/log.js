'use strict';
// ---------------------------------------------------------------------------
// log.js — structured logging (Phase 32).
//
// A shop's till does not have an ops team. So a log line has to be readable by
// a human at the counter AND greppable by whoever is asked "what happened at
// 6pm on Tuesday": one JSON object per line, with a request id that ties every
// line of one request together. Errors are counted, not just printed.
// ---------------------------------------------------------------------------

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };

const state = {
  level: process.env.OPENPOS_LOG_LEVEL ? LEVELS[process.env.OPENPOS_LOG_LEVEL] || LEVELS.info : LEVELS.info,
  counts: { total: 0, errors: 0, byStatus: {}, byRoute: {}, slow: 0 },
  ring: [],           // the last N lines, so /api/admin/metrics can show them
  startedAt: new Date().toISOString()
};

function write(level, msg, fields = {}, force = false) {
  const line = {
    ts: new Date().toISOString(),
    level,
    msg: String(msg),
    ...fields
  };
  state.counts.total++;
  if (level === 'error') state.counts.errors++;
  state.ring.push(line);
  if (state.ring.length > 200) state.ring.shift();
  // Counters and the ring buffer always fill; printing is what the level
  // controls — a till does not need its console narrating every request.
  if (!force && LEVELS[level] < state.level) return line;
  const out = JSON.stringify(line);
  if (level === 'error' || level === 'warn') console.error(out);
  else console.log(out);
  return line;
}

const logger = {
  debug: (m, f) => write('debug', m, f),
  info: (m, f) => write('info', m, f),
  warn: (m, f) => write('warn', m, f),
  error: (m, f) => write('error', m, f),
  /** The line a request deserves: one object, one id, one duration. */
  request: (req, res, ms, extra = {}) => {
    const route = (req.route && req.route.path) || req.path || req.url || '';
    const status = res.statusCode || 0;
    state.counts.byStatus[status] = (state.counts.byStatus[status] || 0) + 1;
    const key = `${req.method || 'GET'} ${route}`;
    state.counts.byRoute[key] = state.counts.byRoute[key] || { n: 0, ms_total: 0, ms_max: 0, errors: 0 };
    const r = state.counts.byRoute[key];
    r.n++;
    r.ms_total += ms;
    r.ms_max = Math.max(r.ms_max, ms);
    if (status >= 500) r.errors++;
    if (ms > 1000) state.counts.slow++;
    const loud = status >= 400 || ms > 1000;
    return write(status >= 500 ? 'error' : (status >= 400 ? 'warn' : 'debug'), 'request', {
      rid: req.id || null,
      method: req.method, route, status, ms: Math.round(ms),
      user: (req.user && (req.user.name || req.user.id)) || null,
      ip: (req.headers && req.headers['x-forwarded-for']) || (req.socket && req.socket.remoteAddress) || null,
      ...extra
    }, loud);
  },
  metrics: () => ({
    started_at: state.startedAt,
    uptime_s: Math.round((Date.now() - new Date(state.startedAt).getTime()) / 1000),
    log_lines: state.counts.total,
    errors: state.counts.errors,
    slow_requests: state.counts.slow,
    requests_by_status: state.counts.byStatus,
    routes: Object.entries(state.counts.byRoute)
      .map(([route, r]) => ({ route, n: r.n, avg_ms: Math.round(r.ms_total / r.n), max_ms: Math.round(r.ms_max), errors: r.errors }))
      .sort((a, b) => b.n - a.n)
      .slice(0, 20)
  }),
  recent: (n = 50) => state.ring.slice(-n),
  reset: () => {
    state.counts = { total: 0, errors: 0, byStatus: {}, byRoute: {}, slow: 0 };
    state.ring = [];
  }
};

/** Give every request an id, and log it once, at the end. */
function requestLogger(app) {
  let seq = 0;
  app.use((req, res, next) => {
    req.id = `r${Date.now().toString(36)}${(seq++).toString(36)}`;
    const t0 = process.hrtime.bigint();
    res.on('finish', () => {
      const ms = Number(process.hrtime.bigint() - t0) / 1e6;
      logger.request(req, res, ms);
    });
    next();
  });
  return app;
}

module.exports = { logger, requestLogger, LEVELS };
