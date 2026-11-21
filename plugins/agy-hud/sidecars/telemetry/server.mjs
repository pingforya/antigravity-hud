import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

/**
 * agy-hud telemetry sidecar.
 *
 * Security model:
 * - Listens ONLY on the sidecar port assigned by Antigravity (ANTIGRAVITY_SIDECAR_WEB_PORT),
 *   bound to 127.0.0.1. The former fixed "bridge" port 53991 has been removed: the in-app
 *   HUD talks to the Electron main process over IPC instead.
 * - No CORS headers: only the same-origin sidecar UI (ui.html) can read responses, so web
 *   pages opened in a browser cannot fetch conversation telemetry/thinking text.
 * - Host header must be a loopback name (blocks DNS-rebinding).
 *
 * Performance:
 * - Polls only while at least one SSE client is connected, and the parser caches results
 *   on transcript size+mtime, so idle cost is ~zero.
 */

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const parser = require('../../scripts/telemetry-parser.cjs');
const personaMode = require('../../scripts/persona-mode.cjs');

const SIDECAR_PORT = parseInt(process.env.ANTIGRAVITY_SIDECAR_WEB_PORT || '0', 10);
const LS_ADDRESS = String(process.env.ANTIGRAVITY_LS_ADDRESS || '').trim();
const UI_HTML_PATH = path.join(__dirname, 'ui.html');
const POLL_MS = 1000;
const LS_WATCH_MS = 5000;
const MAX_SSE_CLIENTS = 2;
const SSE_MAX_LIFETIME_MS = 25000;

const ALLOWED_HOSTNAMES = new Set(['127.0.0.1', 'localhost']);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

let cachedPreloadKey = null;
let cachedPreloadJs = null;
function getPreloadScript() {
  const customPreload = String(process.env.AGY_SIDECAR_PRELOAD_PATH || '').trim();
  if (customPreload === 'none') {
    return 'window.__sidecarReady = true;\n';
  }
  const appDataDir = String(process.env.ANTIGRAVITY_APP_DATA_DIR || '').trim();
  const cacheKey = `${customPreload}|${appDataDir}`;
  if (cachedPreloadJs !== null && cachedPreloadKey === cacheKey) {
    return cachedPreloadJs;
  }
  const candidates = [];
  if (customPreload) {
    candidates.push(path.resolve(customPreload));
  }
  if (appDataDir) {
    candidates.push(path.join(appDataDir, 'lib', 'node_modules', 'sidecar_sdk', 'preload.js'));
  }
  const home = os.homedir();
  candidates.push(
    path.join(home, '.gemini', 'antigravity', 'lib', 'node_modules', 'sidecar_sdk', 'preload.js'),
    path.join(home, '.gemini', 'antigravity-cli', 'lib', 'node_modules', 'sidecar_sdk', 'preload.js'),
    path.join(home, '.gemini', 'antigravity-ide', 'lib', 'node_modules', 'sidecar_sdk', 'preload.js')
  );
  for (const p of candidates) {
    try {
      if (fs.existsSync(p)) {
        const sdkJs = fs.readFileSync(p, 'utf8');
        if (sdkJs.trim()) {
          cachedPreloadKey = cacheKey;
          cachedPreloadJs = sdkJs + '\nwindow.__sidecarReady = true;\n';
          return cachedPreloadJs;
        }
      }
    } catch (_) {}
  }
  cachedPreloadKey = cacheKey;
  cachedPreloadJs = 'window.__sidecarReady = true;\n';
  return cachedPreloadJs;
}

/** client -> { convId, lastSig } */
const sseClients = new Map();
let pollTimer = null;

function resolveConvId(requestedConvId) {
  if (typeof requestedConvId === 'string' && requestedConvId.length > 0) {
    const trimmed = requestedConvId.trim();
    return UUID_RE.test(trimmed) ? trimmed : '';
  }
  const envId = String(process.env.ANTIGRAVITY_CONVERSATION_ID || '').trim();
  if (envId && UUID_RE.test(envId)) return envId;
  return parser.findLatestConversationId() || '';
}

