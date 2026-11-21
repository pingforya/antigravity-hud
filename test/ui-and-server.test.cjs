'use strict';

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const net = require('node:net');
const vm = require('node:vm');
const { spawnSync } = require('node:child_process');
const { pathToFileURL } = require('node:url');

// Isolate filesystem state from real user directories BEFORE loading project modules
const ROOT = path.resolve(__dirname, '..');
const TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-ui-server-test-'));
const TMP_BRAIN = path.join(TMP_ROOT, 'brain');
const TMP_DATA = path.join(TMP_ROOT, 'data');
const TMP_PLUGIN = path.join(TMP_ROOT, 'plugin');
fs.mkdirSync(TMP_BRAIN, { recursive: true });
fs.mkdirSync(TMP_DATA, { recursive: true });
fs.mkdirSync(TMP_PLUGIN, { recursive: true });

process.env.AGY_BRAIN_DIR = TMP_BRAIN;
process.env.AGY_HUD_DATA_DIR = TMP_DATA;
process.env.AGY_HUD_PLUGIN_DIR = TMP_PLUGIN;
process.env.AGY_HUD_MEMORY_FILE = path.join(ROOT, 'plugins', 'agy-hud', 'assets', 'hakimi-memory.md');
delete process.env.AGY_HUD_DEFAULT_PERSONA;

const P = require('../paths.cjs');
const parser = require('../core/telemetry-parser.cjs');
const bp = require('../core/backend-patcher.cjs');
const cli = require('../cli.js');
const personaMode = require('../plugins/agy-hud/scripts/persona-mode.cjs');
const { handleHook } = require('../plugins/agy-hud/scripts/hud-hook.cjs');

const UI_HTML_PATH = path.join(ROOT, 'plugins', 'agy-hud', 'sidecars', 'telemetry', 'ui.html');
const HUD_RUNTIME_PATH = path.join(ROOT, 'core', 'hud-runtime.js');
const NCP_RUNTIME_PATH = path.join(ROOT, 'core', 'new-chat-persona.js');
const SERVER_MJS_PATH = path.join(ROOT, 'plugins', 'agy-hud', 'sidecars', 'telemetry', 'server.mjs');
const CLI_JS_PATH = path.join(ROOT, 'cli.js');
const FAST_PATCH_PATH = path.join(ROOT, 'fast-patch.cjs');
const PATCH_PS1_PATH = path.join(ROOT, 'patch.ps1');
const VERIFY_JS_PATH = path.join(ROOT, 'test', 'verify.js');

const EMOJI_RE = /[\p{Emoji_Presentation}\p{Extended_Pictographic}\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u25B6\u25B4\u25BE\uFE0F]/gu;
const CONV_A = '11111111-1111-4111-8111-111111111111';
const CONV_B = '22222222-2222-4222-8222-222222222222';

async function waitFor(fn, timeoutMs = 1500) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fn()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  assert.ok(fn(), 'waitFor timed out');
}

function loadJSDOM() {
  try { return require('jsdom').JSDOM; } catch (_) {}
  for (const c of [path.join(ROOT, 'node_modules', 'jsdom'), path.join(P.CHINESE_ROOT, 'node_modules', 'jsdom')]) {
    if (fs.existsSync(c)) return require(c).JSDOM;
  }
  throw new Error('JSDOM not found');
}

const JSDOM = loadJSDOM();

function makeUuid(n) {
  const hex = String(n).padStart(12, '0');
  return `aaaaaaaa-aaaa-4aaa-8aaa-${hex}`;
}

function writeTranscript(convId, steps, brainDir = TMP_BRAIN) {
  const dir = path.join(brainDir, convId, '.system_generated', 'logs');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'transcript_full.jsonl'), steps.map((s) => JSON.stringify(s)).join('\n') + '\n', 'utf8');
}

function buildSampleDailyUsage() {
  const mArgon = {
    modelName: 'Gemini 4 Argon (High)',
    shortLabel: 'Argon',
    family: 'gemini-argon',
    color: '#38bdf8',
    totalTokens: 500000,
    inputTokens: 50000,
    cacheReadTokens: 440000,
    outputTokens: 10000,
    thinkingTokens: 4000,
    turnCount: 5,
    sessionCount: 1,
    sharePct: 100,
    cacheHitRate: 89.8
  };
  const mOpus = {
    modelName: 'Claude Opus 5.5 (Medium)',
    shortLabel: 'Opus 5.5',
    family: 'claude-opus-5',
    color: '#f59e0b',
    totalTokens: 300000,
    inputTokens: 30000,
    cacheReadTokens: 264000,
    outputTokens: 6000,
    thinkingTokens: 2000,
    turnCount: 3,
    sessionCount: 1,
    sharePct: 100,
    cacheHitRate: 89.8
  };
  const dayToday = {
    date: '2026-11-18',
    totalTokens: 500000,
    inputTokens: 50000,
    cacheReadTokens: 440000,
    outputTokens: 10000,
    thinkingTokens: 4000,
    mainTokens: 450000,
    subagentTokens: 50000,
    turnCount: 5,
    sessionCount: 1,
    cacheHitRate: 89.8,
    models: [mArgon]
  };
  const dayPrev = {
    date: '2026-11-17',
    totalTokens: 300000,
    inputTokens: 30000,
    cacheReadTokens: 264000,
    outputTokens: 6000,
    thinkingTokens: 2000,
    mainTokens: 300000,
    subagentTokens: 0,
    turnCount: 3,
    sessionCount: 1,
    cacheHitRate: 89.8,
    models: [mOpus]
  };
  return {
    todayKey: '2026-11-18',
    today: dayToday,
    days: {
      '2026-11-18': dayToday,
      '2026-11-17': dayPrev
    },
    availableDates: ['2026-11-17', '2026-11-18']
  };
}

function buildSampleTelemetry(overrides = {}) {
  return {
    conversationId: CONV_A,
    modelName: 'Gemini 4 Argon (High)',
    currentContext: 100000,
    peakContext: 100000,
    contextLimit: 256000,
    contextUsagePct: 39.1,
    compactionCount: 0,
    latestCacheHitRate: 90,
    latestCacheReadTokens: 90000,
    latestInputTokens: 10000,
    latestOutputTokens: 500,
    latestTokPerSec: 88,
    avgTokPerSec: 75,
    latestDurationSec: 5.6,
    totalModelSec: 12.4,
    totalToolSec: 3.2,
    totalInputTokens: 20000,
    totalCacheReadTokens: 180000,
    totalOutputTokens: 2000,
    totalTokens: 202000,
    plannerStepCount: 2,
    stepCount: 4,
    topConsumers: [
      { stepIndex: 1, label: 'read_file(app.js)', deltaTokens: 12000 }
    ],
    steps: [
      { stepIndex: 1, thinking: 'Step 1 reasoning', tokPerSec: 70, outputTokens: 800, durationSec: 4.1 },
      { stepIndex: 2, thinking: 'Step 2 reasoning', tokPerSec: 88, outputTokens: 1200, durationSec: 5.6 }
    ],
    dailyUsage: buildSampleDailyUsage(),
    ...overrides
  };
}

