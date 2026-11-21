'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const P = require('../paths.cjs');

const ROOT = P.PROJECT_ROOT;
const SWARM_BOARD_DIR = path.join(
  os.homedir(),
  '.gemini', 'antigravity', 'builtin', 'plugins', 'swarm', 'sidecars', 'swarm_board'
);

const INDEX_HTML_PATH = path.join(SWARM_BOARD_DIR, 'index.html');
const HIVE_JS_PATH = path.join(SWARM_BOARD_DIR, 'hive.js');
const APP_JS_PATH = path.join(SWARM_BOARD_DIR, 'app.js');
const BOOTSTRAP_JS_PATH = path.join(SWARM_BOARD_DIR, 'narrator_bootstrap.js');
const SWARM_I18N_PATH = path.join(P.CHINESE_ROOT, 'core', 'swarm-i18n.js');
const SWARM_DICT_PATH = path.join(P.CHINESE_ROOT, 'dict', 'scoped', 'swarm.json');

function loadJSDOM() {
  try { return require('jsdom').JSDOM; } catch (_) {}
  for (const c of [path.join(ROOT, 'node_modules', 'jsdom'), path.join(P.CHINESE_ROOT, 'node_modules', 'jsdom')]) {
    if (fs.existsSync(c)) return require(c).JSDOM;
  }
  throw new Error('JSDOM not found');
}

const JSDOM = loadJSDOM();

async function waitFor(fn, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const res = fn();
    if (res) return res;
    await new Promise((r) => setTimeout(r, 10));
  }
  const finalRes = fn();
  assert.ok(finalRes, 'waitFor timed out');
  return finalRes;
}

function buildSnapshot(overrides = {}) {
  const baseTime = Date.UTC(2026, 10, 19, 10, 0, 0);
  const members = [
    { name: 'coordinator', role: 'coordinator', status: 'working', activity: 'Waiting for posts', activity_zh: '等待看板消息', steps: 3, posts: 2, unread: 0, model: 'gemini-3-pro', local: true, conversation_id: 'conv-coord' },
    { name: 'worker-1', role: 'worker', status: 'working', title: 'Audit auth module', title_zh: '审查权限模块', activity: 'Read src/app.js', activity_zh: '读取 src/app.js', steps: 5, posts: 2, unread: 1, last_read_seq: 2, model: 'gemini-3-flash', local: true, conversation_id: 'conv-w1', channels: ['main', 'dev'] },
    { name: 'worker-2', role: 'worker', status: 'waiting', activity: '', steps: 2, posts: 1, unread: 0, model: 'claude-sonnet', local: false, owner: { label: 'dev-box.local', kind: 'ssh' }, last_seen: Date.now() - 120000, conversation_id: 'conv-w2', channels: ['*'] },
    { name: 'worker-3', role: 'worker', status: 'killed', killed: true, steps: 1, posts: 1, unread: 0, model: 'gemini-3-flash', local: true, conversation_id: 'conv-w3' },
    { name: 'narrator-1', role: 'narrator', narrator: true, roleWorker: true, status: 'waiting', last_read_seq: 3, transcriptMtime: Date.now() - 5000, conversation_id: 'conv-nar' },
  ];
  const messages = [
    {
      seq: 1,
      agent: 'coordinator',
      ts: baseTime,
      mentions: ['worker-1'],
      text: '@worker-1 Please audit `src/auth.js` and report back.',
      text_zh: '@worker-1 请审查 `src/auth.js` 并汇报结果。',
    },
    {
      seq: 2,
      agent: 'worker-1',
      ts: baseTime + 45000,
      channel: 'dev',
      mentions: ['coordinator'],
      text: '@coordinator Summary: all tests passed.\n```js\nconst ok = true;\n```',
      text_zh: '@coordinator 摘要：所有测试通过。\n```js\nconst ok = true;\n```',
    },
    {
      seq: 3,
      agent: 'worker-2',
      ts: baseTime + 90000,
      all: true,
      mentions: [],
      text: 'Could you review #2 before we merge? unique_en_token',
      text_zh: '请先审阅 #2 再合并好吗？唯一中文关键词',
    },
    {
      seq: 4,
      agent: 'coordinator',
      ts: baseTime + 120000,
      control: { op: 'create', channel: 'dev' },
      text: '[channel] coordinator created #dev',
      text_zh: '[频道] coordinator 创建了频道 #dev',
    },
    {
      seq: 5,
      agent: 'outsider',
      ts: baseTime + 150000,
      mentions: [],
      text: 'External ping #1 and @worker-1',
      text_zh: '请@worker-1查看#1已完成',
    },
  ];
  const rawViewJson = {
    version: 1,
    as_of_seq: 5,
    headline: 'Audit in progress',
    phase: { label: 'Verification', index: 1, total: 2 },
    goal: { title: 'Ship localization', line: 'Translate all visible views' },
    running_summary: 'Checking frontend and tests.',
    attention: [
      {
        id: 'att-1',
        kind: 'review',
        severity: 'high',
        title: 'Review auth audit',
        why: 'Waiting for coordinator approval',
        refs: [{ seq: 2 }, { member: 'worker-1' }, { seq: 999 }],
        actions: [
          { type: 'board_post', target: 2, label: 'Open #2' },
          { type: 'url', target: 'http://insecure.example/x', label: 'Bad' },
          { type: 'url', target: 'https://docs.example.com/guide', label: 'Docs' },
        ],
      },
    ],
    workstreams: [
      { id: 'ws-1', title: 'Audit auth', owners: ['worker-1'], state: 'active', note: '1 of 2 checks', refs: [{ seq: 2 }] },
      { id: 'ws-2', title: 'Setup channel', owners: ['worker-2'], state: 'done', note: 'Completed', refs: [{ seq: 3 }] },
    ],
    threads: [
      { id: 'th-1', title: 'Core thread', goal: 'Complete audit', now: 'Running checks', workstreams: ['ws-1', 'ws-2'], attention: ['att-1'] },
    ],
    feedback_ack: { through_seq: 2, text: 'Updated labels' },
  };
  const viewZhJson = {
    ...rawViewJson,
    headline: '正在进行审查',
    phase: { label: '验证阶段', index: 1, total: 2 },
    goal: { title: '完成中文本地化', line: '翻译所有可见视图' },
    running_summary: '正在检查前端与测试。',
    attention: [
      {
        ...rawViewJson.attention[0],
        title: '审阅权限审查',
        why: '等待协调者批准',
      },
    ],
    workstreams: [
      { ...rawViewJson.workstreams[0], title: '审查权限模块', note: '已完成 1/2 项检查' },
      { ...rawViewJson.workstreams[1], title: '配置频道', note: '已完成' },
    ],
    threads: [
      { ...rawViewJson.threads[0], title: '核心任务线', goal: '完成审计', now: '正在执行检查' },
    ],
    feedback_ack: { through_seq: 2, text: '已更新标签文案' },
  };
  const planRaw = {
    goal: { title: 'Ship localization', line: 'Translate all views' },
    tasks: { 'worker-1': 'Audit auth module', 'worker-2': 'Verify UI' },
    threads: [{ id: 'p-1', title: 'Frontend', goal: 'Localize UI', tasks: ['worker-1', 'worker-2'] }],
  };
  const planZh = {
    goal: { title: '完成中文本地化', line: '翻译所有视图' },
    tasks: { 'worker-1': '审查权限模块', 'worker-2': '验证界面' },
    threads: [{ id: 'p-1', title: '前端模块', goal: '中文化界面', tasks: ['worker-1', 'worker-2'] }],
  };

  return {
    swarm: 'swarm-1',
    id: 'swarm-1',
    conversationId: 'conv-coord',
    dir: '/tmp/swarm-1',
    title: 'Localization Sprint',
    title_zh: '本地化冲刺',
    head: 5,
    member: 'worker-1',
    etag: 'etag-1',
    builtinOverview: true,
    graphTab: true,
    rawTab: true,
    urlHosts: ['docs.example.com'],
    allowedFiles: { '/tmp/report.md': 'file:///tmp/report.md' },
    narrator: { name: 'narrator-1', conversation_id: 'conv-nar', last_read_seq: 3, transcriptMtime: Date.now() - 5000 },
    narratorState: 'waiting',
    members,
    channels: [
      { name: 'dev', topic: 'Development', created_by: 'coordinator', archived: false },
      { name: 'archived-ch', topic: 'Old', created_by: 'coordinator', archived: true },
    ],
    messages,
    unseen: [5],
    view: {
      exists: true,
      json: rawViewJson,
      jsonMtime: Date.now() - 10000,
      html: '<html><body><div data-narrator-id="att-1" id="nar-box">Custom view</div><script>window.narrator.onData((v)=>{ window.__LAST_VIEW = v; });</script></body></html>',
      htmlKey: 'hk-1',
      dir: '/tmp/swarm-1',
    },
    view_zh: viewZhJson,
    plan: planRaw,
    plan_zh: planZh,
    frames: [
      { path: '/frame1.png', seq: 1, caption: 'Initial layout', caption_zh: '初始布局' },
      { path: '/frame2.png', seq: 3, caption: 'Updated board', caption_zh: '更新后的看板' },
    ],
    systemAttention: [
      { id: 'sys-1', kind: 'stuck', member: 'worker-1', text: 'worker-1: no progress, and not waiting on the board', text_zh: 'worker-1: 暂无进展，且未在看板等待', since: Date.now() - 65000, conversation_id: 'conv-w1', detail: 'idle' },
    ],
    source: {
      label: 'Cluster',
      state: 'live',
      swarm_id: 'swarm-1',
      owners: [{ label: 'host-a' }, { label: 'host-b' }],
    },
    raw: {
      members: '{"members":[{"name":"coordinator"}]}',
      board: '{"seq":1,"text":"raw board line 1"}\n{"seq":2,"text":"raw board line 2"}\n',
      view: '{"headline":"Audit in progress"}',
    },
    ...overrides,
  };
}

function openSwarmDom(t, opts = {}) {
  const indexRaw = fs.readFileSync(INDEX_HTML_PATH, 'utf8');
  const hiveCode = fs.readFileSync(HIVE_JS_PATH, 'utf8');
  const appCode = fs.readFileSync(APP_JS_PATH, 'utf8');
  const bootstrapCode = fs.readFileSync(BOOTSTRAP_JS_PATH, 'utf8');

  const html = indexRaw
    .replace(/<link\b[^>]*>/gi, '')
    .replace(/<script\b[^>]*src="\/(?:preload|hive|app)\.js"[^>]*><\/script>/gi, '');

  const snapshots = Array.isArray(opts.snapshots) ? opts.snapshots.slice() : [opts.snapshot || buildSnapshot()];
  let snapIndex = 0;
  const scrollCalls = [];
  const scrollByCalls = [];
  const openedConversations = [];
  const openedAuxPanes = [];
  const clipboardWrites = [];
  const resizeCallbacks = [];

  const dom = new JSDOM(html, {
    url: opts.url || 'http://127.0.0.1:4321/?tab=feed',
    runScripts: 'outside-only',
    pretendToBeVisual: true,
    beforeParse(win) {
      win.CSS = { escape: (s) => String(s).replace(/([^\w-])/g, '\\$1') };
      win.ResizeObserver = class {
        constructor(cb) { this.cb = cb; resizeCallbacks.push(cb); }
        observe() {}
        unobserve() {}
        disconnect() {}
      };
      win.HTMLCanvasElement.prototype.getContext = () => ({
        imageSmoothingEnabled: false,
        clearRect() {},
        fillRect() {},
        fillStyle: '',
      });
      win.HTMLCanvasElement.prototype.toDataURL = () => 'data:image/png;base64,stub';
      win.Element.prototype.scrollIntoView = () => {};
      win.scrollTo = (arg) => {
        const top = typeof arg === 'object' && arg ? arg.top : arg;
        scrollCalls.push(top);
        if (Number.isFinite(top)) {
          try { Object.defineProperty(win, 'scrollY', { value: top, configurable: true, writable: true }); } catch {}
        }
      };
      win.scrollBy = (dx, dy) => {
        scrollByCalls.push({ dx, dy });
      };
      win.open = () => null;
      Object.defineProperty(win.navigator, 'clipboard', {
        configurable: true,
        value: {
          writeText: async (text) => {
            if (opts.clipboardFail) throw new Error('clipboard denied');
            clipboardWrites.push(text);
          },
        },
      });
      if (opts.sidecar !== null) {
        win.sidecar = opts.sidecar || {
          conversationId: 'conv-w1',
          ui: {
            toggleConversation: (id) => openedConversations.push(id),
            toggleAuxPane: (arg) => openedAuxPanes.push(arg),
          },
        };
      }
      if (opts.langMode) {
        win.localStorage.setItem('swarm.langMode', opts.langMode);
      }
      if (opts.plainPref !== undefined) {
        if (opts.plainPref === null) win.localStorage.removeItem('swarm_board.narrator_plain');
        else win.localStorage.setItem('swarm_board.narrator_plain', opts.plainPref);
      }
      win.fetch = async (url) => {
        const u = String(url);
        if (u.startsWith('/narrator_bootstrap.js')) {
          return { ok: true, status: 200, text: async () => bootstrapCode };
        }
        if (u.startsWith('/api/swarm')) {
          if (opts.onApiSwarm) return opts.onApiSwarm(u);
          const parsed = new URL(u, 'http://127.0.0.1:4321');
          const reqEtag = parsed.searchParams.get('etag') || '';
          const cur = snapshots[Math.min(snapIndex, snapshots.length - 1)];
          if (typeof cur === 'function') return cur(parsed, reqEtag);
          if (cur && cur.swarm && reqEtag && reqEtag === cur.etag) {
            return { ok: true, status: 200, json: async () => ({ swarm: cur.swarm, etag: cur.etag, unchanged: true, member: cur.member }) };
          }
          return { ok: true, status: 200, json: async () => cur };
        }
        return { ok: false, status: 404, text: async () => 'not found' };
      };
      if (opts.beforeParse) opts.beforeParse(win);
    },
  });

  t.after(() => {
    try { dom.window.close(); } catch {}
  });

  const { window: win } = dom;
  const { document: doc } = win;
  win.eval(hiveCode);
  win.eval(appCode);

  return {
    dom,
    win,
    doc,
    scrollCalls,
    scrollByCalls,
    openedConversations,
    openedAuxPanes,
    clipboardWrites,
    resizeCallbacks,
    pushSnapshot(nextSnap) {
      snapshots.push(nextSnap);
      snapIndex = snapshots.length - 1;
    },
    setSnapshot(nextSnap) {
      snapshots[0] = nextSnap;
      snapIndex = 0;
    },
  };
}