function getLiveSnapshot(requestedConvId) {
  const bp = typeof parser.getBackendPatchStatus === 'function' ? parser.getBackendPatchStatus() : null;
  const dailyUsage = typeof parser.getDailyModelUsage === 'function' ? parser.getDailyModelUsage() : null;
  const defaultLim = (bp && bp.patched && bp.contextLimit) ? bp.contextLimit : 256000;
  const hasExplicitConvId = typeof requestedConvId === 'string' && requestedConvId.length > 0;
  const convId = resolveConvId(requestedConvId);
  if (!convId) {
    const errCode = hasExplicitConvId ? 'invalid_conversation_id' : 'no_active_conversation';
    return { error: errCode, contextLimit: defaultLim, backendPatch: bp, dailyUsage, steps: [], topConsumers: [] };
  }
  const data = parser.parseConversationTelemetry(convId);
  if (data) {
    return Object.assign({}, data, { dailyUsage });
  }
  return { conversationId: convId, contextLimit: defaultLim, backendPatch: bp, dailyUsage, steps: [], topConsumers: [] };
}

function snapshotSig(snap) {
  const todayKey = snap && snap.dailyUsage && snap.dailyUsage.todayKey ? snap.dailyUsage.todayKey : '';
  const dailyTotal = snap && snap.dailyUsage && snap.dailyUsage.today ? snap.dailyUsage.today.totalTokens : 0;
  const genIdx = snap && snap.dbMeta && snap.dbMeta.genIdx != null ? snap.dbMeta.genIdx : '';
  const idOrErr = (snap && (snap.conversationId || snap.error)) || '';
  return `${idOrErr}:${snap.updatedAt}:${snap.stepCount}:${snap.currentContext}:${snap.contextLimit}:${snap.compactionCount}:${snap.latestTokPerSec}:${genIdx}:${todayKey}:${dailyTotal}`;
}

const UI_CSP = "default-src 'self'; connect-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-src 'none'";

function dropSseClient(res, state, endSocket) {
  if (state && typeof state.drop === 'function') {
    state.drop();
  } else {
    sseClients.delete(res);
  }
  if (endSocket) {
    try { res.end(); } catch (_) {}
  }
}

function pollAndBroadcast() {
  for (const [res, state] of sseClients) {
    if (res.writableEnded || res.destroyed) {
      dropSseClient(res, state, false);
      continue;
    }
    try {
      const snap = getLiveSnapshot(state.convId);
      const sig = snapshotSig(snap);
      if (sig !== state.lastSig) {
        state.lastSig = sig;
        res.write(`data: ${JSON.stringify(snap)}\n\n`);
      }
    } catch (_) {
      dropSseClient(res, state, true);
    }
  }
  if (sseClients.size === 0) stopPolling();
}

function startPolling() {
  if (pollTimer) return;
  pollTimer = setInterval(pollAndBroadcast, POLL_MS);
  pollTimer.unref();
}

function stopPolling() {
  if (!pollTimer) return;
  clearInterval(pollTimer);
  pollTimer = null;
}

function isValidPortStr(portStr) {
  if (!/^\d{1,5}$/.test(portStr)) return false;
  const n = Number(portStr);
  return n >= 1 && n <= 65535;
}

function isAllowedHost(req) {
  const host = String(req.headers.host || '').trim().toLowerCase();
  if (!host) return false;
  if (host.startsWith('[')) {
    if (host === '[::1]') return true;
    if (host.startsWith('[::1]:')) {
      return isValidPortStr(host.slice('[::1]:'.length));
    }
    return false;
  }
  const colonIdx = host.indexOf(':');
  if (colonIdx !== -1) {
    const name = host.slice(0, colonIdx);
    const portStr = host.slice(colonIdx + 1);
    return isValidPortStr(portStr) && ALLOWED_HOSTNAMES.has(name);
  }
  return ALLOWED_HOSTNAMES.has(host);
}