function openUiHtmlDom({ url, mockFetch, beforeParse } = {}) {
  const html = fs.readFileSync(UI_HTML_PATH, 'utf8');
  const fetchCalls = [];
  const dom = new JSDOM(html, {
    runScripts: 'dangerously',
    pretendToBeVisual: true,
    url: url || `http://127.0.0.1:4321/ui.html?conversationId=${CONV_A}`,
    beforeParse(win) {
      win.fetch = async (reqUrl, init) => {
        fetchCalls.push({ url: String(reqUrl), init: init || {} });
        if (typeof mockFetch === 'function') return mockFetch(String(reqUrl), init);
        if (String(reqUrl).includes('/api/persona')) {
          return { ok: true, status: 200, json: async () => ({ conversationId: CONV_A, mode: 'hakimi' }) };
        }
        if (String(reqUrl).includes('/api/hud/live')) {
          return { ok: true, status: 200, json: async () => buildSampleTelemetry({ sig: 'sig-1' }) };
        }
        if (String(reqUrl).includes('/api/hud/daily')) {
          return { ok: true, status: 200, json: async () => buildSampleDailyUsage() };
        }
        return { ok: false, status: 404, json: async () => ({ error: 'not found' }) };
      };
      if (typeof beforeParse === 'function') beforeParse(win);
    }
  });
  return { dom, win: dom.window, fetchCalls };
}

function closeUiHtmlDom(dom) {
  try { dom.window.dispatchEvent(new dom.window.Event('pagehide')); } catch (_) {}
  dom.window.close();
}

function rawHttpRequest({ hostHeader, port, method = 'GET', reqPath = '/', headers = {}, body = null }) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1',
      port,
      method,
      path: reqPath,
      headers: {
        ...(hostHeader !== undefined ? { Host: hostHeader } : {}),
        ...headers
      }
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        resolve({
          status: res.statusCode,
          headers: res.headers,
          body: Buffer.concat(chunks).toString('utf8')
        });
      });
    });
    req.on('error', reject);
    if (body !== null) req.write(body);
    req.end();
  });
}

after(() => {
  fs.rmSync(TMP_ROOT, { recursive: true, force: true });
});