describe('Swarm Panel Frontend Localization & UX (M2)', () => {
  test('S1: static chrome, empty state, live status, title fallback and tabs are localized', async (t) => {
    const ctx = openSwarmDom(t, { snapshot: buildSnapshot() });
    const { doc, win } = ctx;
    await waitFor(() => !doc.getElementById('board').classList.contains('hidden'));

    assert.equal(doc.documentElement.lang, 'zh-CN');
    assert.equal(doc.title, 'Swarm 协作看板');
    assert.equal(doc.querySelector('#loading .loading-caption').textContent.trim(), '正在查找此会话的 Swarm…');
    assert.ok(doc.querySelector('[data-testid="swarm-empty-state"]'));
    assert.ok(doc.querySelector('[data-testid="swarm-tabs"]'));

    assert.equal(doc.getElementById('tabbtn-overview').childNodes[0].nodeValue, '概览');
    assert.equal(doc.getElementById('tabbtn-feed').childNodes[0].nodeValue, '看板');
    assert.equal(doc.getElementById('tabbtn-members').childNodes[0].nodeValue, '成员');
    assert.equal(doc.getElementById('tabbtn-graph').textContent.trim(), '关系图');
    assert.equal(doc.getElementById('tabbtn-raw').textContent.trim(), '原始数据');

    assert.equal(doc.getElementById('swarm-title').textContent, '本地化冲刺');
    assert.equal(doc.getElementById('live-label').textContent, '实时');
    assert.equal(doc.getElementById('live').title, '自动更新');

    // Title fallback when both title and title_zh are absent
    ctx.pushSnapshot(buildSnapshot({ title: '', title_zh: '', etag: 'etag-untitled' }));
    await waitFor(() => doc.getElementById('swarm-title').textContent === '未命名 Swarm');

    // Empty state with and without conversationId (and no bare '.' text node)
    ctx.pushSnapshot({ swarm: null, conversationId: 'conv-empty' });
    await waitFor(() => !doc.getElementById('empty').classList.contains('hidden'), 4500);
    assert.equal(doc.getElementById('empty-title').textContent.trim(), '此会话尚无 Swarm');
    assert.ok(doc.getElementById('empty-body').innerHTML.includes('<code>/swarm</code>'));
    const childTextNodes = [...doc.getElementById('empty-body').childNodes].filter((n) => n.nodeType === 3).map((n) => n.nodeValue);
    assert.ok(!childTextNodes.includes('.'));
    assert.equal(doc.querySelector('#empty .empty-hint').textContent.trim(), '等待 Swarm 启动');

    // Empty state without conversationId (standalone pane with no sidecar conversationId)
    const noConvCtx = openSwarmDom(t, {
      snapshot: { swarm: null, conversationId: '' },
      sidecar: null,
      url: 'http://127.0.0.1:4321/',
    });
    await waitFor(() => !noConvCtx.doc.getElementById('empty').classList.contains('hidden'));
    assert.ok(noConvCtx.doc.getElementById('empty-body').textContent.includes('从会话中打开此面板'));
    assert.ok(noConvCtx.doc.getElementById('empty-body').innerHTML.includes('<code>/swarm</code>'));
    const noConvTextNodes = [...noConvCtx.doc.getElementById('empty-body').childNodes].filter((n) => n.nodeType === 3).map((n) => n.nodeValue);
    assert.ok(!noConvTextNodes.includes('.'));

    // Live stale status on fetch failures
    let nowVal = Date.now();
    const origNow = win.Date.now;
    win.Date.now = () => nowVal;
    let failMode = false;
    const staleCtx = openSwarmDom(t, {
      onApiSwarm: () => {
        if (failMode) throw new Error('network down');
        return { ok: true, status: 200, json: async () => buildSnapshot() };
      },
      beforeParse: (w) => {
        w.Date.now = () => nowVal;
        w.console.warn = () => {};
      },
    });
    await waitFor(() => !staleCtx.doc.getElementById('board').classList.contains('hidden'));
    failMode = true;
    nowVal += 8000;
    await waitFor(() => staleCtx.doc.getElementById('live-label').textContent === '正在重新连接');
    assert.equal(staleCtx.doc.getElementById('live').title, '已与 Swarm 辅助进程断开连接，正在重试');
    win.Date.now = origNow;
  });

  test('S2: all toast messages are localized (remote, performAction, feedbackIntent, gate)', async (t) => {
    const ctx = openSwarmDom(t, {
      snapshot: buildSnapshot({ builtinOverview: true }),
      sidecar: null,
      plainPref: '0',
      url: 'http://127.0.0.1:4321/?tab=overview&narrator=frame',
    });
    const { doc, win } = ctx;
    await waitFor(() => !!doc.querySelector('#ov-frame iframe'));
    const iframe = doc.querySelector('#ov-frame iframe');

    // Simulate READY from iframe
    win.dispatchEvent(new win.MessageEvent('message', { data: { type: 'READY' }, source: iframe.contentWindow }));

    // 1. Gate denied toast when userActivation is inactive
    win.dispatchEvent(new win.MessageEvent('message', {
      data: { type: 'NAVIGATE', action: { type: 'url', target: 'https://docs.example.com/guide' } },
      source: iframe.contentWindow,
    }));
    await waitFor(() => doc.getElementById('toast').textContent.includes('请点击视图中的链接以打开'));

    // Stub active user gesture focused inside iframe
    let perfNow = 10000;
    win.performance.now = () => perfNow;
    Object.defineProperty(win.navigator, 'userActivation', { configurable: true, value: { isActive: true } });
    Object.defineProperty(doc, 'activeElement', { configurable: true, get: () => iframe });

    // 2. Disallowed URL toast
    perfNow += 400;
    win.dispatchEvent(new win.MessageEvent('message', {
      data: { type: 'NAVIGATE', action: { type: 'url', target: 'http://evil.example/' } },
      source: iframe.contentWindow,
    }));
    await waitFor(() => doc.getElementById('toast').textContent === '此链接在这里不被允许打开。');

    // 3. open_conv without desktop app
    Object.defineProperty(win.navigator, 'userActivation', { configurable: true, value: { isActive: false } });
    await new Promise((r) => setTimeout(r, 260));
    Object.defineProperty(win.navigator, 'userActivation', { configurable: true, value: { isActive: true } });
    perfNow += 400;
    win.dispatchEvent(new win.MessageEvent('message', {
      data: { type: 'NAVIGATE', action: { type: 'open_conv', target: 'worker-1' } },
      source: iframe.contentWindow,
    }));
    await waitFor(() => doc.getElementById('toast').textContent === '打开 worker-1 的会话需要在桌面应用中使用。');

    // 4. file without desktop app
    Object.defineProperty(win.navigator, 'userActivation', { configurable: true, value: { isActive: false } });
    await new Promise((r) => setTimeout(r, 260));
    Object.defineProperty(win.navigator, 'userActivation', { configurable: true, value: { isActive: true } });
    perfNow += 400;
    win.dispatchEvent(new win.MessageEvent('message', {
      data: { type: 'NAVIGATE', action: { type: 'file', target: '/tmp/report.md' } },
      source: iframe.contentWindow,
    }));
    await waitFor(() => doc.getElementById('toast').textContent === '打开文件需要在桌面应用中使用。');

    // 5. FEEDBACK_INTENT local toast
    Object.defineProperty(win.navigator, 'userActivation', { configurable: true, value: { isActive: false } });
    await new Promise((r) => setTimeout(r, 260));
    Object.defineProperty(win.navigator, 'userActivation', { configurable: true, value: { isActive: true } });
    perfNow += 400;
    win.dispatchEvent(new win.MessageEvent('message', {
      data: { type: 'FEEDBACK_INTENT', target_id: 'att-1' },
      source: iframe.contentWindow,
    }));
    await waitFor(() => doc.getElementById('toast').textContent.includes('已复制“对卡片 att-1 的反馈:”'));

    // 6. Remote member openConversation toast via Graph node click
    const ctx2 = openSwarmDom(t, { snapshot: buildSnapshot(), url: 'http://127.0.0.1:4321/?tab=graph' });
    await waitFor(() => !ctx2.doc.getElementById('board').classList.contains('hidden'));
    const remoteNode = [...ctx2.doc.querySelectorAll('#graph .node')].find((g) => g.dataset.conv === 'conv-w2');
    assert.ok(remoteNode);
    remoteNode.dispatchEvent(new ctx2.win.MouseEvent('click', { bubbles: true }));
    await waitFor(() => ctx2.doc.getElementById('toast').textContent.includes('worker-2 运行在 dev-box.local'));
  });

  test('S3: board chrome, filters, channels, agent chips, empty/no-match states & zh-CN dates', async (t) => {
    const ctx = openSwarmDom(t, { snapshot: buildSnapshot() });
    const { doc, win } = ctx;
    await waitFor(() => doc.querySelectorAll('#feed .msg').length > 0);

    assert.equal(doc.getElementById('f-search').placeholder, '搜索');
    assert.equal(doc.getElementById('f-search').getAttribute('aria-label'), '搜索看板消息');
    assert.equal(doc.getElementById('f-toggle').title, '筛选');

    // Filter selects
    const agentOpts = [...doc.getElementById('f-agent').options].map((o) => o.textContent);
    assert.equal(agentOpts[0], '所有发送者');
    assert.ok(agentOpts.includes('来自 coordinator'));

    const mentionOpts = [...doc.getElementById('f-mention').options].map((o) => o.textContent);
    assert.deepEqual(mentionOpts.slice(0, 3), ['所有接收者', '未提及任何人', '提及 @all']);
    assert.ok(mentionOpts.includes('提及 worker-1'));

    const chanOpts = [...doc.getElementById('f-channel').options].map((o) => o.textContent);
    assert.equal(chanOpts[0], '所有频道');
    assert.ok(chanOpts.includes('#archived-ch（已归档）'));

    // Channel tabs
    const chanTabs = [...doc.querySelectorAll('#channel-tabs .channel-tab')];
    assert.equal(chanTabs[0].textContent, '全部');
    assert.equal(chanTabs[0].title, '所有频道的消息');
    assert.ok(chanTabs[1].title.includes('整个 Swarm 均可读取'));
    assert.ok(chanTabs[3].title.includes('已归档'));

    // Agent chips: (you) -> (你)
    const chips = [...doc.querySelectorAll('#agents .chip')];
    const myChip = chips.find((c) => c.dataset.agent === 'worker-1');
    assert.ok(myChip.textContent.includes('(你)'));
    assert.ok(myChip.title.includes('2 条消息'));
    assert.ok(myChip.title.includes('点击在看板中隐藏'));
    myChip.click();
    assert.equal(doc.getElementById('f-toggle').title, '筛选 (已启用)');
    assert.ok(doc.querySelector('#agents .chip[data-agent="worker-1"]').title.includes('当前已在看板中隐藏；点击显示'));
    doc.querySelector('#agents .chip[data-agent="worker-1"]').click();

    // Message channel chip tooltip, outsider note, aria-label, unread divider
    const devChip = doc.querySelector('.msg-channel[data-channel="dev"]');
    assert.equal(devChip.title, '发布于 #dev；点击仅显示 #dev');
    const msg1 = doc.querySelector('article.msg[data-seq="1"]');
    assert.ok(msg1.getAttribute('aria-label').includes('发送给 worker-1'));
    const outsiderMsg = doc.querySelector('article.msg[data-seq="5"]');
    assert.equal(outsiderMsg.querySelector('.msg-note').textContent, '不在成员列表中');
    assert.equal(outsiderMsg.querySelector('.msg-author').title, '不在成员列表中');
    assert.equal(doc.querySelector('[data-testid="swarm-unread-divider"]').textContent, '新消息');

    // No-match empty state + clear filters
    doc.getElementById('f-search').value = 'definitely_no_such_message_xyz';
    doc.getElementById('f-search').dispatchEvent(new win.Event('input', { bubbles: true }));
    assert.equal(doc.querySelector('.feed-empty-title').textContent, '没有匹配的消息');
    assert.equal(doc.querySelector('[data-clear-filters]').textContent, '清除筛选');
    doc.querySelector('[data-clear-filters]').click();
    assert.ok(doc.querySelectorAll('#feed .msg').length === 5);

    // No posts yet empty state
    ctx.pushSnapshot(buildSnapshot({ messages: [], head: 0, etag: 'etag-empty-msgs' }));
    await waitFor(() => doc.querySelector('.feed-empty-title')?.textContent === '暂无消息');
  });

  test('S4: message translation, Tier-1 fallback, CJK mentions/citations & protocol preservation', async (t) => {
    const snap = buildSnapshot({
      messages: [
        {
          seq: 1,
          agent: 'coordinator',
          ts: Date.UTC(2026, 10, 19, 10, 0, 0),
          mentions: ['worker-1'],
          text: '@worker-1: [done] Waiting for posts.\n```ts\nconst rawCode = "[done] Waiting for posts";\n```\nSee `Read src/app.ts` and https://example.com/a',
          text_zh: null,
        },
        {
          seq: 2,
          agent: 'worker-1',
          ts: Date.UTC(2026, 10, 19, 10, 1, 0),
          channel: 'dev',
          mentions: ['coordinator'],
          text: 'Could you check #1 and @#dev?',
          text_zh: '请@coordinator查看#1已完成，并在@#dev频道同步。',
        },
        {
          seq: 3,
          agent: 'coordinator',
          ts: Date.UTC(2026, 10, 19, 10, 2, 0),
          mentions: [],
          // Raw text starts with [done], while Chinese text starts with [已完成]
          text: '[done] All tasks finished.',
          text_zh: '[已完成] 所有任务已完成。',
        },
      ],
      head: 3,
      narratorState: 'waiting',
      systemAttention: [],
      members: [
        { name: 'coordinator', role: 'coordinator', status: 'waiting', replied: true, steps: 2, posts: 2, unread: 0 },
        { name: 'worker-1', role: 'worker', status: 'waiting', steps: 2, posts: 1, unread: 0 },
      ],
    });
    const ctx = openSwarmDom(t, { snapshot: snap });
    const { doc, win } = ctx;
    await waitFor(() => doc.querySelectorAll('#feed .msg').length === 3);

    // Tier-1 fallback unit assertions
    const fb = win.SwarmHive.tier1Fallback;
    assert.ok(fb('[done] All tests passed').includes('[已完成]'));
    assert.ok(fb('[stall] timeout').includes('[停滞告警]'));
    assert.ok(fb('[quota] exceeded').includes('[额度告警]'));
    assert.ok(fb('[blocked] on @worker-1').includes('[阻塞]'));
    assert.equal(fb('Waiting for posts'), '等待看板消息');
    assert.equal(fb('Read src/main.mjs'), '读取 src/main.mjs');
    assert.equal(fb('worker-1: last step failed (quota)'), 'worker-1: 上一步执行失败（额度耗尽）');
    assert.equal(fb('worker-1: no progress, and not waiting on the board'), 'worker-1: 暂无进展，且未在看板等待');
    const codePreserved = fb('[done] check `Waiting for posts` and ```js\nWaiting for posts\n```');
    assert.ok(codePreserved.startsWith('[已完成]'));
    assert.ok(codePreserved.includes('`Waiting for posts`'));
    assert.ok(codePreserved.includes('Waiting for posts\n```'));

    // CJK-adjacent mention, channel mention, and citation highlighting in msg 2
    const msg2Body = doc.querySelector('article.msg[data-seq="2"] .msg-body');
    assert.ok(msg2Body.querySelector('.mention'));
    assert.equal(msg2Body.querySelector('.mention:not(.channel)').textContent, '@coordinator');
    assert.equal(msg2Body.querySelector('.mention.channel').textContent, '@#dev');
    assert.equal(msg2Body.querySelector('button.seq-ref[data-seq-ref="1"]').textContent, '#1');

    // Msg 1 preserves fenced code block & URL & inline code while translating [done]
    const msg1Body = doc.querySelector('article.msg[data-seq="1"] .msg-body');
    assert.ok(msg1Body.textContent.includes('[已完成]'));
    assert.ok(msg1Body.querySelector('pre').textContent.includes('const rawCode = "[done] Waiting for posts";'));
    assert.ok(msg1Body.querySelector('code').textContent.includes('Read src/app.ts'));

    // Raw [done] badge clearance on Overview tab (coordinator replied + last post raw text starts with [done])
    assert.ok(doc.getElementById('tab-badge-overview').classList.contains('hidden'));
  });

  test('S5: scroll stability & measureClamps across async text_zh updates', async (t) => {
    const snap1 = buildSnapshot({
      etag: 'etag-s5-1',
      messages: [
        { seq: 1, agent: 'coordinator', ts: Date.UTC(2026, 10, 19, 10, 0, 0), mentions: [], text: 'Long post 1', text_zh: '长消息 1' },
        { seq: 2, agent: 'worker-1', ts: Date.UTC(2026, 10, 19, 10, 1, 0), mentions: [], text: 'Long post 2', text_zh: null },
      ],
      head: 2,
    });
    const ctx = openSwarmDom(t, { snapshot: snap1 });
    const { doc, win, scrollCalls } = ctx;
    await waitFor(() => doc.querySelectorAll('#feed .msg').length === 2);

    // Stub overflow on .msg-body elements so measureClamps shows .msg-more
    const proto = win.HTMLElement.prototype;
    const origScrollH = Object.getOwnPropertyDescriptor(proto, 'scrollHeight');
    const origClientH = Object.getOwnPropertyDescriptor(proto, 'clientHeight');
    Object.defineProperty(proto, 'scrollHeight', {
      configurable: true,
      get() {
        if (this.classList && this.classList.contains('msg-body')) return 240;
        if (this === doc.documentElement || this === doc.body) return 2000;
        return origScrollH ? origScrollH.get.call(this) : 0;
      },
    });
    Object.defineProperty(proto, 'clientHeight', {
      configurable: true,
      get() {
        if (this.classList && this.classList.contains('msg-body')) return 100;
        return origClientH ? origClientH.get.call(this) : 0;
      },
    });

    // Re-trigger measureClamps via language toggle or resize
    win.dispatchEvent(new win.Event('resize'));
    await waitFor(() => !doc.querySelector('article.msg[data-seq="1"] .msg-more').classList.contains('hidden'));

    const moreBtn = doc.querySelector('article.msg[data-seq="1"] .msg-more');
    assert.equal(moreBtn.textContent, '展开更多');
    moreBtn.click();
    assert.equal(moreBtn.textContent, '收起');
    assert.equal(moreBtn.getAttribute('aria-expanded'), 'true');
    assert.ok(doc.querySelector('article.msg[data-seq="1"] .msg-body').classList.contains('open'));

    // Simulate user scrolled up (!stick)
    Object.defineProperty(win, 'innerHeight', { configurable: true, value: 600 });
    Object.defineProperty(win, 'scrollY', { configurable: true, value: 120, writable: true });
    win.dispatchEvent(new win.Event('scroll'));
    scrollCalls.length = 0;

    // Async etag bump arrives with translated text_zh for seq 2
    const snap2 = buildSnapshot({
      etag: 'etag-s5-2',
      messages: [
        { seq: 1, agent: 'coordinator', ts: Date.UTC(2026, 10, 19, 10, 0, 0), mentions: [], text: 'Long post 1', text_zh: '长消息 1（更新）' },
        { seq: 2, agent: 'worker-1', ts: Date.UTC(2026, 10, 19, 10, 1, 0), mentions: [], text: 'Long post 2', text_zh: '异步翻译完成的第 2 条长消息' },
      ],
      head: 2,
    });
    ctx.pushSnapshot(snap2);
    await waitFor(() => doc.querySelector('article.msg[data-seq="2"] .msg-body').textContent.includes('异步翻译完成'));

    // Expanded state on #1 preserved AND scrollToLatest was NOT called
    const moreAfter = doc.querySelector('article.msg[data-seq="1"] .msg-more');
    assert.equal(moreAfter.textContent, '收起');
    assert.equal(moreAfter.getAttribute('aria-expanded'), 'true');
    assert.ok(doc.querySelector('article.msg[data-seq="1"] .msg-body').classList.contains('open'));
    assert.equal(scrollCalls.length, 0);
  });

  test('S6: Members tab localization', async (t) => {
    const ctx = openSwarmDom(t, {
      snapshot: buildSnapshot(),
      url: 'http://127.0.0.1:4321/?tab=members',
    });
    const { doc } = ctx;
    await waitFor(() => !!doc.querySelector('#members .o2-members'));

    const mRoot = doc.getElementById('members');
    assert.equal(mRoot.querySelector('.o2-src').textContent, 'Cluster · 2 台机器');
    assert.equal(mRoot.querySelector('.o2-msin').placeholder, '搜索成员');
    const secTitles = [...mRoot.querySelectorAll('.o2-msec > span')].map((el) => el.textContent);
    assert.ok(secTitles.includes('活跃成员'));
    assert.ok(secTitles.includes('待命成员'));
    assert.equal(mRoot.querySelector('.o2-mret > span').textContent, '已退出成员');

    const w1Row = mRoot.querySelector('[data-open-member="worker-1"]');
    assert.ok(w1Row.querySelector('.o2-mstat').textContent === '受阻' || w1Row.querySelector('.o2-mstat').textContent === '工作中');
    assert.equal(w1Row.querySelector('.o2-mrole').textContent, '审查权限模块');

    const w2Row = mRoot.querySelector('[data-open-member="worker-2"]');
    assert.ok(w2Row.querySelector('[data-testid="swarm-member-owner"]').title.includes('运行于 dev-box.local'));
    assert.ok(w2Row.querySelector('[data-testid="swarm-member-seen"]').textContent.includes('分钟前在线'));
    assert.equal(w2Row.querySelector('[data-testid="swarm-member-channels"]').textContent, '全部频道');

    // Coordinator working activity / liveTip
    const coordRow = mRoot.querySelector('.o2-mrow.coord');
    assert.equal(coordRow.querySelector('.o2-mstat').textContent, '协调者 · 工作中');
    assert.ok(coordRow.querySelector('[data-testid="swarm-member-activity"]').title.startsWith('最新操作:'));

    // Expand retired workers
    mRoot.querySelector('.o2-mret').click();
    assert.ok(mRoot.querySelector('[data-open-member="worker-3"] .o2-mstat').textContent === '已退出');
  });

  test('S7: Graph, Replay & Raw lossless preservation', async (t) => {
    const ctx = openSwarmDom(t, {
      snapshot: buildSnapshot(),
      url: 'http://127.0.0.1:4321/?tab=graph',
    });
    const { doc } = ctx;
    await waitFor(() => !!doc.querySelector('#graph .node'));

    assert.ok(doc.getElementById('replay-label').textContent.includes('条消息'));
    assert.ok(doc.getElementById('replay-label').textContent.includes('分'));

    const edgeTitles = [...doc.querySelectorAll('#graph .edge title')].map((el) => el.textContent);
    assert.ok(edgeTitles.some((s) => s.includes('直接提及')));

    const nodeTitles = [...doc.querySelectorAll('#graph .node title')].map((el) => el.textContent);
    assert.ok(nodeTitles.some((s) => s.includes('步') && s.includes('条消息') && s.includes('未读')));
    assert.ok(nodeTitles.some((s) => s.includes('outsider（不在成员列表中）')));

    // Scrub replay to post #2 and verify #replay-caption shows translated text_zh
    doc.getElementById('replay-back').click();
    doc.getElementById('replay-start').click();
    doc.getElementById('replay-fwd').click();
    doc.getElementById('replay-fwd').click();
    await waitFor(() => !doc.getElementById('replay-caption').classList.contains('hidden'));
    assert.ok(doc.getElementById('replay-caption').textContent.includes('摘要：所有测试通过'));

    // Raw tab: meta localized while #raw.textContent is byte-for-byte identical to snap.raw
    doc.getElementById('tabbtn-raw').click();
    const rawSnap = buildSnapshot();
    assert.equal(doc.getElementById('raw').textContent, rawSnap.raw.members);
    doc.querySelector('.raw-btn[data-raw="board"]').click();
    assert.equal(doc.getElementById('raw').textContent, rawSnap.raw.board);
    assert.ok(doc.getElementById('raw-meta').textContent.includes('2 行'));
    doc.querySelector('.raw-btn[data-raw="view"]').click();
    assert.equal(doc.getElementById('raw').textContent, rawSnap.raw.view);

    // Empty raw displays (空)
    ctx.pushSnapshot(buildSnapshot({ raw: { members: '', board: '', view: '' }, etag: 'etag-empty-raw' }));
    await waitFor(() => doc.getElementById('raw').textContent === '(空)');
  });

  test('S8: Overview, Lightbox, view_zh sanitization & narrator_bootstrap.js', async (t) => {
    const ctx = openSwarmDom(t, {
      snapshot: buildSnapshot(),
      url: 'http://127.0.0.1:4321/?tab=overview',
    });
    const { doc, win } = ctx;
    await waitFor(() => !!doc.querySelector('#ov-plain .o2'));

    assert.ok(doc.getElementById('ov-status').textContent.includes('已读至 #5'));
    assert.ok(doc.getElementById('ov-system').textContent.includes('系统:'));
    assert.ok(doc.getElementById('ov-system').textContent.includes('暂无进展，且未在看板等待'));
    assert.equal(doc.querySelector('#ov-system button[data-open]').textContent, '打开');
    assert.ok(doc.getElementById('ov-ack').textContent.includes('上次修改：“已更新标签文案”'));
    assert.ok(doc.getElementById('ov-plain').textContent.includes('完成中文本地化'));
    assert.ok(doc.querySelector('#ov-plain .o2-progt').textContent.includes('1 / 2 项任务已完成'));

    // Reel card & scrub update (verifying hive.js:702 regex bug is fixed)
    const reelMeta = doc.querySelector('.o2-rmeta');
    assert.equal(reelMeta.textContent, '1 / 2 项任务已完成');
    const scrub = doc.querySelector('.o2-rscrub');
    scrub.value = '0';
    scrub.dispatchEvent(new win.Event('input', { bubbles: true }));
    assert.equal(doc.querySelector('.o2-rmeta').textContent, '0 / 2 项任务已完成');
    assert.equal(doc.querySelector('.o2-rcap').textContent, '初始布局');

    // Open lightbox (.o2-tv)
    doc.querySelector('.o2-rexp').click();
    const lb = doc.querySelector('.o2-tv');
    assert.ok(lb);
    assert.equal(lb.querySelector('.o2-tvx').getAttribute('aria-label'), '关闭');
    assert.equal(lb.querySelector('.o2-tvnav.prev').getAttribute('aria-label'), '上一帧');
    assert.equal(lb.querySelector('.o2-tvnav.next').getAttribute('aria-label'), '下一帧');
    assert.equal(lb.querySelector('.o2-tvstrip').getAttribute('aria-label'), '画面列表');
    lb.querySelector('.o2-tvx').click();

    // Killed narrator notice keeps <b> and <code> HTML tags (not escaped)
    ctx.pushSnapshot(buildSnapshot({ narratorState: 'killed', etag: 'etag-killed-nar' }));
    await waitFor(() => doc.getElementById('ov-notice').innerHTML.includes('<b>narrator-1</b>'));
    assert.ok(doc.getElementById('ov-notice').innerHTML.includes('<code>narrator-2</code>'));

    // Frame mode: verify sanitizeView(view_zh) -> DATA_UPDATE & narrator_bootstrap.js execution in second JSDOM
    const ctxFrame = openSwarmDom(t, {
      snapshot: buildSnapshot(),
      plainPref: '0',
      url: 'http://127.0.0.1:4321/?tab=overview&narrator=frame',
    });
    await waitFor(() => !!ctxFrame.doc.querySelector('#ov-frame iframe'));
    const iframe = ctxFrame.doc.querySelector('#ov-frame iframe');
    const postedToFrame = [];
    iframe.contentWindow.postMessage = (msg) => postedToFrame.push(msg);

    // Trigger READY -> DATA_UPDATE
    ctxFrame.win.dispatchEvent(new ctxFrame.win.MessageEvent('message', { data: { type: 'READY' }, source: iframe.contentWindow }));
    // Bump snapshot so postData sends DATA_UPDATE
    const snapUpdated = buildSnapshot({ etag: 'etag-frame-2' });
    snapUpdated.view_zh.headline = '已更新的中文总览';
    ctxFrame.pushSnapshot(snapUpdated);
    await waitFor(() => postedToFrame.some((m) => m.type === 'DATA_UPDATE'));
    const du = postedToFrame.find((m) => m.type === 'DATA_UPDATE');
    assert.equal(du.view.headline, '已更新的中文总览');
    // Unsafe http:// action dropped; https:// action kept; out-of-range seq 999 marked unverified
    const att = du.view.attention[0];
    assert.equal(att.id, 'att-1');
    assert.equal(att.actions.some((a) => String(a.target).startsWith('http://')), false);
    assert.equal(att.actions.some((a) => a.target === 'https://docs.example.com/guide'), true);
    assert.equal(att.refs.find((r) => r.seq === 999).unverified, true);

    // Second JSDOM executes iframe.srcdoc (narrator_bootstrap.js + view.html)
    const frameDom = new JSDOM(iframe.srcdoc, {
      url: 'http://127.0.0.1:4321/frame',
      runScripts: 'dangerously',
      beforeParse(fw) {
        fw.ResizeObserver = class { observe() {} disconnect() {} };
        Object.defineProperty(fw, 'parent', { configurable: true, value: { postMessage() {} } });
      },
    });
    t.after(() => { try { frameDom.window.close(); } catch {} });
    await waitFor(() => !!frameDom.window.__LAST_VIEW);
    assert.equal(frameDom.window.__LAST_VIEW.headline, '正在进行审查');
    const narBox = frameDom.window.document.getElementById('nar-box');
    narBox.dispatchEvent(new frameDom.window.MouseEvent('mouseover', { bubbles: true }));
    const fbBtn = [...frameDom.window.document.querySelectorAll('button')].find((b) => b.textContent === '💬');
    assert.ok(fbBtn);
    assert.equal(fbBtn.title, '对此项提供反馈');
    assert.equal(fbBtn.getAttribute('aria-label'), '对此项提供反馈');
  });

  test('S9: clean native-Chinese header (no #lang-mode toggle, ignores legacy localStorage["swarm.langMode"])', async (t) => {
    const ctx = openSwarmDom(t, { snapshot: buildSnapshot() });
    const { doc } = ctx;
    await waitFor(() => doc.querySelectorAll('#feed .msg').length > 0);

    // #lang-mode (译文/对照/原文) toggle bar is completely removed from the header
    assert.equal(doc.querySelector('[data-testid="swarm-lang-mode"]'), null);
    assert.equal(doc.getElementById('lang-mode'), null);
    assert.equal(doc.getElementById('swarm-title').textContent, '本地化冲刺');
    const msg3Body = doc.querySelector('article.msg[data-seq="3"] .msg-body');
    assert.equal(msg3Body.textContent.includes('唯一中文关键词'), true);
    assert.equal(msg3Body.querySelector('.msg-orig'), null);
    assert.ok(msg3Body.nextElementSibling.classList.contains('msg-more'), '.msg-body + .msg-more sibling adjacency preserved');
    assert.equal(doc.getElementById('tabbtn-feed').childNodes[0].nodeValue, '看板');

    // Legacy localStorage['swarm.langMode'] values ('en' or 'bi') must never trap the UI out of Chinese
    for (const staleMode of ['en', 'bi', 'invalid_xyz']) {
      const ctxStale = openSwarmDom(t, { snapshot: buildSnapshot(), langMode: staleMode });
      await waitFor(() => ctxStale.doc.querySelectorAll('#feed .msg').length > 0);
      assert.equal(ctxStale.doc.querySelector('[data-testid="swarm-lang-mode"]'), null);
      assert.equal(ctxStale.doc.getElementById('swarm-title').textContent, '本地化冲刺');
      assert.equal(ctxStale.doc.querySelector('article.msg[data-seq="3"] .msg-body').textContent.includes('唯一中文关键词'), true);
      assert.equal(ctxStale.doc.querySelector('article.msg[data-seq="3"] .msg-body .msg-orig'), null);
    }
  });

  test('S10: bilingual search on Board and Members', async (t) => {
    const ctx = openSwarmDom(t, { snapshot: buildSnapshot() });
    const { doc, win } = ctx;
    await waitFor(() => doc.querySelectorAll('#feed .msg').length === 5);

    const search = doc.getElementById('f-search');
    // Match English-only keyword against raw message text
    search.value = 'unique_en_token';
    search.dispatchEvent(new win.Event('input', { bubbles: true }));
    assert.deepEqual([...doc.querySelectorAll('#feed .msg')].map((el) => el.dataset.seq), ['3']);

    // Match Chinese-only keyword against localized message text
    search.value = '唯一中文关键词';
    search.dispatchEvent(new win.Event('input', { bubbles: true }));
    assert.deepEqual([...doc.querySelectorAll('#feed .msg')].map((el) => el.dataset.seq), ['3']);

    // Members bilingual search
    doc.getElementById('tabbtn-members').click();
    await waitFor(() => !!doc.querySelector('#members .o2-msin'));
    const mSearch = doc.querySelector('#members .o2-msin');
    mSearch.value = '审查权限模块';
    mSearch.dispatchEvent(new win.Event('input', { bubbles: true }));
    assert.equal(doc.querySelector('#members [data-open-member="worker-1"]').style.display, '');
    assert.equal(doc.querySelector('#members [data-open-member="worker-2"]').style.display, 'none');

    mSearch.value = 'Audit auth';
    mSearch.dispatchEvent(new win.Event('input', { bubbles: true }));
    assert.equal(doc.querySelector('#members [data-open-member="worker-1"]').style.display, '');
  });

  test('S11: antigravity-chinese swarm-i18n.js coexistence & zero-mutation safety', async (t) => {
    const ctx = openSwarmDom(t, { snapshot: buildSnapshot(), url: 'http://127.0.0.1:4321/?tab=overview' });
    const { doc, win } = ctx;
    await waitFor(() => !!doc.querySelector('#ov-plain .o2'));

    const i18nCode = fs.readFileSync(SWARM_I18N_PATH, 'utf8');
    const swarmDict = JSON.parse(fs.readFileSync(SWARM_DICT_PATH, 'utf8'));

    const mutations = [];
    const spyObs = new win.MutationObserver((list) => {
      for (const m of list) mutations.push(m);
    });
    spyObs.observe(doc.body, { subtree: true, childList: true, characterData: true, attributes: true });

    win.eval(i18nCode);
    win.localizeSwarm(swarmDict);
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(win.__AGY_SWARM_I18N__, true);
    assert.equal(mutations.length, 0, 'swarm-i18n.js must perform zero mutations on localized swarm_board');

    // Switch to Members tab and ensure status badges and chrome stay Chinese cleanly
    doc.getElementById('tabbtn-members').click();
    await waitFor(() => !!doc.querySelector('#members .o2-members'));
    await new Promise((r) => setTimeout(r, 30));

    const coordStat = doc.querySelector('#members .o2-mrow.coord .o2-mstat').textContent;
    assert.equal(coordStat, '协调者 · 工作中');
    assert.equal(doc.getElementById('tabbtn-members').childNodes[0].nodeValue, '成员');
    spyObs.disconnect();
  });

  test('S12: r2 regressions — Chinese punctuation mentions/briefOf, URL citation isolation, Tier-1 fences/paths, zhTaskTitle & detail tooltips', async (t) => {
    const snap = buildSnapshot({
      narratorState: 'paused',
      narrator: { name: 'narrator-1', conversation_id: 'conv-nar', reason: 'error', detail: 'step failed', last_read_seq: 3, transcriptMtime: Date.now() - 5000 },
      systemAttention: [
        { id: 'sys-err', kind: 'error', member: 'worker-1', text: 'worker-1: last step failed (error)', text_zh: 'worker-1: 上一步执行失败（错误）', conversation_id: 'conv-w1', detail: 'model error' },
        { id: 'sys-w3', kind: 'error', member: 'worker-3', text: 'worker-3: last step failed (error)', text_zh: 'worker-3: 上一步执行失败（错误）', conversation_id: 'conv-w3', detail: 'rate limit exceeded', detail_zh: '超出速率限制' },
      ],
      members: [
        { name: 'coordinator', role: 'coordinator', status: 'waiting', steps: 2, posts: 2, unread: 0 },
        { name: 'worker-1', role: 'worker', status: 'working', title: 'In review', activity: 'Read src/app.js', steps: 1, posts: 1, unread: 0 },
        { name: 'worker-2', role: 'worker', status: 'working', activity: 'Editing auth', steps: 1, posts: 1, unread: 0 },
        { name: 'worker-3', role: 'worker', status: 'waiting', steps: 1, posts: 1, unread: 0, failure: { kind: 'error', text: 'rate limit exceeded' }, failure_zh: '超出速率限制' },
      ],
      view: { exists: false, json: null },
      view_zh: null,
      plan: null,
      plan_zh: null,
      messages: [
        {
          seq: 1,
          agent: 'coordinator',
          ts: Date.UTC(2026, 10, 19, 10, 0, 0),
          mentions: ['worker-2'],
          text: '@worker-2 Implement OAuth2 flow. Report back after.',
          text_zh: '@worker-2，实现 OAuth2 流程。完成后请汇报结果。',
        },
        {
          seq: 2,
          agent: 'coordinator',
          ts: Date.UTC(2026, 10, 19, 10, 1, 0),
          mentions: ['worker-1'],
          text: '@worker-1, please check',
          text_zh: '@worker-1，请查看中文逗号后的内容',
        },
        {
          seq: 3,
          agent: 'coordinator',
          ts: Date.UTC(2026, 10, 19, 10, 2, 0),
          mentions: ['worker-1', 'worker-2'],
          text: '@worker-1 @worker-2: progress',
          text_zh: '@worker-1 、 @worker-2 ：带空格中文标点',
        },
        {
          seq: 4,
          agent: 'worker-1',
          ts: Date.UTC(2026, 10, 19, 10, 3, 0),
          mentions: [],
          text: 'URL test https://example.com/a#12 and https://example.com/#12 and https://example.com/a?x=#12 and real ref #12',
          text_zh: 'URL测试 https://example.com/a#12 和 https://example.com/#12 以及 https://example.com/a?x=#12 和真引用 #12，再试 https://example.com/b?y=#2',
        },
        {
          seq: 5,
          agent: 'worker-3',
          ts: Date.UTC(2026, 10, 19, 10, 4, 0),
          mentions: ['worker-1'],
          text: '@worker-1 check #2',
          text_zh: '@worker-1，请@worker-1查看#2已完成',
        },
      ],
      head: 5,
    });
    const ctx = openSwarmDom(t, { snapshot: snap, url: 'http://127.0.0.1:4321/?tab=feed' });
    const { doc, win } = ctx;
    await waitFor(() => doc.querySelectorAll('#feed .msg').length === 5);

    // T1.4 & T1.5: stripLeadingMentions with Chinese comma and whitespace before punctuation
    assert.equal(doc.querySelector('article.msg[data-seq="2"] .msg-body').textContent.trim(), '请查看中文逗号后的内容');
    assert.equal(doc.querySelector('article.msg[data-seq="3"] .msg-body').textContent.trim(), '带空格中文标点');

    // T1.6: URLs containing #12 / ?x=#12 must NOT render seq-ref buttons; real #12 must
    const msg4Refs = [...doc.querySelectorAll('article.msg[data-seq="4"] .msg-body button.seq-ref')];
    assert.equal(msg4Refs.length, 1);
    assert.equal(msg4Refs[0].dataset.seqRef, '12');
    assert.ok(doc.querySelector('article.msg[data-seq="4"] .msg-body').textContent.includes('https://example.com/a?x=#12'));

    // CJK-adjacent mention and citation still preserved after leading-mention strip
    const msg5Body = doc.querySelector('article.msg[data-seq="5"] .msg-body');
    assert.equal(msg5Body.querySelector('.mention')?.textContent, '@worker-1');
    assert.equal(msg5Body.querySelector('button.seq-ref')?.dataset.seqRef, '2');

    // T3.1a, T3.1b & T3.3b: tier1ClientFallback nested fences & Windows paths
    const fb = win.SwarmHive.tier1Fallback;
    const t31a = fb('````markdown\n```\n[done] Waiting for posts\n```\n````\n[done] outside');
    assert.ok(t31a.includes('```\n[done] Waiting for posts\n```'), '4-backtick outer fence must protect inner block');
    assert.ok(t31a.endsWith('[已完成] outside'));

    const t31b = fb('```markdown\n```js\n[done] Waiting for posts\n```\n```\n[done] after');
    assert.ok(t31b.includes('```js\n[done] Waiting for posts\n```'), '3-backtick nested fence must protect inner block');
    assert.ok(t31b.endsWith('[已完成] after'));

    assert.equal(fb('路径(C:\\Users\\foo\\board.jsonl)，[done]'), '路径(C:\\Users\\foo\\board.jsonl)，[已完成]');

    // T3.6 & briefOf: switch to Members tab
    doc.getElementById('tabbtn-members').click();
    await waitFor(() => !!doc.querySelector('#members .o2-members'));
    assert.equal(doc.querySelector('#members [data-open-member="worker-1"] .o2-mrole').textContent, '审阅中');
    assert.equal(doc.querySelector('#members [data-open-member="worker-2"] .o2-mrole').textContent, '实现 OAuth2 流程');

    // members[].failure_zh consumed in agent chip tooltip, Members .o2-mstat tooltip & Graph node tooltip
    assert.ok(doc.querySelector('#agents .chip[data-agent="worker-3"]').title.includes('超出速率限制'));
    assert.equal(doc.querySelector('#members [data-open-member="worker-3"] .o2-mstat').title, '超出速率限制');
    const gNodeW3 = [...doc.querySelectorAll('#graph .node title')].find((el) => el.textContent.startsWith('worker-3'));
    assert.ok(gNodeW3 && gNodeW3.textContent.includes('超出速率限制'));

    // renderOverviewChrome n.detail & it.detail (with detail_zh and Tier-1 fallback)
    const badge = doc.querySelector('[data-testid="swarm-overview-badge"]');
    assert.equal(badge.title, '讲述者上一步执行失败：步骤执行失败');
    const sysItems = [...doc.querySelectorAll('[data-testid="swarm-overview-system-item"]')];
    assert.equal(sysItems[0].title, '模型错误');
    assert.equal(sysItems[1].title, '超出速率限制');
  });

  test('S13: r2 regressions — hiveSnap index-shift sanitization, sanitizePlan clamping & member raw haystack alignment', async (t) => {
    const longTitle = 'A'.repeat(350);
    const longWhy = 'B'.repeat(550);
    const longWsTitle = 'W'.repeat(240);
    const longWsNote = 'N'.repeat(420);
    const snap = buildSnapshot({
      view: {
        exists: true,
        json: {
          version: 1,
          as_of_seq: 5,
          headline: 'Overview',
          attention: [
            { id: 'att-ask', kind: 'decision', severity: 'high', title: 'Approve API schema', why: 'Need decision on v2 endpoint', refs: [{ member: 'worker-2' }] },
          ],
          workstreams: [
            { id: 'ws-1', title: 'Auth task', owners: ['worker-1'], state: 'active', note: 'Working' },
          ],
        },
        html: '',
        htmlKey: '',
      },
      view_zh: {
        version: 1,
        as_of_seq: 5,
        headline: '总览',
        attention: [
          { title: '', why: 'empty title dropped' },
          {
            id: 'att-ask',
            kind: 'decision',
            severity: 'high',
            title: '批准 API 结构',
            why: '需要确认 v2 接口方案',
            refs: [{ member: 'worker-2' }],
          },
          {
            kind: 'fyi',
            severity: 'low',
            title: '提示事项',
            why: '仅供参考',
            short: { title: '提示短标题', line: '提示短说明' },
          },
          {
            kind: 'failure',
            severity: 'high',
            title: longTitle,
            why: longWhy,
            short: { title: '失败短标题' + 'S'.repeat(80), line: '失败短说明' + 'L'.repeat(120) },
            actions: [{ type: 'url', target: 'javascript:alert(1)', label: 'XSS' }],
          },
        ],
        workstreams: [
          { title: '', note: 'dropped ws' },
          {
            id: 'ws-1',
            title: longWsTitle,
            owners: ['worker-1'],
            state: 'active',
            note: longWsNote,
            short: { title: '任务短标题' + 'T'.repeat(80), line: '任务短说明' + 'M'.repeat(120) },
            actions: [{ type: 'url', target: 'javascript:alert(2)', label: 'BadWs' }],
          },
        ],
      },
      members: [
        { name: 'coordinator', role: 'coordinator', status: 'waiting', steps: 2, posts: 1, unread: 0 },
        { name: 'worker-1', role: 'worker', status: 'waiting', steps: 2, posts: 1, unread: 0 },
        { name: 'worker-2', role: 'worker', status: 'waiting', steps: 2, posts: 1, unread: 0 },
      ],
      systemAttention: [
        { id: 'sys-w1', kind: 'stuck', member: 'worker-1', text: 'worker-1: no progress, and not waiting on the board', text_zh: 'worker-1: 暂无进展，且未在看板等待' },
      ],
      messages: [
        { seq: 1, agent: 'worker-1', ts: Date.UTC(2026, 10, 19, 10, 0, 0), mentions: [], text: 'Old worker-1 board post', text_zh: 'worker-1 的旧看板消息' },
        { seq: 2, agent: 'worker-2', ts: Date.UTC(2026, 10, 19, 10, 1, 0), mentions: [], text: 'Old worker-2 board post', text_zh: 'worker-2 的旧看板消息' },
      ],
      head: 2,
    });

    const capturedHiveSnaps = [];
    const ctx = openSwarmDom(t, {
      snapshot: snap,
      langMode: 'bi',
      url: 'http://127.0.0.1:4321/?tab=overview',
      beforeParse(win) {
        // Wrap SwarmHive.update once loaded via Property trap or inspect after load
        let realHive;
        Object.defineProperty(win, 'SwarmHive', {
          configurable: true,
          get() { return realHive; },
          set(val) {
            realHive = val;
            if (val && typeof val.update === 'function') {
              const origUpdate = val.update.bind(val);
              val.update = (s, el, opts) => {
                capturedHiveSnaps.push({ view: opts?.view, snap: s });
                return origUpdate(s, el, opts);
              };
            }
          },
        });
      },
    });
    const { doc } = ctx;
    await waitFor(() => capturedHiveSnaps.length > 0 && !!doc.querySelector('#ov-plain .o2'));

    // Probe 2d: hiveSnap must pass ONLY sanitized/clamped attention & workstreams with intact short pairing
    const ovArg = capturedHiveSnaps.find((c) => c.view === 'overview');
    assert.ok(ovArg);
    const sanAtt = ovArg.snap.view.json.attention;
    assert.equal(sanAtt.length, 3);
    const failAtt = sanAtt.find((a) => a.kind === 'failure');
    const fyiAtt = sanAtt.find((a) => a.kind === 'fyi');
    assert.ok(failAtt);
    assert.ok(fyiAtt);
    assert.equal(failAtt.title.length, 200);
    assert.equal(failAtt.why.length, 400);
    assert.deepStrictEqual(JSON.parse(JSON.stringify(failAtt.actions)), []);
    assert.ok(failAtt.short.title.startsWith('失败短标题'));
    assert.equal(failAtt.short.title.length, 60);
    assert.equal(failAtt.short.line.length, 90);
    assert.deepStrictEqual(JSON.parse(JSON.stringify(fyiAtt.short)), { title: '提示短标题', line: '提示短说明' });

    const sanWs = ovArg.snap.view.json.workstreams;
    assert.equal(sanWs.length, 1);
    assert.equal(sanWs[0].title.length, 160);
    assert.equal(sanWs[0].note.length, 300);
    assert.deepStrictEqual(JSON.parse(JSON.stringify(sanWs[0].actions)), []);
    assert.equal(sanWs[0].short.title.length, 60);
    assert.equal(sanWs[0].short.line.length, 90);

    // Oversized plan_zh clamping when view is absent
    capturedHiveSnaps.length = 0;
    ctx.pushSnapshot(buildSnapshot({
      etag: 'etag-oversized-plan',
      view: { exists: false, json: null },
      view_zh: null,
      plan: {
        goal: { title: 'Plan Goal', line: 'Plan Line' },
        tasks: { 'worker-1': 'Task 1' },
        threads: [{ id: 'p1', title: 'T1', goal: 'G1', tasks: ['worker-1'] }],
      },
      plan_zh: {
        goal: { title: 'G'.repeat(200), line: 'L'.repeat(300) },
        tasks: { 'worker-1': 'K'.repeat(280) },
        threads: [{ id: 'p1', title: 'T'.repeat(140), goal: 'Q'.repeat(240), tasks: ['worker-1'] }],
      },
    }));
    await waitFor(() => capturedHiveSnaps.some((c) => c.snap.etag === 'etag-oversized-plan'));
    const planArg = capturedHiveSnaps.find((c) => c.snap.etag === 'etag-oversized-plan' && c.view === 'overview');
    assert.equal(planArg.snap.plan.goal.title.length, 120);
    assert.equal(planArg.snap.plan.goal.line.length, 220);
    assert.equal(planArg.snap.plan.tasks['worker-1'].length, 200);
    assert.equal(planArg.snap.plan.threads[0].title.length, 80);
    assert.equal(planArg.snap.plan.threads[0].goal.length, 160);

    // Members tab displays clean Chinese without .o2-orig while keeping aligned raw haystack for search
    ctx.pushSnapshot({ ...snap, etag: 'etag-zh-members' });
    doc.getElementById('tabbtn-members').click();
    await waitFor(() => !!doc.querySelector('#members [data-open-member="worker-2"]')?.textContent.includes('批准 API 结构'));
    const w2Row = doc.querySelector('#members [data-open-member="worker-2"]');
    assert.equal(w2Row.querySelector('.o2-orig'), null);
    assert.ok(w2Row.dataset.mhay.includes('Approve API schema'));
    assert.ok(w2Row.querySelector('.o2-mnow').textContent.includes('批准 API 结构'));

    const w1Row = doc.querySelector('#members [data-open-member="worker-1"]');
    assert.equal(w1Row.querySelector('.o2-orig'), null);
    assert.ok(w1Row.dataset.mhay.includes('worker-1: no progress, and not waiting on the board'));
    assert.ok(w1Row.querySelector('.o2-mnow').textContent.includes('worker-1: 暂无进展'));
  });

  test('S14: r3 regressions — multi-backtick inline code, Tier-1 URL punctuation, clipW semicolon, 3-on-4 nested fences, URL emphasis & id-less attention bi pairing', async (t) => {
    const snap = buildSnapshot({
      members: [
        { name: 'coordinator', role: 'coordinator', status: 'waiting', steps: 2, posts: 2, unread: 0 },
        { name: 'worker-a', role: 'worker', status: 'waiting', steps: 1, posts: 1, unread: 0 },
        { name: 'worker-b', role: 'worker', status: 'waiting', steps: 1, posts: 1, unread: 0 },
        { name: 'worker-2', role: 'worker', status: 'working', activity: 'Editing code', steps: 1, posts: 1, unread: 0 },
      ],
      messages: [
        {
          seq: 1,
          agent: 'coordinator',
          ts: Date.UTC(2026, 10, 19, 10, 0, 0),
          mentions: ['worker-2'],
          text: '@worker-2 Optimize rendering; add tests.',
          text_zh: '@worker-2 ： 优化渲染性能；新增测试用例',
        },
        {
          seq: 2,
          agent: 'worker-a',
          ts: Date.UTC(2026, 10, 19, 10, 1, 0),
          mentions: [],
          text: 'Double backtick inline: `` `[stall]` `` and real [stall] and `**not bold**`',
          text_zh: '双反引号内联：`` `[stall]` `` 以及真实 [stall] 和 `**not bold**`',
        },
        {
          seq: 3,
          agent: 'worker-b',
          ts: Date.UTC(2026, 10, 19, 10, 2, 0),
          mentions: [],
          text: 'Bold URL **https://example.com/a#12** and *https://example.com/b#12* and https://example.com/foo_bar?q=1#12 and inline `https://example.com/c#12`',
          text_zh: '加粗网址 **https://example.com/a#12** 与斜体 *https://example.com/b#12* 和下划线路径 https://example.com/foo_bar?q=1#12 以及内联 `https://example.com/c#12`',
        },
        {
          seq: 4,
          agent: 'worker-2',
          ts: Date.UTC(2026, 10, 19, 10, 3, 0),
          mentions: [],
          text: 'Please ignore `` `[stall]` `` and handle [stall]',
          text_zh: null,
        },
      ],
      head: 4,
      view: {
        exists: true,
        json: {
          version: 1,
          as_of_seq: 4,
          headline: 'Overview',
          attention: [
            {
              kind: 'decision',
              severity: 'high',
              title: 'Approve Schema Migration',
              why: 'Worker A needs schema decision',
              refs: [{ member: 'worker-a' }, { seq: 2 }],
            },
            {
              kind: 'decision',
              severity: 'high',
              title: 'Approve Cache Policy',
              why: 'Worker B needs cache decision',
              refs: [{ member: 'worker-b' }, { seq: 3 }],
            },
          ],
          workstreams: [],
        },
        html: '',
        htmlKey: '',
      },
      view_zh: {
        version: 1,
        as_of_seq: 4,
        headline: '总览',
        attention: [
          // Intentionally reversed order relative to raw view.json.attention
          {
            kind: 'decision',
            severity: 'high',
            title: '批准缓存策略',
            why: 'worker-b 需要缓存决策',
            refs: [{ member: 'worker-b' }, { seq: 3 }],
          },
          {
            kind: 'decision',
            severity: 'high',
            title: '批准结构迁移',
            why: 'worker-a 需要结构决策',
            refs: [{ member: 'worker-a' }, { seq: 2 }],
          },
        ],
        workstreams: [],
      },
      plan: null,
      plan_zh: null,
      systemAttention: [],
    });

    const ctx = openSwarmDom(t, { snapshot: snap, langMode: 'bi', url: 'http://127.0.0.1:4321/?tab=feed' });
    const { doc, win } = ctx;
    await waitFor(() => doc.querySelectorAll('#feed .msg').length === 4);

    // 1. hive.js inline multi-backtick code span masking
    const fb = win.SwarmHive.tier1Fallback;
    assert.equal(
      fb('Please ignore `` `[stall]` `` and handle [stall]'),
      'Please ignore `` `[stall]` `` and handle [停滞告警]'
    );
    assert.equal(
      fb('Keep `unclosed and ``[done]`` and [done]'),
      'Keep `unclosed and ``[done]`` and [已完成]'
    );

    // app.js md() multi-backtick inline code rendering (no split into `<code> </code>[stall]<code> </code>`)
    const msg2Body = doc.querySelector('article.msg[data-seq="2"] .msg-body');
    const msg2Codes = [...msg2Body.querySelectorAll('code')].map((el) => el.textContent);
    assert.ok(msg2Codes.includes('`[stall]`'), `expected \`[stall]\` in <code>, got ${JSON.stringify(msg2Codes)}`);
    assert.ok(msg2Codes.includes('**not bold**'), 'code span must protect ** from bold parsing');
    assert.equal(msg2Body.querySelector('strong'), null);

    // msg 4 uses Tier-1 fallback and renders `` `[stall]` `` inside <code> while translating trailing [stall]
    const msg4Body = doc.querySelector('article.msg[data-seq="4"] .msg-body');
    assert.equal(msg4Body.querySelector('code')?.textContent, '`[stall]`');
    assert.ok(msg4Body.textContent.includes('[停滞告警]'));

    // 2. hive.js Tier-1 URL masking before CJK/ASCII punctuation + [done]
    assert.equal(fb('请看 https://example.com/a#12，[done]'), '请看 https://example.com/a#12，[已完成]');
    assert.equal(
      fb('See https://example.com/a#12, [done] and https://example.com/b#12.[done]'),
      'See https://example.com/a#12, [已完成] and https://example.com/b#12.[已完成]'
    );

    // 4. hive.js maskFencedBlocks 3-backtick outer wrapping 4-backtick inner
    const threeOnFour = '```markdown\n````js\n[done] inner\n````\n[done] still inside 3-tick\n```';
    assert.equal(fb(threeOnFour), threeOnFour);
    assert.equal(
      fb(`${threeOnFour}\n[done] outside`),
      `${threeOnFour}\n[已完成] outside`
    );

    // 5. app.js URL_MASK_RE markdown emphasis boundary (**url**, *url*, url with _)
    const msg3Body = doc.querySelector('article.msg[data-seq="3"] .msg-body');
    assert.equal(msg3Body.querySelectorAll('button.seq-ref').length, 0);
    assert.equal(msg3Body.querySelector('strong')?.textContent, 'https://example.com/a#12');
    assert.equal(msg3Body.querySelector('em')?.textContent, 'https://example.com/b#12');
    assert.ok(msg3Body.textContent.includes('https://example.com/foo_bar?q=1#12'));
    assert.equal(msg3Body.querySelector('code')?.textContent, 'https://example.com/c#12');

    // Switch to Members tab for #3 (clipW trailing semicolon) & #6 (multi id-less same-kind bi pairing)
    doc.getElementById('tabbtn-members').click();
    await waitFor(() => !!doc.querySelector('#members .o2-members'));

    // 3. briefOf / clipW strips trailing Chinese semicolon
    assert.equal(doc.querySelector('#members [data-open-member="worker-2"] .o2-mrole').textContent, '优化渲染性能');

    // 6. multi-id-less same-kind attention items pair with their own member cards & raw search haystacks (no .o2-orig)
    const waRow = doc.querySelector('#members [data-open-member="worker-a"]');
    const wbRow = doc.querySelector('#members [data-open-member="worker-b"]');
    assert.equal(waRow.querySelector('.o2-orig'), null);
    assert.equal(wbRow.querySelector('.o2-orig'), null);
    assert.ok(waRow.querySelector('.o2-mnow').textContent.includes('批准结构迁移'));
    assert.ok(waRow.dataset.mhay.includes('Approve Schema Migration'), `expected worker-a mhay to match Schema Migration, got: ${waRow.dataset.mhay}`);
    assert.ok(waRow.dataset.mhay.includes('Worker A needs schema decision'));
    assert.ok(!waRow.dataset.mhay.includes('Approve Cache Policy'));
    assert.ok(wbRow.querySelector('.o2-mnow').textContent.includes('批准缓存策略'));
    assert.ok(wbRow.dataset.mhay.includes('Approve Cache Policy'), `expected worker-b mhay to match Cache Policy, got: ${wbRow.dataset.mhay}`);
    assert.ok(wbRow.dataset.mhay.includes('Worker B needs cache decision'));
    assert.ok(!wbRow.dataset.mhay.includes('Approve Schema Migration'));
  });

  test('S15: r4 fixes — hiveSnap sanitization, stripped-ID & id-less short pairing, inline 3+-backtick spans, balanced-paren URLs, clipWords CJK punctuation', async (t) => {
    const longClipTitle = '一二三四五六七八九十一二三四五六七八九十一二三四五六！后续超出截断内容';
    const manyWorkstreams = [
      { id: 'bad_empty', title: '', owners: ['worker-1'], state: 'active', note: 'skip' },
      ...Array.from({ length: 46 }, (_, i) => ({
        id: `ws-${i + 1}`,
        title: `工作流 ${i + 1}`,
        owners: ['worker-1'],
        state: 'queued',
        note: `任务说明 ${i + 1}`,
      })),
    ];
    const manyAttention = [
      { id: 'bad_id_with_underscore', kind: 'review', severity: 'high', title: '超长短题不应入索引', why: '原因', short: { title: '坏ID短题', line: '坏ID短行' }, refs: [{ member: 'worker-1' }] },
      { id: 'empty_title_skip', kind: 'review', severity: 'low', title: '', why: 'skip' },
      ...Array.from({ length: 35 }, (_, i) => ({
        id: `rev-${i + 1}`,
        kind: 'fyi',
        severity: 'low',
        title: `提示项 ${i + 1}`,
        why: `说明 ${i + 1}`,
      })),
    ];

    const snapSanitize = buildSnapshot({
      members: [
        { name: 'coordinator', role: 'coordinator', status: 'waiting', steps: 2, posts: 1, unread: 0 },
        { name: 'worker-1', role: 'worker', status: 'working', activity: 'Working', steps: 1, posts: 1, unread: 0 },
      ],
      messages: [
        { seq: 1, agent: 'coordinator', ts: Date.UTC(2026, 10, 19, 10, 0, 0), mentions: ['worker-1'], text: 'Start work', text_zh: '开始任务' },
      ],
      head: 1,
      view: {
        exists: true,
        json: {
          version: 1,
          as_of_seq: 1,
          headline: 'Overview',
          attention: [{ id: 'bad_id_with_underscore', kind: 'review', severity: 'high', title: 'Bad ID', why: 'Why', short: { title: 'Raw Bad', line: 'Raw bad line' }, refs: [{ member: 'worker-1' }] }],
          workstreams: [{ id: 'ws-1', title: 'WS 1', owners: ['worker-1'], state: 'queued', note: 'Note 1' }],
        },
        html: '',
        htmlKey: '',
      },
      view_zh: {
        version: 1,
        as_of_seq: 1,
        headline: '总览',
        attention: manyAttention,
        workstreams: manyWorkstreams,
      },
      plan: null,
      plan_zh: null,
      systemAttention: [],
    });

    const ctxSan = openSwarmDom(t, { snapshot: snapSanitize, langMode: 'zh', url: 'http://127.0.0.1:4321/?tab=overview' });
    await waitFor(() => !!ctxSan.doc.querySelector('#ov-plain .o2-progt'));
    assert.equal(ctxSan.win.SwarmHive.viewCopy.items.bad_id_with_underscore, undefined);
    assert.ok(ctxSan.doc.querySelector('#ov-plain .o2-progt').textContent.includes('/ 39'));
    assert.ok(ctxSan.doc.querySelectorAll('#ov-plain .o2-ask').length <= 30);

    // Second DOM instance for Feed, Members, and Overview pairing/formatting checks
    const snap = buildSnapshot({
      members: [
        { name: 'coordinator', role: 'coordinator', status: 'waiting', steps: 2, posts: 2, unread: 0 },
        { name: 'worker-a', role: 'worker', status: 'waiting', steps: 1, posts: 1, unread: 0 },
        { name: 'worker-b', role: 'worker', status: 'waiting', steps: 1, posts: 1, unread: 0 },
        { name: 'worker-c', role: 'worker', status: 'waiting', steps: 1, posts: 1, unread: 0 },
      ],
      messages: [
        {
          seq: 1,
          agent: 'worker-a',
          ts: Date.UTC(2026, 10, 19, 10, 0, 0),
          mentions: [],
          text: '``` ``[done]`` ``` 和 [已完成]',
          text_zh: '``` ``[done]`` ``` 和 [已完成]',
        },
        {
          seq: 2,
          agent: 'worker-b',
          ts: Date.UTC(2026, 10, 19, 10, 1, 0),
          mentions: [],
          text: 'Wiki https://en.wikipedia.org/wiki/Foo_(bar)#12 and (https://example.com/a#12) and (https://example.com/a)#12 and **https://example.com/b#12**',
          text_zh: '维基 https://en.wikipedia.org/wiki/Foo_(bar)#12 以及 (https://example.com/a#12) 还有 (https://example.com/a)#12 与 **https://example.com/b#12**',
        },
        {
          seq: 3,
          agent: 'worker-c',
          ts: Date.UTC(2026, 10, 19, 10, 2, 0),
          mentions: [],
          text: '```markdown\n````js\nconst a = 1;\n````\nstill inside\n```',
          text_zh: '```markdown\n````js\nconst a = 1;\n````\nstill inside\n```',
        },
      ],
      head: 12,
      view: {
        exists: true,
        json: {
          version: 1,
          as_of_seq: 12,
          headline: 'Overview',
          attention: [
            { id: 'dec_1', kind: 'decision', severity: 'high', title: 'Underscore ID A', why: 'Wait on A', refs: [{ member: 'worker-a' }, { seq: 1 }] },
            { id: 'DEC-2', kind: 'decision', severity: 'high', title: 'Uppercase ID B', why: 'Wait on B', refs: [{ member: 'worker-b' }, { seq: 2 }] },
            {
              kind: 'decision',
              severity: 'high',
              title: 'Long IDless Decision Title That Should Not Appear',
              why: 'Long idless reason that should not appear',
              short: { title: 'IDless Raw Short', line: 'IDless raw short line' },
              refs: [{ member: 'worker-c' }, { seq: 3 }],
            },
          ],
          workstreams: [
            { id: 'ws-semi', title: '性能调优；', owners: ['worker-a'], state: 'active', note: '说明一' },
            { id: 'ws-q', title: '缓存策略？', owners: ['worker-b'], state: 'active', note: '说明二' },
            { id: 'ws-long', title: longClipTitle, owners: ['worker-c'], state: 'active', note: '说明三' },
          ],
        },
        html: '',
        htmlKey: '',
      },
      view_zh: {
        version: 1,
        as_of_seq: 12,
        headline: '总览',
        attention: [
          { id: 'DEC-2', kind: 'decision', severity: 'high', title: '大写 ID B！', why: '是否需要缓存？第二句', refs: [{ member: 'worker-b' }, { seq: 2 }] },
          { id: 'dec_1', kind: 'decision', severity: 'high', title: '下划线 ID A；', why: '优化渲染性能；新增测试用例', refs: [{ member: 'worker-a' }, { seq: 1 }] },
          {
            kind: 'decision',
            severity: 'high',
            title: '无ID长标题不应与短文案错位',
            why: '无ID长原因不应与短文案错位',
            short: { title: '中文短标题', line: '中文短说明' },
            refs: [{ member: 'worker-c' }, { seq: 3 }],
          },
        ],
        workstreams: [
          { id: 'ws-semi', title: '性能调优；', owners: ['worker-a'], state: 'active', note: '说明一' },
          { id: 'ws-q', title: '缓存策略？', owners: ['worker-b'], state: 'active', note: '说明二' },
          { id: 'ws-long', title: longClipTitle, owners: ['worker-c'], state: 'active', note: '说明三' },
        ],
      },
      plan: null,
      plan_zh: null,
      systemAttention: [],
    });

    const ctx = openSwarmDom(t, { snapshot: snap, langMode: 'zh', url: 'http://127.0.0.1:4321/?tab=feed' });
    const { doc, win } = ctx;
    await waitFor(() => doc.querySelectorAll('#feed .msg').length === 3);

    // 3. Inline 3+-backtick code spans in tier1Fallback & md()
    const fb = win.SwarmHive.tier1Fallback;
    assert.equal(fb('Check ``` ``[done]`` ``` then [done]'), 'Check ``` ``[done]`` ``` then [已完成]');
    assert.equal(fb('Use ``` foo ```\n[done] next line'), 'Use ``` foo ```\n[已完成] next line');
    assert.equal(fb('Use ```` ```[done]``` ```` then [done]'), 'Use ```` ```[done]``` ```` then [已完成]');
    assert.equal(fb('``` ``[done]`` ``` then [done]'), '``` ``[done]`` ``` then [已完成]');

    const msg1Body = doc.querySelector('article.msg[data-seq="1"] .msg-body');
    assert.equal(msg1Body.querySelectorAll('pre').length, 0);
    assert.equal(msg1Body.querySelector('code')?.textContent, '``[done]``');
    assert.ok(msg1Body.textContent.includes('和 [已完成]'));

    const msg3Body = doc.querySelector('article.msg[data-seq="3"] .msg-body');
    assert.equal(msg3Body.querySelectorAll('pre').length, 1);
    assert.ok(msg3Body.querySelector('pre').textContent.includes('````js'));
    assert.ok(msg3Body.querySelector('pre').textContent.includes('still inside'));

    // 4. Balanced-parenthesis URLs in md() & tier1Fallback
    const msg2Body = doc.querySelector('article.msg[data-seq="2"] .msg-body');
    const seqRefs = [...msg2Body.querySelectorAll('button.seq-ref')].map((b) => b.textContent);
    assert.deepEqual(seqRefs, ['#12']);
    assert.ok(msg2Body.textContent.includes('https://en.wikipedia.org/wiki/Foo_(bar)#12'));
    assert.ok(msg2Body.textContent.includes('(https://example.com/a#12)'));
    assert.equal(msg2Body.querySelector('strong')?.textContent, 'https://example.com/b#12');
    assert.equal(
      fb('See https://en.wikipedia.org/wiki/Foo_(bar)#12 and [done]'),
      'See https://en.wikipedia.org/wiki/Foo_(bar)#12 and [已完成]'
    );
    assert.equal(fb('See (https://example.com/a#12)[done]'), 'See (https://example.com/a#12)[已完成]');
    assert.equal(fb('See https://example.com/b#12.[done]'), 'See https://example.com/b#12.[已完成]');

    // 2: id-less attention short & stripped-ID rawMatchForAtt haystack alignment on Members tab (no .o2-orig)
    doc.getElementById('tabbtn-members').click();
    await waitFor(() => !!doc.querySelector('#members [data-open-member="worker-c"]'));
    const wcRow = doc.querySelector('#members [data-open-member="worker-c"]');
    assert.equal(wcRow.querySelector('.o2-mnow').textContent, '中文短标题 — 中文短说明');
    assert.equal(wcRow.querySelector('.o2-orig'), null);
    assert.ok(wcRow.dataset.mhay.includes('IDless Raw Short — IDless raw short line'));

    const waHay = doc.querySelector('#members [data-open-member="worker-a"]').dataset.mhay;
    const wbHay = doc.querySelector('#members [data-open-member="worker-b"]').dataset.mhay;
    assert.ok(waHay.includes('Underscore ID A'));
    assert.ok(!waHay.includes('Uppercase ID B'));
    assert.ok(wbHay.includes('Uppercase ID B'));
    assert.ok(!wbHay.includes('Underscore ID A'));

    // 5. clipWords trailing Chinese punctuation on Overview cards without short
    doc.getElementById('tabbtn-overview').click();
    await waitFor(() => !!doc.querySelector('#ov-plain .o2-run'));
    const askTitles = [...doc.querySelectorAll('#ov-plain .o2-ask b')].map((el) => el.textContent);
    const askLines = [...doc.querySelectorAll('#ov-plain .o2-askl')].map((el) => el.textContent);
    assert.ok(askTitles.includes('中文短标题'));
    assert.ok(askTitles.includes('大写 ID B'), `expected trailing ！ stripped from ${JSON.stringify(askTitles)}`);
    assert.ok(askTitles.includes('下划线 ID A'), `expected trailing ； stripped from ${JSON.stringify(askTitles)}`);
    assert.ok(askLines.includes('优化渲染性能'), `expected trailing ； stripped from ${JSON.stringify(askLines)}`);
    assert.ok(askLines.includes('是否需要缓存'), `expected trailing ？ stripped from ${JSON.stringify(askLines)}`);

    const runTitles = [...doc.querySelectorAll('#ov-plain .o2-runt')].map((el) => el.textContent);
    assert.ok(runTitles.includes('性能调优'), `expected trailing ； stripped from ${JSON.stringify(runTitles)}`);
    assert.ok(runTitles.includes('缓存策略'), `expected trailing ？ stripped from ${JSON.stringify(runTitles)}`);
    assert.ok(
      runTitles.includes('一二三四五六七八九十一二三四五六七八九十一二三四五六…'),
      `expected truncated title without trailing ！ before …, got ${JSON.stringify(runTitles)}`
    );
  });

  test('S16: r5 regressions — view_zh/plan_zh rendering, rawView/rawPlan fallback sanitization, id-less workstreams.short & rawMatchForAtt severity tie-breaking', async (t) => {
    // Block 1: view + view_zh renders localized Chinese directly (even with stale localStorage['swarm.langMode']='en')
    const snapView = buildSnapshot({
      etag: 'etag-s16-view',
      systemAttention: [],
      view: {
        exists: true,
        json: {
          version: 1,
          as_of_seq: 5,
          headline: 'Raw English Headline',
          running_summary: 'Raw English Summary',
          goal: { title: 'Raw English Goal', line: 'Raw English Goal Line' },
          attention: [{ id: 'att-1', kind: 'decision', severity: 'high', title: 'Raw Decision', why: 'Raw Why', refs: [{ member: 'worker-1' }] }],
          workstreams: [{ id: 'ws-1', title: 'Raw WS', owners: ['worker-1'], state: 'active', note: 'Raw Note' }],
          threads: [{ id: 'th-1', title: 'Raw Thread', goal: 'Raw Thread Goal', now: 'Raw Now', workstreams: ['ws-1'], attention: ['att-1'] }],
        },
        html: '',
        htmlKey: '',
      },
      view_zh: {
        version: 1,
        as_of_seq: 5,
        headline: '专属中文总览标题',
        running_summary: '专属中文运行摘要',
        goal: { title: '专属中文目标', line: '专属中文目标说明' },
        attention: [{ id: 'att-1', kind: 'decision', severity: 'high', title: '专属中文决策', why: '专属中文原因', refs: [{ member: 'worker-1' }] }],
        workstreams: [{ id: 'ws-1', title: '专属中文任务', owners: ['worker-1'], state: 'active', note: '专属中文说明' }],
        threads: [{ id: 'th-1', title: '专属中文任务线', goal: '专属中文线目标', now: '专属中文当前', workstreams: ['ws-1'], attention: ['att-1'] }],
      },
      plan: null,
      plan_zh: null,
    });

    const ctx1 = openSwarmDom(t, { snapshot: snapView, langMode: 'en', url: 'http://127.0.0.1:4321/?tab=overview' });
    await waitFor(() => !!ctx1.doc.querySelector('#ov-plain .o2-runsum'));
    assert.equal(ctx1.doc.querySelector('#ov-plain .o2-runsum').textContent, '专属中文运行摘要');
    assert.equal(ctx1.doc.querySelector('#ov-plain .o2-goal b').textContent, '专属中文目标');
    assert.equal(ctx1.doc.querySelector('#ov-plain .o2-goal .o2-orig'), null);

    ctx1.doc.getElementById('tabbtn-members').click();
    await waitFor(() => !!ctx1.doc.querySelector('#members [data-open-member="worker-1"]'));
    assert.ok(ctx1.doc.querySelector('#members [data-open-member="worker-1"] .o2-mnow').textContent.includes('专属中文决策'));
    assert.equal(ctx1.doc.querySelector('#members [data-open-member="worker-1"] .o2-orig'), null);

    // Also test starting directly on ?tab=members
    const ctx1Mem = openSwarmDom(t, { snapshot: snapView, langMode: 'en', url: 'http://127.0.0.1:4321/?tab=members' });
    await waitFor(() => !!ctx1Mem.doc.querySelector('#members [data-open-member="worker-1"]'));
    assert.ok(ctx1Mem.doc.querySelector('#members [data-open-member="worker-1"] .o2-mnow').textContent.includes('专属中文决策'));

    // Block 2: plan + plan_zh renders localized Chinese cleanly (view absent)
    const snapPlan = buildSnapshot({
      etag: 'etag-s16-plan',
      systemAttention: [],
      members: [
        { name: 'coordinator', role: 'coordinator', status: 'waiting', steps: 2, posts: 1, unread: 0 },
        { name: 'worker-1', role: 'worker', status: 'working', activity: 'Editing app.js', activity_zh: '编辑 app.js', steps: 2, posts: 1, unread: 0 },
      ],
      view: { exists: false, json: null },
      view_zh: null,
      plan: {
        goal: { title: 'Raw Plan Goal Title', line: 'Raw Plan Goal Line' },
        tasks: { 'worker-1': 'Raw Worker1 Task' },
        threads: [{ id: 'p-1', title: 'Raw Plan Thread', goal: 'Raw Thread Goal', tasks: ['worker-1'] }],
      },
      plan_zh: {
        goal: { title: '专属中文计划目标', line: '专属中文计划副标题' },
        tasks: { 'worker-1': '专属中文成员任务' },
        threads: [{ id: 'p-1', title: '专属中文计划线程', goal: '专属中文线程目标', tasks: ['worker-1'] }],
      },
    });
    const ctx2 = openSwarmDom(t, { snapshot: snapPlan, langMode: 'en', url: 'http://127.0.0.1:4321/?tab=overview' });
    await waitFor(() => !!ctx2.doc.querySelector('#ov-plain .o2-goal b'));
    assert.equal(ctx2.doc.querySelector('#ov-plain .o2-goal b').textContent, '专属中文计划目标');
    assert.equal(ctx2.doc.querySelector('#ov-plain .o2-goal p').textContent, '专属中文计划副标题');
    assert.equal(ctx2.doc.querySelector('#ov-plain .o2-tht b').textContent, '专属中文计划线程');
    assert.equal(ctx2.doc.querySelector('#ov-plain .o2-goal .o2-orig'), null);

    ctx2.doc.getElementById('tabbtn-members').click();
    await waitFor(() => !!ctx2.doc.querySelector('#members [data-open-member="worker-1"] .o2-mrole'));
    assert.equal(ctx2.doc.querySelector('#members [data-open-member="worker-1"] .o2-mrole').textContent, '专属中文成员任务');

    // Block 3: Oversized / invalid-ID rawView & rawPlan fallback sanitization when view_zh/plan_zh absent
    const snapOversizedRawView = buildSnapshot({
      etag: 'etag-s16-raw-view',
      systemAttention: [],
      view: {
        exists: true,
        json: {
          version: 1,
          as_of_seq: 5,
          headline: 'Oversized Raw View',
          attention: [
            {
              id: 'bad_raw_att_id',
              kind: 'review',
              severity: 'high',
              title: 'A'.repeat(250),
              why: 'B'.repeat(450),
              short: { title: 'S'.repeat(80), line: 'L'.repeat(120) },
              actions: [{ type: 'url', target: 'javascript:alert(1)', label: 'XSS' }],
              refs: [{ member: 'worker-1' }],
            },
            ...Array.from({ length: 35 }, (_, i) => ({
              id: `fyi-raw-${i}`,
              kind: 'fyi',
              severity: 'low',
              title: `Raw FYI ${i}`,
              why: `Raw why ${i}`,
            })),
          ],
          workstreams: Array.from({ length: 45 }, (_, i) => ({
            id: i === 0 ? 'bad_raw_ws_id' : `ws-raw-${i}`,
            title: 'W'.repeat(200),
            owners: ['worker-1'],
            state: 'queued',
            note: 'N'.repeat(350),
            short: { title: 'T'.repeat(80), line: 'M'.repeat(120) },
            actions: [{ type: 'url', target: 'javascript:alert(2)', label: 'XSS' }],
          })),
        },
        html: '',
        htmlKey: '',
      },
      view_zh: null,
      plan: null,
      plan_zh: null,
    });

    {
      const captured = [];
      const ctx3a = openSwarmDom(t, {
        snapshot: snapOversizedRawView,
        url: 'http://127.0.0.1:4321/?tab=overview',
        beforeParse(win) {
          let realHive;
          Object.defineProperty(win, 'SwarmHive', {
            configurable: true,
            get() { return realHive; },
            set(val) {
              realHive = val;
              if (val && typeof val.update === 'function') {
                const origUpdate = val.update.bind(val);
                val.update = (s, el, opts) => {
                  captured.push({ view: opts?.view, snap: s });
                  return origUpdate(s, el, opts);
                };
              }
            },
          });
        },
      });
      await waitFor(() => ctx3a.doc.querySelector('#ov-plain .o2-progt')?.textContent.includes('/ 40'));
      assert.ok(ctx3a.doc.querySelectorAll('#ov-plain .o2-ask').length <= 30);
      assert.equal(ctx3a.win.SwarmHive.viewCopy.items.bad_raw_att_id, undefined);
      assert.equal(ctx3a.win.SwarmHive.viewCopy.items.bad_raw_ws_id, undefined);
      assert.equal(ctx3a.win.SwarmHive.viewCopy.items['ws-raw-1'].title.length, 60);
      assert.equal(ctx3a.win.SwarmHive.viewCopy.items['ws-raw-1'].line.length, 90);

      const ovArg = captured.find((c) => c.view === 'overview');
      assert.ok(ovArg);
      assert.equal(ovArg.snap.view.json.attention[0].title.length, 200);
      assert.equal(ovArg.snap.view.json.attention[0].why.length, 400);
      assert.deepStrictEqual(JSON.parse(JSON.stringify(ovArg.snap.view.json.attention[0].actions)), []);
      assert.equal(ovArg.snap.view.json.workstreams[0].title.length, 160);
      assert.equal(ovArg.snap.view.json.workstreams[0].note.length, 300);
      assert.deepStrictEqual(JSON.parse(JSON.stringify(ovArg.snap.view.json.workstreams[0].actions)), []);
    }

    const snapOversizedRawPlan = buildSnapshot({
      etag: 'etag-s16-raw-plan',
      systemAttention: [],
      members: [
        { name: 'coordinator', role: 'coordinator', status: 'waiting', steps: 2, posts: 1, unread: 0 },
        { name: 'worker-1', role: 'worker', status: 'working', activity: 'Working', steps: 1, posts: 1, unread: 0 },
      ],
      view: { exists: false, json: null },
      view_zh: null,
      plan: {
        goal: { title: 'G'.repeat(200), line: 'L'.repeat(300) },
        tasks: { 'worker-1': 'K'.repeat(280) },
        threads: Array.from({ length: 25 }, (_, i) => ({
          id: `pt-${i}`,
          title: 'T'.repeat(140),
          goal: 'Q'.repeat(240),
          tasks: ['worker-1'],
        })),
      },
      plan_zh: null,
    });

    {
      const captured = [];
      const ctx3b = openSwarmDom(t, {
        snapshot: snapOversizedRawPlan,
        url: 'http://127.0.0.1:4321/?tab=overview',
        beforeParse(win) {
          let realHive;
          Object.defineProperty(win, 'SwarmHive', {
            configurable: true,
            get() { return realHive; },
            set(val) {
              realHive = val;
              if (val && typeof val.update === 'function') {
                const origUpdate = val.update.bind(val);
                val.update = (s, el, opts) => {
                  captured.push({ view: opts?.view, snap: s });
                  return origUpdate(s, el, opts);
                };
              }
            },
          });
        },
      });
      await waitFor(() => ctx3b.doc.querySelectorAll('#ov-plain .o2-th').length === 12);
      assert.equal(ctx3b.doc.querySelector('#ov-plain .o2-goal b').textContent, 'G'.repeat(80));
      const planOv = captured.find((c) => c.view === 'overview');
      assert.ok(planOv);
      assert.equal(planOv.snap.plan.threads.length, 20);
      assert.equal(planOv.snap.rawPlan.threads.length, 20);
      assert.equal(planOv.snap.plan.goal.title.length, 120);
      assert.equal(planOv.snap.plan.goal.line.length, 220);
      assert.equal(planOv.snap.plan.tasks['worker-1'].length, 200);
      assert.equal(planOv.snap.plan.threads[0].title.length, 80);
      assert.equal(planOv.snap.plan.threads[0].goal.length, 160);
    }

    // Block 4: id-less & stripped-ID workstreams.short symmetry across all 4 hive.js surfaces
    const wsShortList = [
      { id: 'bad_ws_id', title: 'Extremely Long Active Workstream Title Without Valid ID', owners: ['worker-1'], state: 'active', note: '', short: { title: '无ID活跃短题', line: '无ID活跃短行' } },
      { title: 'Extremely Long Done Workstream Title Without ID', owners: ['worker-1'], state: 'done', note: 'Long done note', short: { title: '无ID完成短题', line: '无ID完成短行' } },
      { title: 'Extremely Long Queued Workstream Title Without ID', owners: ['worker-1'], state: 'queued', note: '', short: { title: '无ID待办短题', line: '无ID待办短行' } },
    ];
    const snapWsShort = buildSnapshot({
      etag: 'etag-s16-ws-short',
      builtinOverview: true,
      systemAttention: [],
      members: [
        { name: 'coordinator', role: 'coordinator', status: 'waiting', steps: 2, posts: 1, unread: 0 },
        { name: 'worker-1', role: 'worker', status: 'waiting', steps: 1, posts: 1, unread: 0 },
      ],
      view: {
        exists: true,
        json: { version: 1, as_of_seq: 5, headline: 'WS Short', attention: [], workstreams: wsShortList },
        html: '',
        htmlKey: '',
      },
      view_zh: { version: 1, as_of_seq: 5, headline: '短文案对称', attention: [], workstreams: wsShortList },
      plan: null,
      plan_zh: null,
    });

    const ctx4a = openSwarmDom(t, { snapshot: snapWsShort, langMode: 'zh', url: 'http://127.0.0.1:4321/?tab=overview' });
    await waitFor(() => !!ctx4a.doc.querySelector('#ov-plain .o2-runt'));
    assert.equal(ctx4a.doc.querySelector('#ov-plain .o2-runt').textContent, '无ID活跃短题');
    assert.equal(ctx4a.doc.querySelector('#ov-plain .o2-runnote').textContent, '无ID活跃短行');
    assert.equal(ctx4a.win.SwarmHive.viewCopy.items.bad_ws_id, undefined);
    assert.equal(ctx4a.win.SwarmHive.viewCopy.items.w0, undefined);

    ctx4a.doc.querySelector('#ov-plain .o2-progh').click();
    assert.equal(ctx4a.doc.querySelector('#ov-plain .o2-donelist:not(.queued) .o2-donem b').textContent, '无ID完成短题');
    assert.equal(ctx4a.doc.querySelector('#ov-plain .o2-donelist:not(.queued) .o2-donem span').textContent, '无ID完成短行');
    assert.equal(ctx4a.doc.querySelector('#ov-plain .o2-donelist.queued .o2-donem b').textContent, '无ID待办短题');

    ctx4a.doc.querySelector('#ov-plain [data-o2t="t-other"]').click();
    const threadTaskTitles = [...ctx4a.doc.querySelectorAll('#ov-plain .o2-tasks .o2-tt')].map((el) => el.textContent);
    assert.ok(threadTaskTitles.includes('无ID活跃短题'));
    assert.ok(threadTaskTitles.includes('无ID完成短题'));
    assert.ok(threadTaskTitles.includes('无ID待办短题'));

    // overviewView card fallback (builtinOverview: false, threads: [], finished swarm renders .o2-br.running .o2-card)
    const snapWsFallback = buildSnapshot({
      etag: 'etag-s16-ws-fallback',
      builtinOverview: false,
      systemAttention: [],
      members: [
        { name: 'coordinator', role: 'coordinator', status: 'waiting', steps: 2, posts: 1, unread: 0 },
        { name: 'worker-1', role: 'worker', status: 'waiting', steps: 1, posts: 1, unread: 0 },
      ],
      messages: [
        { seq: 1, agent: 'coordinator', ts: Date.UTC(2026, 10, 19, 10, 0, 0), mentions: [], text: '[done] Complete', text_zh: '[已完成] 完成' },
      ],
      head: 1,
      view: snapWsShort.view,
      view_zh: snapWsShort.view_zh,
      plan: null,
      plan_zh: null,
    });
    const ctx4b = openSwarmDom(t, { snapshot: snapWsFallback, langMode: 'zh', url: 'http://127.0.0.1:4321/?tab=overview' });
    await waitFor(() => !!ctx4b.doc.querySelector('#ov-plain .o2-br.running .o2-card'));
    assert.equal(ctx4b.doc.querySelector('#ov-plain .o2-br.running .o2-card b').textContent, '无ID活跃短题');
    assert.equal(ctx4b.doc.querySelector('#ov-plain .o2-br.running .o2-card p').textContent, '无ID活跃短行');

    // Block 5: rawMatchForAtt severity tie-breaking (Pass 2 identical-refs & Pass 3 ref-less)
    const snapSevTie = buildSnapshot({
      etag: 'etag-s16-sev-tie',
      systemAttention: [],
      members: [
        { name: 'coordinator', role: 'coordinator', status: 'waiting', steps: 2, posts: 1, unread: 0 },
        { name: 'worker-a', role: 'worker', status: 'waiting', steps: 1, posts: 1, unread: 0 },
        { name: 'worker-b', role: 'worker', status: 'waiting', steps: 1, posts: 1, unread: 0 },
      ],
      view: {
        exists: true,
        json: {
          version: 1,
          as_of_seq: 5,
          headline: 'Sev Tie',
          attention: [
            { kind: 'decision', severity: 'low', title: 'Low SameRef Raw', why: 'Low sameref why', refs: [{ member: 'worker-a' }] },
            { kind: 'decision', severity: 'high', title: 'High SameRef Raw', why: 'High sameref why', refs: [{ member: 'worker-a' }] },
            { kind: 'decision', severity: 'low', title: 'Low Pass3 Raw', why: 'Low pass3 why' },
            { kind: 'decision', severity: 'high', title: 'High Pass3 Raw', why: 'High pass3 why' },
          ],
          workstreams: [],
        },
        html: '',
        htmlKey: '',
      },
      view_zh: {
        version: 1,
        as_of_seq: 5,
        headline: '优先级匹配',
        attention: [
          { kind: 'decision', severity: 'low', title: '低优先级同引用', why: '低原因', refs: [{ member: 'worker-a' }] },
          { kind: 'decision', severity: 'high', title: '高优先级同引用', why: '高原因', refs: [{ member: 'worker-a' }] },
          { kind: 'decision', severity: 'low', title: '低优先级Pass3', why: '低Pass3原因' },
          { kind: 'decision', severity: 'high', title: '高优先级Pass3', why: '高Pass3原因', refs: [{ member: 'worker-b' }] },
        ],
        workstreams: [],
      },
      plan: null,
      plan_zh: null,
    });
    const ctx5 = openSwarmDom(t, { snapshot: snapSevTie, url: 'http://127.0.0.1:4321/?tab=members' });
    await waitFor(() => !!ctx5.doc.querySelector('#members [data-open-member="worker-a"]') && !!ctx5.doc.querySelector('#members [data-open-member="worker-b"]'));
    const wa5Row = ctx5.doc.querySelector('#members [data-open-member="worker-a"]');
    assert.equal(wa5Row.querySelector('.o2-orig'), null);
    assert.ok(wa5Row.querySelector('.o2-mnow').textContent.includes('高优先级同引用'));
    assert.ok(wa5Row.dataset.mhay.includes('High SameRef Raw'));
    assert.ok(!wa5Row.dataset.mhay.includes('Low SameRef Raw'));

    const wb5Row = ctx5.doc.querySelector('#members [data-open-member="worker-b"]');
    assert.equal(wb5Row.querySelector('.o2-orig'), null);
    assert.ok(wb5Row.querySelector('.o2-mnow').textContent.includes('高优先级Pass3'));
    assert.ok(wb5Row.dataset.mhay.includes('High Pass3 Raw'));
    assert.ok(!wb5Row.dataset.mhay.includes('Low Pass3 Raw'));

    // Standalone SwarmHive.update (unsorted view_zh) also matches Pass 2/3 by severity in raw search haystack
    const standaloneHost = ctx5.doc.createElement('div');
    ctx5.doc.body.appendChild(standaloneHost);
    ctx5.win.SwarmHive.update(snapSevTie, standaloneHost, { view: 'cards' });
    const stWbHay = standaloneHost.querySelector('[data-open-member="worker-b"]').dataset.mhay;
    assert.ok(stWbHay.includes('High Pass3 Raw'));
    assert.ok(!stWbHay.includes('Low Pass3 Raw'));

    // Block 6: sys-* & sys-coordinator-reply Chinese rendering + rawGoalTitle isolation
    const snapZhSys = buildSnapshot({
      etag: 'etag-s16-zh-sys',
      members: [
        { name: 'coordinator', role: 'coordinator', status: 'waiting', replied: true, steps: 2, posts: 1, unread: 0 },
        { name: 'worker-1', role: 'worker', status: 'waiting', steps: 1, posts: 1, unread: 0 },
      ],
      messages: [
        { seq: 1, agent: 'coordinator', ts: Date.UTC(2026, 10, 19, 10, 0, 0), mentions: [], text: 'Need your input', text_zh: '需要你的回复' },
      ],
      head: 1,
      view: {
        exists: true,
        json: { version: 1, as_of_seq: 1, headline: 'Raw Headline Only', attention: [], workstreams: [{ id: 'ws-1', title: 'Task 1', owners: ['worker-1'], state: 'active', note: 'Working' }], threads: [{ id: 'th-1', title: 'Thread 1', goal: '', now: '', workstreams: ['ws-1'], attention: [] }] },
        html: '',
        htmlKey: '',
      },
      view_zh: {
        version: 1,
        as_of_seq: 1,
        headline: '仅中文总览标题',
        attention: [],
        workstreams: [{ id: 'ws-1', title: '任务 1', owners: ['worker-1'], state: 'active', note: '进行中' }],
        threads: [{ id: 'th-1', title: '线程 1', goal: '', now: '', workstreams: ['ws-1'], attention: [] }],
      },
      plan: { goal: { title: 'Stale Plan Goal Should Not Leak', line: '' }, tasks: {}, threads: [] },
      plan_zh: null,
      systemAttention: [
        { id: 'sys-w1-stuck', kind: 'stuck', member: 'worker-1', text: 'worker-1 stalled', text_zh: 'worker-1 停滞' },
      ],
    });
    const ctxSys = openSwarmDom(t, { snapshot: snapZhSys, url: 'http://127.0.0.1:4321/?tab=overview' });
    await waitFor(() => !!ctxSys.doc.querySelector('#ov-plain .o2-goal b'));
    assert.equal(ctxSys.doc.querySelector('#ov-plain .o2-goal .o2-orig'), null);
    const zhAsks = [...ctxSys.doc.querySelectorAll('#ov-plain .o2-ask b')].map((el) => el.textContent);
    assert.ok(zhAsks.includes('协调者正在等待你的回复'));
    assert.ok(zhAsks.includes('@worker-1 疑似停滞'));
    ctxSys.doc.getElementById('tabbtn-members').click();
    await waitFor(() => !!ctxSys.doc.querySelector('#members .o2-mrow.coord .o2-mnow'));
    assert.equal(ctxSys.doc.querySelector('#members .o2-mrow.coord .o2-mnow').textContent, '正在对话中等待你的回复');
  });

  test('S17: r6 regressions — viewCopy.items collision hijacking, sanitizeViewForHive bounded sanitization, and 3+-level nested-paren URLs (O(n))', async (t) => {
    // 1(a) Collision: attention id 'w0'/'w1'/'w2' with short vs id-less / stripped-ID workstreams without short
    const wsCollision = [
      { id: 'bad_ws_0', title: 'Real Active WS Zero', owners: ['worker-1'], state: 'active', note: 'Real active note zero' },
      { title: 'Real Done WS One', owners: ['worker-1'], state: 'done', note: 'Real done note one' },
      { title: 'Real Queued WS Two', owners: ['worker-2'], state: 'queued', note: 'Real queued note two' },
    ];
    const attCollision = [
      { id: 'w0', kind: 'decision', severity: 'high', title: 'Att W0', why: 'Att W0 why', short: { title: 'HIJACKED_W0', line: 'HIJACKED_W0_LINE' }, refs: [{ member: 'worker-1' }] },
      { id: 'w1', kind: 'fyi', severity: 'low', title: 'Att W1', why: 'Att W1 why', short: { title: 'HIJACKED_W1', line: 'HIJACKED_W1_LINE' } },
      { id: 'w2', kind: 'fyi', severity: 'low', title: 'Att W2', why: 'Att W2 why', short: { title: 'HIJACKED_W2', line: 'HIJACKED_W2_LINE' } },
    ];
    const snapColA = buildSnapshot({
      etag: 'etag-s17-col-a',
      builtinOverview: true,
      systemAttention: [],
      members: [
        { name: 'coordinator', role: 'coordinator', status: 'waiting', steps: 2, posts: 1, unread: 0 },
        { name: 'worker-1', role: 'worker', status: 'waiting', steps: 1, posts: 1, unread: 0 },
        { name: 'worker-2', role: 'worker', status: 'waiting', steps: 1, posts: 1, unread: 0 },
      ],
      view: {
        exists: true,
        json: { version: 1, as_of_seq: 5, headline: 'Col A', attention: attCollision, workstreams: wsCollision },
        html: '',
        htmlKey: '',
      },
      view_zh: { version: 1, as_of_seq: 5, headline: '冲突测试 A', attention: attCollision, workstreams: wsCollision },
      plan: null,
      plan_zh: null,
    });
    const ctxColA = openSwarmDom(t, { snapshot: snapColA, langMode: 'zh', url: 'http://127.0.0.1:4321/?tab=overview' });
    await waitFor(() => !!ctxColA.doc.querySelector('#ov-plain .o2-runt'));
    assert.equal(ctxColA.doc.querySelector('#ov-plain .o2-runt').textContent, 'Real Active WS Zero');
    assert.ok(!ctxColA.doc.querySelector('#ov-plain .o2-run').textContent.includes('HIJACKED_W0'));

    ctxColA.doc.querySelector('#ov-plain .o2-progh').click();
    assert.equal(ctxColA.doc.querySelector('#ov-plain .o2-donelist:not(.queued) .o2-donem b').textContent, 'Real Done WS One');
    assert.equal(ctxColA.doc.querySelector('#ov-plain .o2-donelist.queued .o2-donem b').textContent, 'Real Queued WS Two');
    assert.ok(!ctxColA.doc.querySelector('#ov-plain .o2-progb').textContent.includes('HIJACKED_'));

    const tOtherBtn = ctxColA.doc.querySelector('#ov-plain [data-o2t="t-other"]');
    if (tOtherBtn.getAttribute('aria-expanded') !== 'true') tOtherBtn.click();
    const colAThreadTasks = [...ctxColA.doc.querySelectorAll('#ov-plain .o2-tasks .o2-tt')].map((el) => el.textContent);
    assert.ok(colAThreadTasks.some((x) => x.startsWith('Real Active WS Zero')));
    assert.ok(colAThreadTasks.includes('Real Done WS One'));
    assert.ok(colAThreadTasks.includes('Real Queued WS Two'));
    assert.ok(!colAThreadTasks.some((x) => x.includes('HIJACKED_')));

    // overviewView fallback card layout for 1(a)
    const snapColAFallback = buildSnapshot({
      etag: 'etag-s17-col-a-fb',
      builtinOverview: false,
      systemAttention: [],
      members: [
        { name: 'coordinator', role: 'coordinator', status: 'waiting', steps: 2, posts: 1, unread: 0 },
        { name: 'worker-1', role: 'worker', status: 'waiting', steps: 1, posts: 1, unread: 0 },
      ],
      messages: [
        { seq: 1, agent: 'coordinator', ts: Date.UTC(2026, 10, 19, 10, 0, 0), mentions: [], text: '[done] Complete', text_zh: '[已完成] 完成' },
      ],
      head: 1,
      view: { ...snapColA.view, json: { ...snapColA.view.json, attention: attCollision.map((a) => ({ ...a, kind: 'fyi' })) } },
      view_zh: { ...snapColA.view_zh, attention: attCollision.map((a) => ({ ...a, kind: 'fyi' })) },
      plan: null,
      plan_zh: null,
    });
    const ctxColAFb = openSwarmDom(t, { snapshot: snapColAFallback, langMode: 'zh', url: 'http://127.0.0.1:4321/?tab=overview' });
    await waitFor(() => !!ctxColAFb.doc.querySelector('#ov-plain .o2-br.running .o2-card'));
    assert.equal(ctxColAFb.doc.querySelector('#ov-plain .o2-br.running .o2-card b').textContent, 'Real Active WS Zero');
    assert.equal(ctxColAFb.doc.querySelector('#ov-plain .o2-br.running .o2-card p').textContent, 'Real active note zero');

    // 1(b) Collision: attention id 'worker-1' with short vs fallback workstream (workstreams: [])
    const snapColB = buildSnapshot({
      etag: 'etag-s17-col-b',
      builtinOverview: true,
      systemAttention: [],
      members: [
        { name: 'coordinator', role: 'coordinator', status: 'waiting', steps: 2, posts: 1, unread: 0 },
        { name: 'worker-1', role: 'worker', status: 'working', activity: 'Real Worker1 Activity', activity_zh: '真实执行者一活动', steps: 1, posts: 1, unread: 0 },
      ],
      view: {
        exists: true,
        json: {
          version: 1,
          as_of_seq: 5,
          headline: 'Col B',
          attention: [{ id: 'worker-1', kind: 'decision', severity: 'high', title: 'Att Worker1', why: 'Att why', short: { title: 'HIJACKED_WORKER1', line: 'HIJACKED_WORKER1_LINE' }, refs: [{ member: 'worker-1' }] }],
          workstreams: [],
        },
        html: '',
        htmlKey: '',
      },
      view_zh: {
        version: 1,
        as_of_seq: 5,
        headline: '冲突测试 B',
        attention: [{ id: 'worker-1', kind: 'decision', severity: 'high', title: '关注点', why: '原因', short: { title: 'HIJACKED_WORKER1', line: 'HIJACKED_WORKER1_LINE' }, refs: [{ member: 'worker-1' }] }],
        workstreams: [],
      },
      plan: { goal: { title: 'Goal B', line: '' }, tasks: { 'worker-1': 'Real Worker1 Task Title' }, threads: [] },
      plan_zh: { goal: { title: '目标 B', line: '' }, tasks: { 'worker-1': '真实执行者一任务' }, threads: [] },
    });
    const ctxColB = openSwarmDom(t, { snapshot: snapColB, langMode: 'zh', url: 'http://127.0.0.1:4321/?tab=overview' });
    await waitFor(() => !!ctxColB.doc.querySelector('#ov-plain .o2-runt'));
    assert.ok(!ctxColB.doc.querySelector('#ov-plain .o2-runt').textContent.includes('HIJACKED_WORKER1'));

    // 1(c) Collision: shared explicit id 'shared-1' (attention has short, workstream does not) & reverse ('shared-ws')
    const snapColC = buildSnapshot({
      etag: 'etag-s17-col-c',
      builtinOverview: true,
      systemAttention: [],
      members: [
        { name: 'coordinator', role: 'coordinator', status: 'waiting', steps: 2, posts: 1, unread: 0 },
        { name: 'worker-1', role: 'worker', status: 'waiting', steps: 1, posts: 1, unread: 0 },
      ],
      view: {
        exists: true,
        json: {
          version: 1,
          as_of_seq: 5,
          headline: 'Col C',
          attention: [
            { id: 'shared-1', kind: 'decision', severity: 'high', title: 'Att Shared', why: 'Att shared why', short: { title: 'HIJACKED_SHARED', line: 'HIJACKED_SHARED_LINE' }, refs: [{ member: 'worker-1' }] },
            { id: 'shared-ws', kind: 'review', severity: 'low', title: 'Real Att SharedWS', why: 'Real att sharedws why', refs: [{ member: 'worker-1' }] },
          ],
          workstreams: [
            { id: 'shared-1', title: 'Real Shared WS', owners: ['worker-1'], state: 'active', note: 'Real shared note' },
            { id: 'shared-ws', title: 'WS SharedWS', owners: ['worker-1'], state: 'done', note: 'Done note', short: { title: 'HIJACKED_BY_WS_SHORT', line: 'HIJACKED_BY_WS_LINE' } },
          ],
          threads: [
            { id: 'th-shared', title: 'Shared Thread', goal: '', now: '', workstreams: ['shared-1', 'shared-ws'], attention: ['shared-1', 'shared-ws'] },
          ],
        },
        html: '',
        htmlKey: '',
      },
      view_zh: null,
      plan: null,
      plan_zh: null,
    });
    const ctxColC = openSwarmDom(t, { snapshot: snapColC, langMode: 'zh', url: 'http://127.0.0.1:4321/?tab=overview' });
    await waitFor(() => !!ctxColC.doc.querySelector('#ov-plain .o2-runt'));
    assert.equal(ctxColC.doc.querySelector('#ov-plain .o2-runt').textContent, 'Real Shared WS');
    const colCAsks = [...ctxColC.doc.querySelectorAll('#ov-plain .o2-ask b')].map((el) => el.textContent);
    assert.ok(colCAsks.includes('Real Att SharedWS'));
    assert.ok(!colCAsks.includes('HIJACKED_BY_WS_SHORT'));

    // 1(d) Symmetric collision: workstream id 'ask-7' with short vs id-less attention fallback (seq: 7)
    const snapColD = buildSnapshot({
      etag: 'etag-s17-col-d',
      builtinOverview: false,
      systemAttention: [],
      members: [
        { name: 'coordinator', role: 'coordinator', status: 'waiting', steps: 2, posts: 1, unread: 0 },
        { name: 'worker-1', role: 'worker', status: 'waiting', steps: 1, posts: 1, unread: 0 },
      ],
      messages: [
        { seq: 7, agent: 'worker-1', ts: Date.UTC(2026, 10, 19, 10, 0, 0), mentions: ['coordinator'], text: 'Need decision #7', text_zh: '需要决策 #7' },
      ],
      head: 7,
      view: {
        exists: true,
        json: {
          version: 1,
          as_of_seq: 7,
          headline: 'Col D',
          attention: [
            { kind: 'decision', severity: 'high', title: 'Real Ask Seven', why: 'Real ask seven reason', refs: [{ seq: 7 }, { member: 'worker-1' }] },
          ],
          workstreams: [
            { id: 'ask-7', title: 'WS Ask7', owners: ['worker-1'], state: 'active', note: 'Active ask7', short: { title: 'HIJACKED_BY_ASK7_WS', line: 'HIJACKED_BY_ASK7_LINE' } },
          ],
        },
        html: '',
        htmlKey: '',
      },
      view_zh: null,
      plan: null,
      plan_zh: null,
    });
    const ctxColD = openSwarmDom(t, { snapshot: snapColD, langMode: 'zh', url: 'http://127.0.0.1:4321/?tab=overview' });
    await waitFor(() => !!ctxColD.doc.querySelector('#ov-plain .o2-br.waiting .o2-card'));
    assert.equal(ctxColD.doc.querySelector('#ov-plain .o2-br.waiting .o2-card b').textContent, 'Real Ask Seven');
    assert.equal(ctxColD.doc.querySelector('#ov-plain .o2-br.waiting .o2-card p').textContent, 'Real ask seven reason');

    // 2. sanitizeViewForHive: non-string goal.title, running_summary, now, progress.label, oversized threads & t.workstreams, reel
    const capturedSan = [];
    const malformedView = {
      version: 1,
      as_of_seq: 5,
      headline: 'Safe Headline Fallback',
      goal: { title: { bad: 'obj' }, line: { bad: 'line' } },
      running_summary: { bad: 'summary' },
      now: { 'worker-1': { bad: 'nowObj' }, 'worker-2': 'Z'.repeat(120) },
      reel: {
        frames: Array.from({ length: 30 }, (_, i) => ({
          path: `/frame-${i}.png`,
          caption: i === 0 ? { bad: 'capObj' } : `Frame ${i}`,
          seq: i + 1,
        })),
      },
      attention: [],
      workstreams: [
        { id: 'ws-prog', title: 'Progress Task', owners: ['worker-1'], state: 'active', note: 'Working', progress: { done: 2, total: 5, label: { bad: 'lblObj' } } },
      ],
      threads: Array.from({ length: 16 }, (_, i) => ({
        id: `th-${i}`,
        title: `Thread ${i}`,
        goal: `Goal ${i}`,
        now: `Now ${i}`,
        workstreams: ['ws-prog', { bad: 'wsRef' }, ...Array.from({ length: 50 }, (__, j) => `extra-${j}`)],
        attention: Array.from({ length: 40 }, (__, j) => `att-${j}`),
      })),
    };
    const snapMal = buildSnapshot({
      etag: 'etag-s17-malformed',
      builtinOverview: true,
      systemAttention: [],
      frames: [],
      view: { exists: true, json: malformedView, html: '', htmlKey: '' },
      view_zh: null,
      plan: null,
      plan_zh: null,
    });
    const ctxMal = openSwarmDom(t, {
      snapshot: snapMal,
      langMode: 'en',
      url: 'http://127.0.0.1:4321/?tab=overview',
      beforeParse(win) {
        let realHive;
        Object.defineProperty(win, 'SwarmHive', {
          configurable: true,
          get() { return realHive; },
          set(val) {
            realHive = val;
            if (val && typeof val.update === 'function') {
              const origUpdate = val.update.bind(val);
              val.update = (s, el, opts) => {
                capturedSan.push({ view: opts?.view, snap: s });
                return origUpdate(s, el, opts);
              };
            }
          },
        });
      },
    });
    await waitFor(() => !!ctxMal.doc.querySelector('#ov-plain .o2-goal b'));
    assert.ok(!ctxMal.doc.querySelector('#ov-plain').textContent.includes('[object Object]'));
    assert.equal(ctxMal.doc.querySelector('#ov-plain .o2-goal b').textContent, 'Safe Headline Fallback');
    assert.equal(ctxMal.doc.querySelector('#ov-plain .o2-tprog')?.textContent, '2/5');
    assert.equal(ctxMal.doc.querySelectorAll('#ov-plain .o2-th').length, 12);

    const malArg = capturedSan.find((c) => c.view === 'overview');
    assert.ok(malArg);
    const sanView = malArg.snap.view.json;
    assert.equal(sanView.goal.title, '');
    assert.equal(sanView.goal.line, '');
    assert.equal(sanView.running_summary, '');
    assert.equal(sanView.now['worker-1'], undefined);
    assert.equal(sanView.now['worker-2'].length, 80);
    assert.equal(sanView.threads.length, 12);
    assert.equal(sanView.threads[0].workstreams.length, 39);
    assert.ok(sanView.threads[0].workstreams.every((x) => typeof x === 'string' && !x.includes('[object')));
    assert.equal(sanView.threads[0].attention.length, 30);
    assert.equal(sanView.reel.frames.length, 24);
    assert.equal(sanView.reel.frames[0].caption, '');

    // 3. 3-level & 4-level nested-paren URLs + file:// URLs + ReDoS check in app.js & hive.js
    const snapUrls = buildSnapshot({
      etag: 'etag-s17-urls',
      systemAttention: [],
      messages: [
        {
          seq: 1,
          agent: 'worker-1',
          ts: Date.UTC(2026, 10, 19, 10, 0, 0),
          mentions: [],
          text: '3-level: https://example.com/a_(b_(c_(d)))#12 and 4-level: https://example.com/a_(b_(c_(d_(e))))#12 and outer: (https://example.com/a_(b_(c_(d)))#12)! and file: file:///tmp/dir_(1_(2_(3)))/doc#12',
          text_zh: '三级：https://example.com/a_(b_(c_(d)))#12 与四级：https://example.com/a_(b_(c_(d_(e))))#12 及外括号：(https://example.com/a_(b_(c_(d)))#12)! 和文件：file:///tmp/dir_(1_(2_(3)))/doc#12',
        },
        {
          seq: 2,
          agent: 'worker-1',
          ts: Date.UTC(2026, 10, 19, 10, 1, 0),
          mentions: [],
          text: `ReDoS check: https://example.com/${'('.repeat(2500)}a${')'.repeat(2499)} and ${'https://a('.repeat(300)} [done]`,
          text_zh: null,
        },
      ],
      head: 12,
    });
    const t0 = performance.now();
    const ctxUrl = openSwarmDom(t, { snapshot: snapUrls, langMode: 'zh', url: 'http://127.0.0.1:4321/?tab=feed' });
    await waitFor(() => ctxUrl.doc.querySelectorAll('#feed .msg').length === 2);
    const elapsedFeedMs = performance.now() - t0;
    assert.ok(elapsedFeedMs < 1500, `expected fast feed render without ReDoS, took ${elapsedFeedMs.toFixed(1)}ms`);

    const msg1Body = ctxUrl.doc.querySelector('article.msg[data-seq="1"] .msg-body');
    assert.equal(msg1Body.querySelectorAll('button.seq-ref').length, 0, 'nested-paren URLs must not expose #12 as .seq-ref');
    assert.ok(msg1Body.textContent.includes('https://example.com/a_(b_(c_(d)))#12'));
    assert.ok(msg1Body.textContent.includes('https://example.com/a_(b_(c_(d_(e))))#12'));
    assert.ok(msg1Body.textContent.includes('(https://example.com/a_(b_(c_(d)))#12)!'));
    assert.ok(msg1Body.textContent.includes('file:///tmp/dir_(1_(2_(3)))/doc#12'));

    const fb = ctxUrl.win.SwarmHive.tier1Fallback;
    assert.equal(
      fb('See https://example.com/a_(b_(c_(d)))#12 and (https://example.com/a_(b_(c_(d_(e))))#12)! and file:///tmp/dir_(1_(2_(3)))/doc#12 [done]'),
      'See https://example.com/a_(b_(c_(d)))#12 and (https://example.com/a_(b_(c_(d_(e))))#12)! and file:///tmp/dir_(1_(2_(3)))/doc#12 [已完成]'
    );
    assert.equal(
      fb('Check https://example.com/a_(b_(c))! [done]'),
      'Check https://example.com/a_(b_(c))! [已完成]'
    );

    const t1 = performance.now();
    const redosFb = fb(`https://example.com/${'('.repeat(3000)}a${')'.repeat(2999)} ${'https://a('.repeat(500)} [done]`);
    const elapsedFbMs = performance.now() - t1;
    assert.ok(redosFb.endsWith('[已完成]'));
    assert.ok(elapsedFbMs < 100, `expected linear O(n) tier1Fallback without ReDoS, took ${elapsedFbMs.toFixed(1)}ms`);
  });

  test('S18: r7 regressions — progress.label shadowing, bi-mode reel.frames[].caption parity & prototype-key hardening', async (t) => {
    // 1. workstreams[].progress.label in zh/bi/en + fallback when view_zh lacks progress and rawView has "2 of 5 done"
    // 2. reel.frames[].caption translated in-place in view_zh (no caption_zh) across zh, bi, en + lightbox (.o2-tv)
    const snap = buildSnapshot({
      etag: 'etag-s18-main',
      builtinOverview: true,
      systemAttention: [],
      frames: [],
      members: [
        { name: 'coordinator', role: 'coordinator', status: 'waiting', steps: 2, posts: 1, unread: 0 },
        { name: 'worker-1', role: 'worker', status: 'waiting', steps: 1, posts: 1, unread: 0 },
        { name: 'worker-2', role: 'worker', status: 'waiting', steps: 1, posts: 1, unread: 0 },
        { name: 'toString', role: 'worker', status: 'waiting', steps: 1, posts: 1, unread: 0 },
        { name: 'constructor', role: 'worker', status: 'waiting', steps: 1, posts: 1, unread: 0 },
      ],
      messages: [
        { seq: 1, agent: 'worker-1', ts: Date.UTC(2026, 10, 19, 10, 0, 0), mentions: [], text: 'Step 1 ok', text_zh: '步骤 1 完成' },
        { seq: 2, agent: 'worker-2', ts: Date.UTC(2026, 10, 19, 10, 1, 0), mentions: [], text: 'Step 2 ok', text_zh: '步骤 2 完成' },
        { seq: 3, agent: 'toString', ts: Date.UTC(2026, 10, 19, 10, 2, 0), mentions: [], text: 'Running unit checks', text_zh: '正在运行单元检查' },
        { seq: 4, agent: 'constructor', ts: Date.UTC(2026, 10, 19, 10, 3, 0), mentions: [], text: 'Building bundle', text_zh: '正在构建产物' },
      ],
      head: 4,
      view: {
        exists: true,
        json: {
          version: 1,
          as_of_seq: 4,
          headline: 'Gateway rollout',
          now: {
            toString: 'Custom toString status',
            constructor: 'Should be skipped safely',
            __proto__: 'Should not pollute',
            prototype: 'Should not pollute',
            'worker-1': 'Reviewing metrics',
          },
          reel: {
            frames: [
              { path: '/screens/step1.png', seq: 1, caption: 'Initial gateway dashboard' },
              { path: '/screens/step2.png', seq: 2, caption: 'Updated gateway metrics' },
            ],
          },
          attention: [],
          workstreams: [
            {
              id: 'ws-lbl',
              title: 'Roll out gateway',
              owners: ['worker-1'],
              state: 'active',
              note: 'Rolling out',
              progress: { done: 2, total: 5, label: '2 of 5 steps' },
            },
            {
              id: 'ws-fb',
              title: 'Fallback progress task',
              owners: ['worker-2'],
              state: 'active',
              note: '2 of 5 done',
            },
          ],
          threads: [
            { id: 'th-1', title: 'Rollout', goal: '', now: '', workstreams: ['ws-lbl', 'ws-fb'], attention: [] },
          ],
        },
        html: '',
        htmlKey: '',
      },
      view_zh: {
        version: 1,
        as_of_seq: 4,
        headline: '网关发布',
        now: {
          toString: '自定义 toString 状态',
          constructor: '不应注入原型属性',
          __proto__: '不应污染原型',
          prototype: '不应污染原型',
          'worker-1': '正在查看指标',
        },
        reel: {
          frames: [
            { path: '/screens/step1.png', seq: 1, caption: '初始网关面板' },
            { path: '/screens/step2.png', seq: 2, caption: '更新后的网关指标' },
          ],
        },
        attention: [],
        workstreams: [
          {
            id: 'ws-lbl',
            title: '发布网关',
            owners: ['worker-1'],
            state: 'active',
            note: '正在发布',
            progress: { done: 2, total: 5, label: '第 2 / 5 步' },
          },
          {
            id: 'ws-fb',
            title: '回退进度任务',
            owners: ['worker-2'],
            state: 'active',
            note: '正在处理第二部分',
            progress: undefined,
          },
        ],
        threads: [
          { id: 'th-1', title: '发布线', goal: '', now: '', workstreams: ['ws-lbl', 'ws-fb'], attention: [] },
        ],
      },
      plan: null,
      plan_zh: null,
    });

    const captured = [];
    const ctx = openSwarmDom(t, {
      snapshot: snap,
      langMode: 'zh',
      url: 'http://127.0.0.1:4321/?tab=overview',
      beforeParse(win) {
        let realHive;
        Object.defineProperty(win, 'SwarmHive', {
          configurable: true,
          get() { return realHive; },
          set(val) {
            realHive = val;
            if (val && typeof val.update === 'function') {
              const origUpdate = val.update.bind(val);
              val.update = (s, el, opts) => {
                captured.push({ view: opts?.view, snap: s });
                return origUpdate(s, el, opts);
              };
            }
          },
        });
      },
    });
    const { doc, win } = ctx;
    await waitFor(() => !!doc.querySelector('#ov-plain .o2-tprog'));

    // 1(a) 'zh' mode: translated progress.label & fallback note-based progress
    const pillsZh = [...doc.querySelectorAll('#ov-plain .o2-runrow .o2-tprog')];
    assert.equal(pillsZh.length, 2);
    assert.equal(pillsZh[0].textContent, '第 2 / 5 步');
    assert.equal(pillsZh[0].getAttribute('title'), '第 2 / 5 步 已完成');
    assert.ok(!pillsZh[0].textContent.includes('2 of 5 steps'));
    assert.equal(pillsZh[1].textContent, '2/5');
    assert.equal(pillsZh[1].getAttribute('title'), '2/5 已完成');

    // 2(a) 'zh' mode: reel caption shows Chinese
    assert.equal(doc.querySelector('#ov-plain .o2-rcap').textContent, '更新后的网关指标');

    // 3(a) Prototype-key hardening in sanitizeViewForHive now + memberCopy/members
    const ovCall = captured.find((c) => c.view === 'overview');
    assert.ok(ovCall);
    const sanNow = ovCall.snap.view.json.now;
    assert.equal(Object.getPrototypeOf(sanNow), null);
    assert.equal(Object.hasOwn(sanNow, 'constructor'), false);
    assert.equal(Object.hasOwn(sanNow, '__proto__'), false);
    assert.equal(Object.hasOwn(sanNow, 'prototype'), false);
    assert.equal(sanNow.toString, '自定义 toString 状态');
    assert.deepStrictEqual(JSON.parse(JSON.stringify(sanNow)), {
      toString: '自定义 toString 状态',
      'worker-1': '正在查看指标',
    });

    const crewTitles = [...doc.querySelectorAll('#ov-plain .o2-crew .o2-m')].map((b) => b.getAttribute('title') || '');
    assert.ok(crewTitles.some((s) => s === 'toString: 自定义 toString 状态'), `expected own toString status in ${JSON.stringify(crewTitles)}`);
    assert.ok(crewTitles.some((s) => s === 'constructor: 正在构建产物'), `expected fallback constructor status without prototype leak in ${JSON.stringify(crewTitles)}`);
    assert.ok(!crewTitles.some((s) => s.includes('function ') || s.includes('[native code]')));

    // 2(b) Scrub to frame 0 & verify lightbox caption stays pure Chinese
    assert.equal(doc.querySelector('[data-testid="swarm-lang-mode"]'), null);
    const scrubZh = doc.querySelector('#ov-plain .o2-rscrub');
    scrubZh.value = '0';
    scrubZh.dispatchEvent(new win.Event('input', { bubbles: true }));
    assert.equal(doc.querySelector('#ov-plain .o2-rcap').textContent, '初始网关面板');
    doc.querySelector('#ov-plain .o2-rexp').click();
    const lbZh = doc.querySelector('.o2-tv');
    assert.ok(lbZh);
    assert.equal(lbZh.querySelector('.o2-tvcap').textContent, '初始网关面板');
    lbZh.querySelector('.o2-tvx').click();

    scrubZh.value = '1';
    scrubZh.dispatchEvent(new win.Event('input', { bubbles: true }));
    assert.equal(doc.querySelector('#ov-plain .o2-rcap').textContent, '更新后的网关指标');

    // 3(b) Test memberLine fallback when viewCopy.members is empty (no 'toString' / 'constructor' key)
    const snapPlainMembers = buildSnapshot({
      etag: 'etag-s18-plain-members',
      builtinOverview: true,
      systemAttention: [],
      members: [
        { name: 'coordinator', role: 'coordinator', status: 'waiting', steps: 1, posts: 1, unread: 0 },
        { name: 'toString', role: 'worker', status: 'waiting', steps: 1, posts: 1, unread: 0 },
        { name: 'constructor', role: 'worker', status: 'waiting', steps: 1, posts: 1, unread: 0 },
      ],
      messages: [
        { seq: 1, agent: 'toString', ts: Date.UTC(2026, 10, 19, 10, 0, 0), mentions: [], text: 'ToString post', text_zh: 'ToString 消息' },
        { seq: 2, agent: 'constructor', ts: Date.UTC(2026, 10, 19, 10, 1, 0), mentions: [], text: 'Constructor post', text_zh: 'Constructor 消息' },
      ],
      head: 2,
      view: { exists: false, json: null, html: '', htmlKey: '' },
      view_zh: null,
      plan: null,
      plan_zh: null,
    });
    const standaloneEl = doc.createElement('div');
    doc.body.appendChild(standaloneEl);
    win.SwarmHive.update(snapPlainMembers, standaloneEl, { view: 'overview', langMode: 'zh', force: true });
    const standaloneCrew = [...standaloneEl.querySelectorAll('.o2-crew .o2-m')].map((b) => b.getAttribute('title') || '');
    assert.ok(standaloneCrew.some((s) => s === 'toString: ToString 消息'));
    assert.ok(standaloneCrew.some((s) => s === 'constructor: Constructor 消息'));
    assert.ok(!standaloneCrew.some((s) => s.includes('function ') || s.includes('[native code]')));

    // Verify Bug 7 fix: colorOf / avatarHtml never emit #NaNNaNNaN for prototype keys
    for (const protoName of ['toString', 'constructor', 'valueOf', '__proto__']) {
      const col = win.SwarmHive.colorOf(protoName);
      const av = win.SwarmHive.avatarHtml(protoName);
      assert.match(col, /^#[0-9a-f]{6}$/i, `colorOf(${protoName}) must be valid hex, got ${col}`);
      assert.equal(av.includes('NaN'), false, `avatarHtml(${protoName}) must not contain NaN: ${av}`);
    }
    standaloneEl.remove();
  });

  test('S19: Tier 5 regressions — SEV prototype lookup, bi-mode empty reel caption fallback, lastGood & stale/paused overview', async (t) => {
    // 1. Standalone SwarmHive.update SEV prototype lookup + bi-mode empty reel caption fallback
    const snap = buildSnapshot({
      etag: 'etag-s19-1',
      builtinOverview: true,
      narratorState: 'paused',
      narrator: {
        name: 'narrator-1',
        conversation_id: 'conv-nar',
        reason: 'quota',
        detail: '429 RESOURCE_EXHAUSTED quota',
        last_read_seq: 1,
        transcriptMtime: Date.now() - 15 * 60 * 1000,
      },
      systemAttention: [],
      frames: [],
      head: 15,
      view: {
        exists: true,
        json: {
          version: 1,
          as_of_seq: 1,
          headline: 'Gateway check',
          attention: [
            { id: 'att-low', kind: 'decision', severity: 'low', title: 'First low ask', why: 'reason 1' },
            { id: 'att-proto', kind: 'decision', severity: 'constructor', title: 'Second proto severity', why: 'reason 2' },
            { id: 'att-high', kind: 'decision', severity: 'high', title: 'Third high ask', why: 'reason 3' },
          ],
          reel: {
            frames: [
              { path: '/screens/f1.png', seq: 1, caption: 'Initial layout' },
              { path: '/screens/f2.png', seq: 2, caption: 'Final layout' },
            ],
          },
          workstreams: [],
        },
        html: '',
        htmlKey: '',
      },
      view_zh: {
        version: 1,
        as_of_seq: 1,
        headline: '网关检查',
        attention: [
          { id: 'att-low', kind: 'decision', severity: 'low', title: '低优先级请求', why: '原因 1' },
          { id: 'att-proto', kind: 'decision', severity: 'constructor', title: '原型键严重级别', why: '原因 2' },
          { id: 'att-high', kind: 'decision', severity: 'high', title: '高优先级请求', why: '原因 3' },
        ],
        reel: {
          frames: [
            { path: '/screens/f1.png', seq: 1, caption: '' },
            { path: '/screens/f2.png', seq: 2, caption: '' },
          ],
        },
        workstreams: [],
      },
    });

    const ctx = openSwarmDom(t, {
      snapshot: snap,
      langMode: 'bi',
      url: 'http://127.0.0.1:4321/?tab=overview',
    });
    const { doc, win } = ctx;
    await waitFor(() => !!doc.querySelector('#ov-plain .o2'));

    // Standalone SEV sort with severity="constructor" must sort high first and keep low before/equal constructor (no NaN)
    const standaloneEl = doc.createElement('div');
    doc.body.appendChild(standaloneEl);
    win.SwarmHive.update(
      {
        ...snap,
        view_zh: null,
        _viewLocalized: false,
        view: {
          exists: true,
          json: {
            version: 1,
            as_of_seq: 1,
            headline: 'Standalone SEV check',
            attention: [
              { id: 'a1', kind: 'decision', severity: 'low', title: 'First' },
              { id: 'a2', kind: 'decision', severity: 'constructor', title: 'Second' },
              { id: 'a3', kind: 'decision', severity: 'high', title: 'Third' },
            ],
            reel: snap.view.json.reel,
            workstreams: [],
          },
        },
      },
      standaloneEl,
      { view: 'overview', langMode: 'bi', force: true }
    );
    const askTitles = [...standaloneEl.querySelectorAll('.o2-ask .o2-askb b')].map((el) => el.textContent.trim());
    assert.deepEqual(askTitles, ['Third', 'First', 'Second']);
    standaloneEl.remove();

    // Bug 9: empty view_zh.reel.frames[i].caption falls back to rawCap in 'bi' mode
    assert.equal(doc.querySelector('#ov-plain .o2-rcap').textContent, 'Final layout');

    // paused: quota badge & stale badge
    assert.equal(doc.querySelector('[data-testid="swarm-overview-badge"]').textContent, '已暂停：配额不足');
    assert.equal(doc.querySelector('[data-testid="swarm-overview-stale"]').textContent, '未及时更新');

    // lastGood view.json fallback notice (invalid JSON & too_large)
    ctx.pushSnapshot({
      ...snap,
      etag: 'etag-s19-invalid',
      view: { ...snap.view, jsonError: 'invalid' },
    });
    await waitFor(() => doc.getElementById('ov-notice').textContent.includes('上次有效的 view.json'));
    assert.equal(doc.getElementById('ov-notice').textContent, '正在显示上次有效的 view.json；当前文件不是有效的 JSON。');

    ctx.pushSnapshot({
      ...snap,
      etag: 'etag-s19-large',
      view: { ...snap.view, jsonError: 'too_large' },
    });
    await waitFor(() => doc.getElementById('ov-notice').textContent.includes('超过 64 KB'));
    assert.equal(doc.getElementById('ov-notice').textContent, '正在显示上次有效的 view.json；当前文件超过 64 KB。');
  });
});