/**
 * API token validation:
 * - Explicit `AGY_HUD_SIDECAR_TOKEN` or `ANTIGRAVITY_SIDECAR_TOKEN` enforces constant-time token
 *   auth on ALL `/api/*` requests (GET and POST) for standalone / custom-token deployments.
 * - Host-injected `ANTIGRAVITY_SIDECAR_UI_TOKEN` is intentionally NOT enforced on GET/HEAD:
 *   Antigravity's outer Go reverse proxy (`gateway.go`) already validates `ANTIGRAVITY_SIDECAR_UI_TOKEN`
 *   via its `HttpOnly` session cookie (`agy_sidecar_<id>`) and strips `?token=` on subsequent
 *   proxied `/api/*` GETs. However, matching official `sidecar_sdk`, when `ANTIGRAVITY_SIDECAR_UI_TOKEN`
 *   is set we DO enforce it on state-mutating requests (`req.method !== 'GET' && req.method !== 'HEAD'`,
 *   e.g. `POST /api/persona`) so local processes cannot forge state changes directly against localhost.
 */
function isAuthorizedApiRequest(req, url) {
  const strictToken = String(process.env.AGY_HUD_SIDECAR_TOKEN || process.env.ANTIGRAVITY_SIDECAR_TOKEN || '');
  const uiToken = String(process.env.ANTIGRAVITY_SIDECAR_UI_TOKEN || '');
  const isReadMethod = req.method === 'GET' || req.method === 'HEAD';
  const expected = strictToken || (!isReadMethod ? uiToken : '');
  if (!expected) return true;
  const rawHeader = req.headers['x-sidecar-token'];
  const headerTok = Array.isArray(rawHeader) ? rawHeader[0] : rawHeader;
  const candidate = (typeof headerTok === 'string' && headerTok.length > 0)
    ? headerTok
    : (url.searchParams.get('token') || '');
  if (!candidate) return false;
  const expectedBuf = Buffer.from(expected, 'utf8');
  const candidateBuf = Buffer.from(candidate, 'utf8');
  if (expectedBuf.length !== candidateBuf.length) return false;
  return crypto.timingSafeEqual(expectedBuf, candidateBuf);
}