// ============================================================================
// 1. Frontend Zero-Emoji & ui.html Full Runtime (JSDOM)
// ============================================================================
describe('1. Frontend Zero-Emoji & ui.html Full Runtime', () => {
  test('zero emojis across frontend runtimes, CLI, patch.ps1, and test/verify.js', () => {
    const targets = [
      UI_HTML_PATH,
      HUD_RUNTIME_PATH,
      NCP_RUNTIME_PATH,
      CLI_JS_PATH,
      FAST_PATCH_PATH,
      PATCH_PS1_PATH,
      VERIFY_JS_PATH
    ];
    for (const filePath of targets) {
      const text = fs.readFileSync(filePath, 'utf8');
      const matches = text.match(EMOJI_RE);
      assert.equal(
        matches ? matches.length : 0,
        0,
        `Unexpected emoji/pictograph ${matches ? JSON.stringify(matches) : ''} found in ${path.relative(ROOT, filePath)}`
      );
    }
  });

  test('scope tabs (click + ArrowLeft/ArrowRight), <button> trend/heatmap drill-down, theme toggle + storage sync + legacy fallback', () => {
    const { dom, win } = openUiHtmlDom();
    try {
      const doc = win.document;
      win.renderDaily(buildSampleDailyUsage());

      // Tab clicks: day -> week -> total
      const tabDay = doc.getElementById('scope-tab-day');
      const tabWeek = doc.getElementById('scope-tab-week');
      const tabTotal = doc.getElementById('scope-tab-total');

      tabWeek.click();
      assert.equal(win.getDailyState().scope, 'week');
      assert.equal(tabWeek.getAttribute('aria-selected'), 'true');
      assert.ok(doc.getElementById('view-page-week').classList.contains('active'));

      tabTotal.click();
      assert.equal(win.getDailyState().scope, 'total');
      assert.equal(tabTotal.getAttribute('aria-selected'), 'true');
      assert.ok(doc.getElementById('view-page-total').classList.contains('active'));

      // Keyboard ArrowLeft / ArrowRight switching on tablist
      tabTotal.focus();
      tabTotal.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
      assert.equal(win.getDailyState().scope, 'day');
      assert.equal(doc.activeElement, tabDay);

      tabDay.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
      assert.equal(win.getDailyState().scope, 'total');
      assert.equal(doc.activeElement, tabTotal);

      // Verify .heatmap-cell and .trend-col are <button> elements and drill down to day view
      const heatCell = doc.querySelector('.heatmap-cell[data-heatmap-date="2026-11-17"]');
      assert.ok(heatCell);
      assert.equal(heatCell.tagName, 'BUTTON');
      heatCell.click();
      assert.equal(win.getDailyState().scope, 'day');
      assert.equal(win.getDailyState().selectedDate, '2026-11-17');

      tabWeek.click();
      const weekTrendCol = doc.querySelector('#week-trend-chart .trend-col[data-trend-date="2026-11-18"]');
      assert.ok(weekTrendCol);
      assert.equal(weekTrendCol.tagName, 'BUTTON');
      weekTrendCol.click();
      assert.equal(win.getDailyState().scope, 'day');
      assert.equal(win.getDailyState().selectedDate, '2026-11-18');

      // Theme toggle + localStorage + storage event sync
      const toggleBtn = doc.getElementById('theme-toggle-btn');
      assert.equal(doc.documentElement.getAttribute('data-theme'), 'dark');
      toggleBtn.click();
      assert.equal(doc.documentElement.getAttribute('data-theme'), 'light');
      assert.equal(doc.getElementById('theme-toggle-label').textContent, '浅色');
      assert.equal(win.localStorage.getItem('agy_hud_theme_v2'), 'light');

      win.dispatchEvent(new win.StorageEvent('storage', { key: 'agy_hud_theme_v2', newValue: 'dark' }));
      assert.equal(doc.documentElement.getAttribute('data-theme'), 'dark');
      assert.equal(doc.getElementById('theme-toggle-label').textContent, '深色');
    } finally {
      closeUiHtmlDom(dom);
    }

    // Legacy agy_hud_sidecar_theme_v2 fallback when agy_hud_theme_v2 is absent
    const legacy = openUiHtmlDom({
      beforeParse(win) {
        win.localStorage.setItem('agy_hud_sidecar_theme_v2', 'light');
      }
    });
    try {
      assert.equal(legacy.win.document.documentElement.getAttribute('data-theme'), 'light');
      assert.equal(legacy.win.document.getElementById('theme-toggle-label').textContent, '浅色');
    } finally {
      closeUiHtmlDom(legacy.dom);
    }
  });

  test('render() context badge thresholds, .dashboard-shell, svg.summary-chevron, <details> open-state preservation, and XSS + CSS color sanitization', () => {
    const { dom, win } = openUiHtmlDom();
    try {
      const doc = win.document;
      assert.ok(doc.querySelector('.dashboard-shell'), '.dashboard-shell container must exist in ui.html');
      const ctxEl = doc.getElementById('ctx-text');

      win.render(buildSampleTelemetry({ contextUsagePct: 59.9 }));
      assert.ok(ctxEl.classList.contains('badge-green'));
      assert.ok(doc.querySelector('details summary svg.summary-chevron'), 'rendered thinking steps must include svg.summary-chevron');

      win.render(buildSampleTelemetry({ contextUsagePct: 60 }));
      assert.ok(ctxEl.classList.contains('badge-amber'));

      win.render(buildSampleTelemetry({ contextUsagePct: 85 }));
      assert.ok(ctxEl.classList.contains('badge-rose'));

      // <details> open-state preservation across subsequent render() updates
      const det1 = doc.querySelector('details[data-step-idx="1"]');
      const det2 = doc.querySelector('details[data-step-idx="2"]');
      assert.equal(det2.open, true);
      assert.equal(det1.open, false);
      det1.open = true;
      det2.open = false;

      win.render(buildSampleTelemetry({
        contextUsagePct: 40,
        steps: [
          { stepIndex: 1, thinking: 'Step 1 updated', tokPerSec: 71, outputTokens: 810, durationSec: 4.1 },
          { stepIndex: 2, thinking: 'Step 2 updated', tokPerSec: 90, outputTokens: 1250, durationSec: 5.7 }
        ]
      }));
      assert.equal(doc.querySelector('details[data-step-idx="1"]').open, true);
      assert.equal(doc.querySelector('details[data-step-idx="2"]').open, false);

      // XSS escaping + invalid CSS color sanitization
      const xssDaily = buildSampleDailyUsage();
      xssDaily.today.models[0].modelName = '<img src=x onerror=alert(1)>';
      xssDaily.today.models[0].color = 'red;position:fixed';
      win.render(buildSampleTelemetry({
        topConsumers: [{ stepIndex: 3, label: '<img src=x onerror=alert(2)>', deltaTokens: 999 }],
        steps: [{ stepIndex: 3, thinking: '<script>alert(3)</script><img onerror=alert(4)>', tokPerSec: 50, outputTokens: 100, durationSec: 2 }],
        dailyUsage: xssDaily
      }));

      assert.equal(doc.querySelectorAll('img').length, 0);
      assert.ok(doc.getElementById('consumers-list').textContent.includes('<img src=x onerror=alert(2)>'));
      assert.ok(doc.getElementById('thinking-list').textContent.includes('<script>alert(3)</script>'));
      const modelDot = doc.querySelector('#day-models-list .model-dot');
      assert.ok(modelDot);
      assert.equal((modelDot.getAttribute('style') || '').includes('position'), false);
      assert.equal(modelDot.style.position, '');
    } finally {
      closeUiHtmlDom(dom);
    }
  });

  test('invalid/missing convId, prewarmed hidden iframe error recovery, and polling X-Sidecar-Token forwarding', async () => {
    // 1. Invalid convId
    const invalid = openUiHtmlDom({
      url: 'http://127.0.0.1:4321/ui.html?conversationId=not-a-uuid'
    });
    try {
      await waitFor(() =>
        invalid.win.document.getElementById('ctx-text').textContent !== '加载中...' &&
        invalid.win.document.getElementById('daily-total-badge').textContent !== '加载中...'
      );
      assert.notEqual(invalid.win.document.getElementById('ctx-text').textContent, '加载中...');
      assert.notEqual(invalid.win.document.getElementById('daily-total-badge').textContent, '加载中...');
      assert.equal(invalid.win.document.getElementById('persona-hakimi').disabled, true);
    } finally {
      closeUiHtmlDom(invalid.dom);
    }

    // 2. Missing convId
    const missing = openUiHtmlDom({
      url: 'http://127.0.0.1:4321/ui.html',
      mockFetch: async (reqUrl) => {
        if (reqUrl.includes('/api/hud/live')) {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              error: 'no_active_conversation',
              contextLimit: 256000,
              dailyUsage: buildSampleDailyUsage(),
              steps: [],
              topConsumers: []
            })
          };
        }
        return { ok: true, status: 200, json: async () => ({}) };
      }
    });
    try {
      await waitFor(() =>
        missing.win.document.getElementById('ctx-text').textContent === '无会话' &&
        missing.win.document.getElementById('daily-total-badge').textContent !== '加载中...'
      );
      assert.equal(missing.win.document.getElementById('ctx-text').textContent, '无会话');
      assert.notEqual(missing.win.document.getElementById('daily-total-badge').textContent, '加载中...');
    } finally {
      closeUiHtmlDom(missing.dom);
    }

    // 3. Valid convId + ?token= forwards X-Sidecar-Token in buildFetchOpts
    const withToken = openUiHtmlDom({
      url: `http://127.0.0.1:4321/ui.html?conversationId=${CONV_A}&token=sec-tok-99`
    });
    try {
      await waitFor(() => withToken.fetchCalls.some((c) => c.url.includes('/api/hud/live')));
      const liveCall = withToken.fetchCalls.find((c) => c.url.includes('/api/hud/live'));
      assert.ok(liveCall, 'polling should invoke /api/hud/live');
      assert.equal(liveCall.init.headers && liveCall.init.headers['X-Sidecar-Token'], 'sec-tok-99');
    } finally {
      closeUiHtmlDom(withToken.dom);
    }

    // 4. Prewarmed hidden iframe (doc.hidden = true initially -> becomes visible on error) clears "加载中..."
    let iframeHidden = true;
    const prewarmed = openUiHtmlDom({
      url: `http://127.0.0.1:4321/ui.html?conversationId=${CONV_A}`,
      beforeParse(win) {
        Object.defineProperty(win.document, 'hidden', {
          configurable: true,
          get: () => iframeHidden
        });
      },
      mockFetch: async (reqUrl) => {
        if (reqUrl.includes('/api/persona')) {
          return { ok: true, status: 200, json: async () => ({ conversationId: CONV_A, mode: 'hakimi' }) };
        }
        if (reqUrl.includes('/api/hud/live')) {
          throw new Error('offline when revealed');
        }
        if (reqUrl.includes('/api/hud/daily')) {
          return { ok: true, status: 200, json: async () => buildSampleDailyUsage() };
        }
        return { ok: false, status: 503, json: async () => ({}) };
      }
    });
    try {
      // Allow kickOff() timer to run while hidden
      await new Promise((r) => setTimeout(r, 20));
      assert.equal(prewarmed.fetchCalls.some((c) => c.url.includes('/api/hud/live')), false);
      assert.equal(prewarmed.win.document.getElementById('ctx-text').textContent, '加载中...');

      iframeHidden = false;
      prewarmed.win.document.dispatchEvent(new prewarmed.win.Event('visibilitychange'));
      await waitFor(() =>
        prewarmed.win.document.getElementById('ctx-text').textContent !== '加载中...' &&
        prewarmed.win.document.getElementById('daily-total-badge').textContent !== '加载中...'
      );
      assert.equal(prewarmed.win.document.getElementById('ctx-text').textContent, '离线');
      assert.notEqual(prewarmed.win.document.getElementById('daily-total-badge').textContent, '加载中...');
    } finally {
      closeUiHtmlDom(prewarmed.dom);
    }
  });
});