function handleHttpRequest(req, res) {
  if (!isAllowedHost(req)) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8', 'X-Content-Type-Options': 'nosniff' });
    res.end('Forbidden');
    return;
  }

  let url;
  try {
    url = new URL(req.url || '/', 'http://127.0.0.1');
  } catch (_) {
    res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8', 'X-Content-Type-Options': 'nosniff' });
    res.end('Bad Request');
    return;
  }

  if (url.pathname === '/_sidecar/get-conversation-metadata') {
    if (req.method !== 'GET' && req.method !== 'POST') {
      res.writeHead(405, {
        'Content-Type': 'text/plain; charset=utf-8',
        'Allow': 'GET, POST',
        'X-Content-Type-Options': 'nosniff'
      });
      res.end('Method Not Allowed');
      return;
    }
    req.resume();
    res.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff'
    });
    res.end('{}');
    return;
  }

  if (url.pathname.startsWith('/api/') && !isAuthorizedApiRequest(req, url)) {
    res.writeHead(401, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff'
    });
    res.end(JSON.stringify({ error: 'Unauthorized' }));
    return;
  }

  if (personaMode.handleRequest(req, res, url)) return;

  if (req.method !== 'GET') {
    res.writeHead(405, { 'Content-Type': 'text/plain; charset=utf-8', 'X-Content-Type-Options': 'nosniff' });
    res.end('Method Not Allowed');
    return;
  }

  const convId = url.searchParams.get('conversationId') || '';

  if (url.pathname === '/api/hud/live') {
    const snap = getLiveSnapshot(convId);
    const sig = snapshotSig(snap);
    if (snap && snap.error === 'invalid_conversation_id') {
      const payload = Object.assign({}, snap, { sig });
      res.writeHead(400, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff'
      });
      res.end(JSON.stringify(payload));
      return;
    }
    const since = url.searchParams.get('since') || '';
    const inm = String(req.headers['if-none-match'] || '').replace(/^"|"$/g, '');
    if ((since && since === sig) || (inm && inm === sig)) {
      res.writeHead(304, {
        'Cache-Control': 'no-store',
        'ETag': `"${sig}"`,
        'X-Content-Type-Options': 'nosniff'
      });
      res.end();
      return;
    }
    const payload = Object.assign({}, snap, { sig });
    res.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'ETag': `"${sig}"`,
      'X-Content-Type-Options': 'nosniff'
    });
    res.end(JSON.stringify(payload));
    return;
  }

  if (url.pathname === '/api/hud/daily') {
    res.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff'
    });
    const daily = typeof parser.getDailyModelUsage === 'function' ? parser.getDailyModelUsage() : null;
    res.end(JSON.stringify(daily || { error: 'unsupported' }));
    return;
  }

  if (url.pathname === '/api/hud/stream') {
    // Cap concurrent SSE streams well below Chromium's 6-socket-per-origin HTTP/1.1 limit
    // so multi-conversation prewarmed iframes can never starve /ui.html or /api/persona.
    while (sseClients.size >= MAX_SSE_CLIENTS) {
      const oldestEntry = sseClients.entries().next().value;
      if (!oldestEntry) break;
      const [oldestRes, oldestState] = oldestEntry;
      dropSseClient(oldestRes, oldestState, true);
    }
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
      'X-Content-Type-Options': 'nosniff'
    });
    let dropped = false;
    let maxLife = null;
    function drop() {
      if (dropped) return;
      dropped = true;
      if (maxLife) clearTimeout(maxLife);
      sseClients.delete(res);
      if (sseClients.size === 0) stopPolling();
    }
    const state = { convId, lastSig: '', drop };
    req.on('close', drop);
    req.on('error', drop);
    res.on('close', drop);
    res.on('error', drop);
    maxLife = setTimeout(() => {
      drop();
      try { res.end(); } catch (_) {}
    }, SSE_MAX_LIFETIME_MS);
    if (typeof maxLife.unref === 'function') maxLife.unref();

    const initial = getLiveSnapshot(convId);
    state.lastSig = snapshotSig(initial);
    sseClients.set(res, state);
    try {
      res.write(`data: ${JSON.stringify(initial)}\n\n`);
      startPolling();
    } catch (_) {
      drop();
      try { res.end(); } catch (_) {}
    }
    return;
  }

  if (url.pathname === '/preload.js') {
    res.writeHead(200, {
      'Content-Type': 'application/javascript; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff'
    });
    res.end(getPreloadScript());
    return;
  }

  if (url.pathname === '/' || url.pathname === '/ui.html') {
    try {
      const html = fs.readFileSync(UI_HTML_PATH, 'utf8');
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Content-Security-Policy': UI_CSP,
        'X-Content-Type-Options': 'nosniff'
      });
      res.end(html);
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8', 'X-Content-Type-Options': 'nosniff' });
      res.end('Error loading ui.html');
    }
    return;
  }

  res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8', 'X-Content-Type-Options': 'nosniff' });
  res.end(JSON.stringify({ error: 'Not Found' }));
}

function parseLoopbackAddress(lsAddress) {
  const raw = String(lsAddress || '').trim();
  if (!raw) return null;
  let host = '';
  let portStr = '';
  if (raw.startsWith('[')) {
    const endBracket = raw.indexOf(']:');
    if (endBracket === -1) return null;
    host = raw.slice(1, endBracket).toLowerCase();
    portStr = raw.slice(endBracket + 2);
  } else {
    const lastColon = raw.lastIndexOf(':');
    if (lastColon <= 0) return null;
    host = raw.slice(0, lastColon).toLowerCase();
    portStr = raw.slice(lastColon + 1);
  }
  if (!isValidPortStr(portStr)) return null;
  if (!ALLOWED_HOSTNAMES.has(host) && host !== '::1') return null;
  const formattedHost = host === '::1' ? '[::1]' : host;
  return `${formattedHost}:${portStr}`;
}