// ============================================================================
// 2. plugins/agy-hud/sidecars/telemetry/server.mjs Security & HTTP Tests
// ============================================================================
describe('2. server.mjs Security & HTTP Tests', () => {
  let serverMod;
  let server;
  let port;

  before(async () => {
    writeTranscript(CONV_A, [
      { step_index: 0, type: 'USER_INPUT', content: 'hello', created_at: '2026-11-18T10:00:00.000Z' },
      { step_index: 1, type: 'PLANNER_RESPONSE', status: 'DONE', created_at: '2026-11-18T10:00:02.000Z', input_tokens: 1000, cache_read_tokens: 9000, output_tokens: 200, thinking: 't', content: 'ok' }
    ]);
    serverMod = await import(pathToFileURL(SERVER_MJS_PATH).href);
    server = http.createServer(serverMod.handleHttpRequest);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = server.address().port;
  });

  after(async () => {
    if (server) {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  test('isAllowedHost allows loopback variants and rejects hostile/empty hosts with 403', async () => {
    for (const h of ['127.0.0.1:8080', 'localhost:3000', '[::1]:8080', '127.0.0.1', 'localhost', '[::1]']) {
      assert.equal(serverMod.isAllowedHost({ headers: { host: h } }), true, `expected allowed host: ${h}`);
    }
    for (const h of ['evil.com', '[::1]evil.com', '127.0.0.1:99999', 'localhost:0']) {
      assert.equal(serverMod.isAllowedHost({ headers: { host: h } }), false, `expected rejected host: ${h}`);
      const res = await rawHttpRequest({ hostHeader: h, port, reqPath: '/ui.html' });
      assert.equal(res.status, 403);
    }
    assert.equal(serverMod.isAllowedHost({ headers: { host: '' } }), false);
    const emptyHostStatus = await new Promise((resolve, reject) => {
      const sock = net.connect(port, '127.0.0.1', () => {
        sock.write('GET /ui.html HTTP/1.1\r\nHost: \r\nConnection: close\r\n\r\n');
      });
      let data = '';
      sock.setEncoding('utf8');
      sock.on('data', (chunk) => { data += chunk; });
      sock.on('end', () => {
        const m = data.match(/^HTTP\/1\.1\s+(\d{3})/);
        resolve(m ? Number(m[1]) : 0);
      });
      sock.on('error', reject);
    });
    assert.equal(emptyHostStatus, 403);
  });

  test('HTTP status codes, security headers, 304 ETag, metadata POST, invalid convId 400, /api/hud/daily, and hermetic /preload.js', async () => {
    const badUrlRes = await rawHttpRequest({ hostHeader: `127.0.0.1:${port}`, port, reqPath: '//%' });
    assert.equal(badUrlRes.status, 400);

    const postRes = await rawHttpRequest({ hostHeader: `127.0.0.1:${port}`, port, method: 'POST', reqPath: '/api/hud/live' });
    assert.equal(postRes.status, 405);

    const notFoundRes = await rawHttpRequest({ hostHeader: `127.0.0.1:${port}`, port, reqPath: '/does-not-exist' });
    assert.equal(notFoundRes.status, 404);

    const metaPostRes = await rawHttpRequest({
      hostHeader: `127.0.0.1:${port}`,
      port,
      method: 'POST',
      reqPath: '/_sidecar/get-conversation-metadata',
      headers: { 'Content-Type': 'application/json' },
      body: '{}'
    });
    assert.equal(metaPostRes.status, 200);
    assert.deepEqual(JSON.parse(metaPostRes.body), {});

    const uiRes = await rawHttpRequest({ hostHeader: `127.0.0.1:${port}`, port, reqPath: '/ui.html' });
    assert.equal(uiRes.status, 200);
    assert.ok(uiRes.headers['content-security-policy']);
    assert.equal(uiRes.headers['x-content-type-options'], 'nosniff');

    const liveRes = await rawHttpRequest({
      hostHeader: `127.0.0.1:${port}`,
      port,
      reqPath: `/api/hud/live?conversationId=${CONV_A}`
    });
    assert.equal(liveRes.status, 200);
    const liveJson = JSON.parse(liveRes.body);
    assert.ok(liveJson.sig);
    assert.ok(liveRes.headers.etag);

    const live304 = await rawHttpRequest({
      hostHeader: `127.0.0.1:${port}`,
      port,
      reqPath: `/api/hud/live?conversationId=${CONV_A}`,
      headers: { 'If-None-Match': liveRes.headers.etag }
    });
    assert.equal(live304.status, 304);

    const dailyRes = await rawHttpRequest({ hostHeader: `127.0.0.1:${port}`, port, reqPath: '/api/hud/daily' });
    assert.equal(dailyRes.status, 200);
    const dailyJson = JSON.parse(dailyRes.body);
    assert.ok(dailyJson && dailyJson.todayKey);

    const prevPreload = process.env.AGY_SIDECAR_PRELOAD_PATH;
    process.env.AGY_SIDECAR_PRELOAD_PATH = 'none';
    try {
      const preloadRes = await rawHttpRequest({ hostHeader: `127.0.0.1:${port}`, port, reqPath: '/preload.js' });
      assert.equal(preloadRes.status, 200);
      assert.match(preloadRes.headers['content-type'], /javascript/);
      assert.equal(preloadRes.body, 'window.__sidecarReady = true;\n');
    } finally {
      if (prevPreload === undefined) delete process.env.AGY_SIDECAR_PRELOAD_PATH;
      else process.env.AGY_SIDECAR_PRELOAD_PATH = prevPreload;
    }

    const invalidConvLiveRes = await rawHttpRequest({
      hostHeader: `127.0.0.1:${port}`,
      port,
      reqPath: '/api/hud/live?conversationId=not-a-uuid'
    });
    assert.equal(invalidConvLiveRes.status, 400);
    assert.equal(JSON.parse(invalidConvLiveRes.body).error, 'invalid_conversation_id');
  });

  test('ANTIGRAVITY_SIDECAR_TOKEN and ANTIGRAVITY_SIDECAR_UI_TOKEN enforcement with clean env restoration', async () => {
    const prevTok = process.env.ANTIGRAVITY_SIDECAR_TOKEN;
    process.env.ANTIGRAVITY_SIDECAR_TOKEN = 'unit-test-secret-token';
    try {
      const noTok = await rawHttpRequest({ hostHeader: `127.0.0.1:${port}`, port, reqPath: `/api/hud/live?conversationId=${CONV_A}` });
      assert.equal(noTok.status, 401);

      const wrongTok = await rawHttpRequest({
        hostHeader: `127.0.0.1:${port}`,
        port,
        reqPath: `/api/hud/live?conversationId=${CONV_A}`,
        headers: { 'X-Sidecar-Token': 'wrong-token' }
      });
      assert.equal(wrongTok.status, 401);

      const goodTok = await rawHttpRequest({
        hostHeader: `127.0.0.1:${port}`,
        port,
        reqPath: `/api/hud/live?conversationId=${CONV_A}`,
        headers: { 'X-Sidecar-Token': 'unit-test-secret-token' }
      });
      assert.equal(goodTok.status, 200);
    } finally {
      if (prevTok === undefined) delete process.env.ANTIGRAVITY_SIDECAR_TOKEN;
      else process.env.ANTIGRAVITY_SIDECAR_TOKEN = prevTok;
    }

    const prevUiTok = process.env.ANTIGRAVITY_SIDECAR_UI_TOKEN;
    process.env.ANTIGRAVITY_SIDECAR_UI_TOKEN = 'ui-tok-test';
    try {
      const getLive = await rawHttpRequest({
        hostHeader: `127.0.0.1:${port}`,
        port,
        reqPath: `/api/hud/live?conversationId=${CONV_A}`
      });
      assert.equal(getLive.status, 200);

      const unauthPost = await rawHttpRequest({
        hostHeader: `127.0.0.1:${port}`,
        port,
        method: 'POST',
        reqPath: `/api/persona?conversationId=${CONV_A}`,
        headers: { 'Content-Type': 'application/json', 'X-AGY-Persona': '1' },
        body: JSON.stringify({ mode: 'normal' })
      });
      assert.equal(unauthPost.status, 401);

      const authPost = await rawHttpRequest({
        hostHeader: `127.0.0.1:${port}`,
        port,
        method: 'POST',
        reqPath: `/api/persona?conversationId=${CONV_A}`,
        headers: {
          'Content-Type': 'application/json',
          'X-AGY-Persona': '1',
          'X-Sidecar-Token': 'ui-tok-test'
        },
        body: JSON.stringify({ mode: 'normal' })
      });
      assert.equal(authPost.status, 200);
      assert.equal(JSON.parse(authPost.body).mode, 'normal');
    } finally {
      if (prevUiTok === undefined) delete process.env.ANTIGRAVITY_SIDECAR_UI_TOKEN;
      else process.env.ANTIGRAVITY_SIDECAR_UI_TOKEN = prevUiTok;
      personaMode.setMode(CONV_A, 'hakimi');
    }
  });

  test('startParentWatchdog rejects non-loopback addresses', () => {
    assert.equal(serverMod.startParentWatchdog('evil.com:8080'), null);
  });
});

// ============================================================================
// 3. hud-runtime.js & new-chat-persona.js Hardened Behavior
// ============================================================================
describe('3. hud-runtime.js & new-chat-persona.js Hardened Behavior', () => {
  const hudRuntimeCode = fs.readFileSync(HUD_RUNTIME_PATH, 'utf8');
  const ncpRuntimeCode = fs.readFileSync(NCP_RUNTIME_PATH, 'utf8');

  test('hud-runtime.js: getIdleContextLimit (840k/160k/128k), subagent exclusion, 32-entry cache cap, zero-ctx stepCount>0, theme event & destroy', async () => {
    const dom = new JSDOM(`
      <!DOCTYPE html><html><body>
        <div class="agy-home">
          <div class="surface-composer">
            <div role="textbox" contenteditable="true"></div>
            <div class="agy-composer-footer">
              <div><button id="model-btn" type="button">Claude Opus 5.5 (Medium)</button></div>
              <div><button id="send-btn" type="button">Send</button></div>
            </div>
          </div>
        </div>
      </body></html>
    `, { runScripts: 'dangerously', url: 'https://localhost/' });
    const win = dom.window;
    const doc = win.document;
    win.__AGY_HUD_DISABLE_POLL__ = true;

    const pendingFetches = [];
    win.__AGY_HUD_FETCH__ = (cid) => {
      if (cid === '__HOME__') return Promise.resolve({ conversationId: '__HOME__', contextLimit: 256000 });
      return new Promise((resolve) => pendingFetches.push({ cid, resolve }));
    };

    try {
      win.eval(hudRuntimeCode);

      // Home model-button detection: 840k / 160k / 128k
      const ctxTextEl = () => doc.getElementById('agy-hud-ctx-text').textContent;
      assert.equal(ctxTextEl(), '0 / 840k');

      doc.getElementById('model-btn').textContent = 'Claude Opus 4.6 (Thinking)';
      win.__AGY_HUD__.sync();
      assert.equal(ctxTextEl(), '0 / 160k');

      doc.getElementById('model-btn').textContent = 'Gemini 3.1 Pro (Low)';
      win.__AGY_HUD__.sync();
      assert.equal(ctxTextEl(), '0 / 128k');

      // isSubagentComposerFooter: [title="子智能体"] and Lexical overlay
      doc.body.innerHTML = `
        <div id="sub-title" class="surface-composer">
          <button title="子智能体" type="button">Worker</button>
          <div class="agy-composer-footer" id="sub-title-footer"><div></div><div><button>Stop</button></div></div>
        </div>
        <div id="sub-overlay" class="surface-composer">
          <div role="textbox" contenteditable="true"></div>
          <div class="lexical-overlay">Message subagent, @ to mention</div>
          <div class="agy-composer-footer" id="sub-overlay-footer"><div></div><div><button>Stop</button></div></div>
        </div>
      `;
      win.__AGY_HUD__.sync();
      assert.equal(doc.getElementById('agy-hud-footer-cluster'), null);

      // Mount a real conversation view and verify telemetryCache 32-entry LRU cap
      doc.body.innerHTML = `
        <div data-testid="conversation-view" data-cascade-id="${makeUuid(1)}">
          <div class="surface-composer">
            <div class="agy-composer-footer"><div><button>+</button></div><div><button>Send</button></div></div>
          </div>
        </div>
      `;
      const convView = doc.querySelector('[data-testid="conversation-view"]');
      for (let i = 1; i <= 35; i++) {
        const cid = makeUuid(i);
        convView.setAttribute('data-cascade-id', cid);
        win.__AGY_HUD__.update({
          conversationId: cid,
          currentContext: i * 1000,
          peakContext: i * 1000,
          contextLimit: 256000,
          contextUsagePct: 10,
          stepCount: 1,
          plannerStepCount: 1,
          latestCacheHitRate: 50,
          latestTokPerSec: 30,
          topConsumers: []
        });
      }

      // Entry #35 is still cached -> switching back renders immediately from cache
      convView.setAttribute('data-cascade-id', makeUuid(34));
      win.__AGY_HUD__.sync();
      assert.equal(doc.getElementById('agy-hud-ctx-text').textContent, '34.0k (10%)');

      // Entry #1 was evicted (cap = 32) -> sync() resets synchronously while awaiting fetch
      convView.setAttribute('data-cascade-id', makeUuid(1));
      win.__AGY_HUD__.sync();
      assert.equal(doc.getElementById('agy-hud-ctx-text').textContent, '0 / 256k');

      // Zero-context stepCount > 0 preservation when fetch resolves
      const req1 = pendingFetches.find((f) => f.cid === makeUuid(1));
      assert.ok(req1);
      req1.resolve({
        conversationId: makeUuid(1),
        currentContext: 0,
        peakContext: 0,
        contextLimit: 256000,
        contextUsagePct: 0,
        stepCount: 2,
        plannerStepCount: 1,
        latestCacheHitRate: 40,
        latestTokPerSec: 25,
        topConsumers: []
      });
      await new Promise((r) => setImmediate(r));
      assert.equal(doc.getElementById('agy-hud-ctx-text').textContent, '0 (0%)');
      assert.equal(doc.getElementById('agy-hud-cache-text').style.display, '');
      assert.equal(doc.getElementById('agy-hud-cache-text').textContent, '缓 40%');
      assert.equal(doc.getElementById('agy-hud-speed-val').textContent, '25/s');

      // agy-hud-theme-change CustomEvent + destroy()
      let themeEventDetail = null;
      doc.addEventListener('agy-hud-theme-change', (ev) => { themeEventDetail = ev.detail; });
      win.__AGY_HUD__.setTheme('light');
      assert.equal(themeEventDetail && themeEventDetail.theme, 'light');

      win.__AGY_HUD__.destroy();
      win.__AGY_HUD__.destroy(); // idempotent
    } finally {
      dom.window.close();
    }
  });

  test('new-chat-persona.js: preserves draftMode across footer replacement on unstarted view, keyboard nav, and destroy()', () => {
    const dom = new JSDOM(`
      <!DOCTYPE html><html><body>
        <main id="host">
          <section data-testid="conversation-view" data-cascade-id="conversation">
            <div contenteditable="true" role="textbox" aria-placeholder="输入任何问题"></div>
            <div class="agy-composer-footer" id="footer-1">
              <div><button type="button">+</button></div>
              <div><button class="agy-send-button" type="button">Send</button></div>
            </div>
          </section>
        </main>
      </body></html>
    `, { runScripts: 'dangerously', url: 'https://localhost/' });
    const win = dom.window;
    const doc = win.document;

    try {
      win.eval(ncpRuntimeCode);
      const api = win.__AGY_NEW_CHAT_PERSONA__;
      api.sync();

      // Open menu and test ArrowDown / ArrowUp keyboard navigation + selection
      api.openMenu();
      const menu = doc.getElementById('agy-new-chat-persona-menu');
      assert.equal(menu.style.display, 'block');
      assert.equal(doc.activeElement.getAttribute('data-persona-option'), 'hakimi');

      menu.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
      assert.equal(doc.activeElement.getAttribute('data-persona-option'), 'normal');

      menu.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }));
      assert.equal(doc.activeElement.getAttribute('data-persona-option'), 'hakimi');

      menu.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
      assert.equal(doc.activeElement.getAttribute('data-persona-option'), 'normal');
      // Browser triggers click on focused <button> when Enter is pressed
      doc.activeElement.click();
      assert.equal(api.getDraftMode(), 'normal');
      assert.equal(menu.style.display, 'none');

      // Replace .agy-composer-footer DOM node on the same unstarted view -> draftMode remains 'normal'
      const convView = doc.querySelector('[data-testid="conversation-view"]');
      doc.getElementById('footer-1').remove();
      const footer2 = doc.createElement('div');
      footer2.className = 'agy-composer-footer';
      footer2.id = 'footer-2';
      footer2.innerHTML = '<div><button type="button">+</button></div><div><button class="agy-send-button" type="button">Send</button></div>';
      convView.appendChild(footer2);

      api.sync();
      assert.equal(api.getDraftMode(), 'normal');
      assert.equal(doc.getElementById('agy-new-chat-persona').parentElement, footer2);
      assert.equal(doc.getElementById('agy-new-chat-persona-btn').getAttribute('data-persona-mode'), 'normal');

      // destroy() removes pill + menu and ignores further sync()
      api.destroy();
      assert.equal(doc.getElementById('agy-new-chat-persona'), null);
      assert.equal(doc.getElementById('agy-new-chat-persona-menu'), null);
      api.sync();
      assert.equal(doc.getElementById('agy-new-chat-persona'), null);
    } finally {
      dom.window.close();
    }
  });
});