/**
 * Watch the parent Antigravity language_server via its loopback /healthz endpoint.
 * Note: Do NOT listen on stdin ('end') because language_server.exe attaches NUL (os.DevNull)
 * to fd 0 on Windows, which immediately emits EOF on startup and triggers an infinite restart
 * loop under restart_policy: "always". Do NOT poll parent PID either, because the immediate
 * parent is cmd.exe (agy-node.cmd) waiting on this child process.
 */
function startParentWatchdog(lsAddress = LS_ADDRESS, options = {}) {
  const targetAddress = parseLoopbackAddress(lsAddress);
  if (!targetAddress) return null;
  const intervalMs = options.intervalMs || LS_WATCH_MS;
  const retryMs = options.retryMs || 500;
  const onExit = typeof options.onExit === 'function' ? options.onExit : () => process.exit(0);

  let expectedInstanceId = null;
  let missedHeartbeats = 0;
  let checkInFlight = false;
  let stopped = false;

  const stop = () => {
    stopped = true;
    clearInterval(timer);
  };

  const checkAlive = () => {
    if (stopped || checkInFlight) return;
    checkInFlight = true;
    let settled = false;
    const onFail = () => {
      if (settled) return;
      settled = true;
      checkInFlight = false;
      if (stopped) return;
      missedHeartbeats++;
      if (missedHeartbeats >= 2) {
        stop();
        onExit();
      } else {
        const retry = setTimeout(checkAlive, retryMs);
        if (typeof retry.unref === 'function') retry.unref();
      }
    };
    try {
      const req = http.get(`http://${targetAddress}/healthz`, { timeout: 2000 }, (res) => {
        res.on('error', onFail);
        if (res.statusCode !== 200) {
          res.resume();
          onFail();
          return;
        }
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => { if (body.length < 1024) body += chunk; });
        res.on('end', () => {
          if (settled) return;
          settled = true;
          checkInFlight = false;
          if (stopped) return;
          try {
            const parsed = JSON.parse(body);
            if (parsed && parsed.instanceId) {
              if (expectedInstanceId && expectedInstanceId !== parsed.instanceId) {
                stop();
                onExit();
                return;
              }
              expectedInstanceId = parsed.instanceId;
            }
          } catch (_) {}
          missedHeartbeats = 0;
        });
      });
      req.on('timeout', () => { req.destroy(); });
      req.on('error', onFail);
    } catch (_) {
      onFail();
    }
  };

  const timer = setInterval(checkAlive, intervalMs);
  if (typeof timer.unref === 'function') timer.unref();
  return { stop, checkAlive };
}

const isMainModule = (() => {
  if (!process.argv[1]) return false;
  const entry = path.resolve(process.argv[1]);
  const self = fileURLToPath(import.meta.url);
  return process.platform === 'win32'
    ? entry.toLowerCase() === self.toLowerCase()
    : entry === self;
})();

if (isMainModule) {
  if (SIDECAR_PORT > 0) {
    const sidecarServer = http.createServer(handleHttpRequest);
    sidecarServer.on('error', (err) => {
      console.error('[agy-hud] Sidecar server error:', err.message);
    });
    sidecarServer.listen(SIDECAR_PORT, '127.0.0.1', () => {
      console.log(`[agy-hud] Sidecar server listening on 127.0.0.1:${SIDECAR_PORT}`);
    });
    startParentWatchdog();
  } else {
    console.log('[agy-hud] ANTIGRAVITY_SIDECAR_WEB_PORT not set; sidecar web UI disabled.');
    // Stay idle instead of exiting, so restart_policy "always" does not cause a restart loop.
    setInterval(() => {}, 1 << 30);
  }
}

export { handleHttpRequest, isAllowedHost, startParentWatchdog };