// ============================================================================
// 4. cli.js, persona-mode.cjs, hud-hook.cjs, backend-patcher.cjs Edge Cases
// ============================================================================
describe('4. cli.js, persona-mode.cjs, hud-hook.cjs, backend-patcher.cjs Edge Cases', () => {
  test('cli.js & utility entrypoints: --help exits 0 across all 6 CLI scripts, findAsarPath, getCandidateAsarPaths, invalid CLI args, cleanupLegacyTelemetrySnapshots', () => {
    const helpRes = spawnSync(process.execPath, [path.join(ROOT, 'cli.js'), '--help'], { encoding: 'utf8' });
    assert.equal(helpRes.status, 0);
    assert.ok(helpRes.stdout.includes('inspect') && helpRes.stdout.includes('patch-backend'));

    for (const relScript of [
      'fast-patch.cjs',
      'core/backend-patcher.cjs',
      'bg-sync-i18n.cjs',
      'unified-patch.cjs',
      'apply-new-chat-persona.cjs'
    ]) {
      const r = spawnSync(process.execPath, [path.join(ROOT, relScript), '--help'], { encoding: 'utf8' });
      assert.equal(r.status, 0, `${relScript} --help should exit 0 (stderr: ${r.stderr})`);
      assert.ok(r.stdout.trim().length > 0, `${relScript} --help should output usage`);
    }

    const badDays = spawnSync(process.execPath, [path.join(ROOT, 'cli.js'), 'daily', '--days', 'abc'], { encoding: 'utf8' });
    assert.equal(badDays.status, 1);

    const missingPathVal = spawnSync(process.execPath, [path.join(ROOT, 'cli.js'), 'inspect', '--path'], { encoding: 'utf8' });
    assert.equal(missingPathVal.status, 1);

    // getCandidateAsarPaths across win32 / darwin / linux
    const winCands = cli.getCandidateAsarPaths('win32', 'C:\\Users\\alice');
    const macCands = cli.getCandidateAsarPaths('darwin', '/Users/alice');
    const linCands = cli.getCandidateAsarPaths('linux', '/home/alice');
    assert.ok(winCands.some((p) => p.endsWith(path.join('resources', 'app.asar'))));
    assert.ok(macCands.includes('/Applications/Antigravity.app/Contents/Resources/app.asar'));
    assert.ok(linCands.includes('/opt/antigravity/resources/app.asar'));

    // findAsarPath for <dir>/app.asar and <dir>/resources/app.asar
    const asarTmp = fs.mkdtempSync(path.join(TMP_ROOT, 'find-asar-'));
    const directDir = path.join(asarTmp, 'direct');
    const nestedDir = path.join(asarTmp, 'nested');
    fs.mkdirSync(directDir, { recursive: true });
    fs.mkdirSync(path.join(nestedDir, 'resources'), { recursive: true });
    fs.writeFileSync(path.join(directDir, 'app.asar'), 'stub');
    fs.writeFileSync(path.join(nestedDir, 'resources', 'app.asar'), 'stub');
    assert.equal(cli.findAsarPath(directDir), path.join(directDir, 'app.asar'));
    assert.equal(cli.findAsarPath(nestedDir), path.join(nestedDir, 'resources', 'app.asar'));

    // cleanupLegacyTelemetrySnapshots removes legacy live_telemetry.json & conv_<uuid>.json
    const legacyLive = path.join(TMP_DATA, 'live_telemetry.json');
    const legacyConv = path.join(TMP_DATA, `conv_${CONV_A}.json`);
    fs.writeFileSync(legacyLive, '{}');
    fs.writeFileSync(legacyConv, '{}');
    const removedCount = cli.cleanupLegacyTelemetrySnapshots();
    assert.ok(removedCount >= 2);
    assert.equal(fs.existsSync(legacyLive), false);
    assert.equal(fs.existsSync(legacyConv), false);
  });

  test('cli.js getMainIpcScript registers agy-hud:get-telemetry & agy-hud:persona in vm', async () => {
    writeTranscript(CONV_B, [
      { step_index: 0, type: 'USER_INPUT', content: 'vm test', created_at: '2026-11-18T11:00:00.000Z' },
      { step_index: 1, type: 'PLANNER_RESPONSE', status: 'DONE', created_at: '2026-11-18T11:00:01.000Z', input_tokens: 1500, cache_read_tokens: 8500, output_tokens: 100, thinking: 't', content: 'r' }
    ]);

    const handlers = new Map();
    const mainFrame = {};
    const trustedEvent = { sender: { getType: () => 'window', mainFrame }, senderFrame: mainFrame };
    const untrustedWebview = { sender: { getType: () => 'webview', mainFrame }, senderFrame: mainFrame };
    const childIframeEvent = { sender: { getType: () => 'window', mainFrame }, senderFrame: { parent: mainFrame } };

    const mainIpcCode = cli.getMainIpcScript();
    vm.runInNewContext(mainIpcCode, {
      process,
      console,
      Buffer,
      electron_1: {
        ipcMain: {
          removeHandler: (ch) => handlers.delete(ch),
          handle: (ch, fn) => handlers.set(ch, fn)
        }
      },
      require: (id) => {
        if (id === './languageServer') return { killLanguageServer: async () => {} };
        if (id === './agyHudTelemetryParser.cjs') return parser;
        return require(id);
      }
    });

    const getTelemetry = handlers.get('agy-hud:get-telemetry');
    const personaHandler = handlers.get('agy-hud:persona');
    assert.equal(typeof getTelemetry, 'function');
    assert.equal(typeof personaHandler, 'function');

    const toPlain = (v) => JSON.parse(JSON.stringify(v));
    assert.deepEqual(toPlain(await getTelemetry(untrustedWebview, CONV_B)), { error: 'forbidden_sender' });
    assert.deepEqual(toPlain(await getTelemetry(childIframeEvent, CONV_B)), { error: 'forbidden_sender' });
    assert.deepEqual(toPlain(await getTelemetry(trustedEvent, 'bad-id')), { error: 'no_conversation' });

    const homeRes = await getTelemetry(trustedEvent, '__HOME__');
    assert.equal(homeRes.conversationId, '__HOME__');
    assert.equal(homeRes.stepCount, 0);

    const convRes = await getTelemetry(trustedEvent, CONV_B);
    assert.equal(convRes.conversationId, CONV_B);
    assert.equal(convRes.currentContext, 10000);
    assert.equal('steps' in convRes, false);

    assert.deepEqual(toPlain(await personaHandler(untrustedWebview, { action: 'get', conversationId: CONV_B })), { ok: false, error: 'forbidden_sender' });
    assert.deepEqual(toPlain(await personaHandler(childIframeEvent, { action: 'getDefault' })), { ok: false, error: 'forbidden_sender' });

    // getDefault action: 'hakimi' by default, 'normal' when AGY_HUD_DEFAULT_PERSONA='normal'
    assert.deepEqual(toPlain(await personaHandler(trustedEvent, { action: 'getDefault' })), { ok: true, mode: 'hakimi' });
    const prevDefaultPersona = process.env.AGY_HUD_DEFAULT_PERSONA;
    process.env.AGY_HUD_DEFAULT_PERSONA = 'normal';
    try {
      assert.deepEqual(toPlain(await personaHandler(trustedEvent, { action: 'getDefault' })), { ok: true, mode: 'normal' });
    } finally {
      if (prevDefaultPersona === undefined) delete process.env.AGY_HUD_DEFAULT_PERSONA;
      else process.env.AGY_HUD_DEFAULT_PERSONA = prevDefaultPersona;
    }

    assert.deepEqual(toPlain(await personaHandler(trustedEvent, { action: 'set', conversationId: CONV_B, mode: 'normal' })), { ok: true, mode: 'normal' });
    assert.deepEqual(toPlain(await personaHandler(trustedEvent, { action: 'get', conversationId: CONV_B })), { ok: true, mode: 'normal' });
    const staged = await personaHandler(trustedEvent, { action: 'stageNew', mode: 'normal', token: 'vm-tok-1' });
    assert.equal(staged.ok, true);
    assert.deepEqual(toPlain(await personaHandler(trustedEvent, { action: 'cancelNew', token: 'vm-tok-1' })), { ok: true });
    assert.deepEqual(toPlain(await personaHandler(trustedEvent, { action: 'commitNew', conversationId: CONV_B, mode: 'hakimi', token: 'vm-tok-1' })), { ok: true, mode: 'hakimi' });
  });

  test('persona-mode.cjs & hud-hook.cjs: >6 EPHEMERAL_MESSAGE before SYSTEM_MESSAGE, AGY_HUD_DEFAULT_PERSONA, lock timeout, oversized stdin', () => {
    // 1. >6 EPHEMERAL_MESSAGE lines before SYSTEM_MESSAGE still detected as subagent
    const subCid = makeUuid(99);
    const ephemeralLines = Array.from({ length: 8 }, (_, idx) => ({
      step_index: idx,
      source: 'SYSTEM_SDK',
      type: 'EPHEMERAL_MESSAGE',
      status: 'DONE',
      content: `ephemeral-${idx}`
    }));
    ephemeralLines.push({
      step_index: 8,
      source: 'SYSTEM',
      type: 'SYSTEM_MESSAGE',
      status: 'DONE',
      content: `<SYSTEM_MESSAGE>\n[Message] timestamp=2026-11-18T12:00:00Z sender=${CONV_A} content=run task\n</SYSTEM_MESSAGE>`
    });
    const logsDir = path.join(TMP_BRAIN, subCid, '.system_generated', 'logs');
    fs.mkdirSync(logsDir, { recursive: true });
    fs.writeFileSync(path.join(logsDir, 'transcript.jsonl'), ephemeralLines.map((x) => JSON.stringify(x)).join('\n') + '\n', 'utf8');

    assert.equal(personaMode.isSubagentConversation(subCid, {}), true);
    assert.deepEqual(handleHook('PreInvocation', { common: { conversationId: subCid } }), {});

    // 2. AGY_HUD_DEFAULT_PERSONA='normal' override
    const freshCid = makeUuid(100);
    const prevDef = process.env.AGY_HUD_DEFAULT_PERSONA;
    process.env.AGY_HUD_DEFAULT_PERSONA = 'normal';
    try {
      assert.equal(personaMode.getMode(freshCid), 'normal');
      const hookOut = handleHook('PreInvocation', { common: { conversationId: freshCid } });
      assert.ok(hookOut.injectSteps[0].ephemeralMessage.includes('正常助手模式'));
    } finally {
      if (prevDef === undefined) delete process.env.AGY_HUD_DEFAULT_PERSONA;
      else process.env.AGY_HUD_DEFAULT_PERSONA = prevDef;
    }

    // 3. Lock timeout throws instead of running unlocked
    const lockPath = path.join(TMP_DATA, 'pending_new_chats.lock');
    fs.writeFileSync(lockPath, '99999:' + Date.now(), 'utf8');
    try {
      assert.throws(() => personaMode.stagePendingNewChat('normal', 'locked-tok'), /lock timeout/i);
    } finally {
      fs.rmSync(lockPath, { force: true });
    }

    // 4. hud-hook.cjs handles oversized stdin (> 256 KB) safely without crashing
    const hugeStdin = JSON.stringify({ conversationId: CONV_A, padding: 'x'.repeat(300 * 1024) });
    const hookRes = spawnSync(process.execPath, [path.join(ROOT, 'plugins/agy-hud/scripts/hud-hook.cjs'), 'PreInvocation'], {
      input: hugeStdin,
      encoding: 'utf8',
      env: process.env
    });
    assert.equal(hookRes.status, 0);
    assert.equal(hookRes.stdout.trim(), '{}');
  });

  test('backend-patcher.cjs: parseContextLimit boundaries, malformed buffer clean Errors, and --context-limit bad --json', () => {
    assert.throws(() => bp.parseContextLimit(256000), /between 256001 and 1048576/);
    assert.throws(() => bp.parseContextLimit(1048577), /between 256001 and 1048576/);
    assert.equal(bp.parseContextLimit('512000'), 512000);
    assert.equal(bp.parseContextLimit(256001), 256001);
    assert.equal(bp.parseContextLimit(1048576), 1048576);

    const malformedBuffers = [
      Buffer.alloc(0),
      Buffer.from('MZshort'),
      Buffer.concat([Buffer.from('MZ'), Buffer.alloc(62, 0xFF)]),
      Buffer.from('\x7fELFshort', 'latin1'),
      Buffer.from([0xCF, 0xFA, 0xED, 0xFE, 0x00, 0x00])
    ];
    for (const buf of malformedBuffers) {
      assert.throws(
        () => new bp.BinaryImage(buf),
        (err) => err instanceof Error && !(err instanceof RangeError)
      );
    }

    const cliErrRes = spawnSync(process.execPath, [path.join(ROOT, 'core/backend-patcher.cjs'), '--context-limit', 'bad', '--json'], {
      encoding: 'utf8'
    });
    assert.equal(cliErrRes.status, 1);
    const parsedErr = JSON.parse(cliErrRes.stdout);
    assert.ok(typeof parsedErr.error === 'string' && parsedErr.error.length > 0);
  });
});
