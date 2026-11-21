'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const P = require('../paths.cjs');

function loadJSDOM() {
  try { return require('jsdom').JSDOM; } catch (_) {}
  for (const c of [path.join(__dirname, '..', 'node_modules', 'jsdom'), path.join(P.CHINESE_ROOT, 'node_modules', 'jsdom')]) {
    if (fs.existsSync(c)) return require(c).JSDOM;
  }
  throw new Error('JSDOM not found');
}
const JSDOM = loadJSDOM();
const source = fs.readFileSync(process.env.AGY_PERSONA_RUNTIME || path.join(__dirname, '../core/new-chat-persona.js'), 'utf8');

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(fn, timeoutMs = 1500) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fn()) return;
    await delay(10);
  }
  assert.ok(fn(), 'waitFor timed out');
}

function openWithBridge(options = {}) {
  const html = options.html || '<main><div contenteditable="true" role="textbox" aria-placeholder="输入任何问题，输入 @ 提及，输入 / 执行操作"></div><div class="agy-composer-footer"><div><button type="button">+</button><button type="button">Orchestrator (Carbon)</button></div><div><button class="agy-send-button">Send</button></div></div></main>';
  const dom = new JSDOM(
    html,
    { url: 'https://localhost:65476', runScripts: 'outside-only' }
  );
  const w = dom.window;
  Object.assign(w, { Headers, TextDecoder, TextEncoder, ArrayBuffer, Uint8Array, Response });

  if (options.lightStorage) {
    w.localStorage.setItem('agy_hud_theme_v2', 'light');
  }

  const staged = [];
  const cancelled = [];
  const saved = new Map();
  const calls = [];

  if (!options.disableBridge) {
    w.__AGY_PERSONA_BRIDGE__ = {
      getDefault: async () => ({ ok: true, mode: options.defaultPersona || 'hakimi' }),
      stageNew: async (mode, token) => {
        if (options.failBridge) throw new Error('IPC error');
        staged.push({ mode, token });
        return { ok: true, mode, token };
      },
      commitNew: async (id, mode, token) => {
        if (options.failBridge) throw new Error('IPC error');
        saved.set(id, mode);
        return { ok: true, mode, token };
      },
      cancelNew: async (tok) => {
        cancelled.push(tok);
        return { ok: true };
      }
    };
  }

  w.fetch = async (url, init) => {
    calls.push(typeof url === 'string' ? url : url.url);
    if (options.customFetch) return options.customFetch(url, init, { staged, cancelled, saved, calls });
    if (String(url).endsWith('/StartCascade')) {
      return new Response(options.responseBody || JSON.stringify({ cascadeId: options.responseId || A }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    }
    return Response.json({});
  };

  w.eval(source);
  w.__AGY_NEW_CHAT_PERSONA__.sync();
  return { dom, w, staged, cancelled, saved, calls };
}

function selectPersonaViaMenu(w, mode) {
  const btn = w.document.getElementById('agy-new-chat-persona-btn');
  assert.ok(btn, 'persona trigger pill button should exist');
  btn.click();
  const menu = w.document.getElementById('agy-new-chat-persona-menu');
  assert.ok(menu, 'persona floating menu should be mounted on body');
  assert.equal(menu.style.display, 'block');
  assert.equal(btn.getAttribute('aria-expanded'), 'true');

  const opt = menu.querySelector(`[data-persona-option="${mode}"]`);
  assert.ok(opt, `persona option "${mode}" should exist in floating menu`);
  opt.click();

  assert.equal(menu.style.display, 'none');
  assert.equal(btn.getAttribute('aria-expanded'), 'false');
}

test('Native HUD pill + custom floating menu renders cleanly without OS <select> and stages/commits StartCascade accurately', async () => {
  const a = openWithBridge({ responseId: A });
  const b = openWithBridge({ responseId: B });
  try {
    const docA = a.w.document;
    assert.equal(docA.querySelector('#agy-new-chat-persona select'), null, 'legacy OS <select> must be completely gone');
    assert.ok(docA.getElementById('agy-new-chat-persona-styles'), 'dedicated style tag must be injected');

    const btnA = docA.getElementById('agy-new-chat-persona-btn');
    assert.ok(btnA);
    assert.equal(btnA.getAttribute('data-persona-mode'), 'hakimi');
    assert.equal(btnA.querySelector('.agy-ncp-label').textContent, '哈基米');
    assert.equal(btnA.textContent.includes('角色'), false, 'pill must not include redundant "角色 " prefix');
    assert.ok(btnA.querySelector('svg.agy-ncp-icon'));
    assert.ok(btnA.querySelector('svg.agy-ncp-chevron'));

    selectPersonaViaMenu(a.w, 'normal');
    assert.equal(btnA.getAttribute('data-persona-mode'), 'normal');
    assert.equal(btnA.querySelector('.agy-ncp-label').textContent, '正常助手');
    assert.equal(a.w.__AGY_NEW_CHAT_PERSONA__.getDraftMode(), 'normal');

    // Real StartCascadeRequest has initial_prompt + workspace_uris, NO cascadeId in request!
    const realReqBody = JSON.stringify({ initialPrompt: '你好', workspaceUris: ['file:///workspace/demo-project'] });
    const [resA, resB] = await Promise.all([
      a.w.fetch('https://localhost:65476/exa.language_server_pb.LanguageServerService/StartCascade', { method: 'POST', body: realReqBody }),
      b.w.fetch('https://localhost:65476/exa.language_server_pb.LanguageServerService/StartCascade', { method: 'POST', body: realReqBody })
    ]);

    assert.equal(resA.status, 200);
    assert.equal(resB.status, 200);
    assert.equal(a.staged.length, 1);
    assert.equal(a.staged[0].mode, 'normal');
    assert.equal(b.staged[0].mode, 'hakimi');

    // Draft resets cleanly to hakimi after StartCascade
    assert.equal(a.w.__AGY_NEW_CHAT_PERSONA__.getDraftMode(), 'hakimi');
    assert.equal(btnA.querySelector('.agy-ncp-label').textContent, '哈基米');

    await waitFor(() => a.saved.get(A) === 'normal' && b.saved.get(B) === 'hakimi');
    assert.equal(a.saved.get(A), 'normal');
    assert.equal(b.saved.get(B), 'hakimi');
    // Zero GetSidecars or HTTP sidecar calls needed when IPC bridge is active
    assert.deepEqual(a.calls.map((x) => new URL(x).pathname.split('/').pop()), ['StartCascade']);
  } finally {
    a.dom.window.close();
    b.dom.window.close();
  }
});

test('Connect 5-byte framed Protobuf StartCascadeResponse and 64-bit varint request NEVER throw and extract cascadeId accurately', async () => {
  // Build Connect-framed StartCascadeResponse: [0x00, 0,0,0,38] + [0x0a (field 1, wire 2), 0x24 (len 36), ...uuid]
  const uuidBytes = new TextEncoder().encode(A);
  const protoMsg = new Uint8Array([0x0a, 0x24, ...uuidBytes]);
  const connectFramed = new Uint8Array(5 + protoMsg.length);
  connectFramed[0] = 0x00;
  connectFramed[4] = protoMsg.length;
  connectFramed.set(protoMsg, 5);

  const x = openWithBridge({ responseBody: connectFramed });
  try {
    let bridged = 0;
    const prev = x.w.fetch;
    x.w.fetch = (...args) => { bridged++; return prev(...args); };

    selectPersonaViaMenu(x.w, 'normal');
    x.w.document.querySelector('.agy-send-button').click();

    // Optimistic navigation removes composer before fetch starts, AND request has 10-byte negative varint + workspace_uris field 3
    x.w.document.querySelector('main').innerHTML = '<section data-testid="conversation-view"></section>';
    const wsUri = new TextEncoder().encode('file:///workspace/demo-project');
    const unrelatedSenderWindowId = new TextEncoder().encode(B);
    const reqBytes = new Uint8Array([
      0x1a, wsUri.length, ...wsUri, // field 3 = workspace_uris (NOT a fork!)
      0x22, 0x24, ...unrelatedSenderWindowId, // field 4 = 36-byte senderWindowId UUID (MUST NOT hijack cascadeId!)
      0x28, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x01 // 10-byte varint that crashed old parser!
    ]);

    const res = await x.w.fetch('https://localhost:65476/exa.language_server_pb.LanguageServerService/StartCascade', {
      method: 'POST',
      body: reqBytes
    });
    assert.equal(res.status, 200);
    assert.ok(bridged > 0);
    await waitFor(() => x.saved.get(A) === 'normal');
    assert.equal(x.saved.get(A), 'normal');
    assert.equal(x.saved.has(B), false, 'unrelated UUID in StartCascadeRequest must never be mistaken for cascadeId');
  } finally {
    x.dom.window.close();
  }
});

test('Failed IPC / offline Sidecar NEVER blocks native StartCascade chat creation', async () => {
  let startCascadeReachedServer = false;
  const x = openWithBridge({
    disableBridge: true,
    customFetch: async (url) => {
      if (String(url).endsWith('/GetSidecars')) return new Response('offline', { status: 500 });
      if (String(url).endsWith('/StartCascade')) {
        startCascadeReachedServer = true;
        return Response.json({ cascadeId: A });
      }
      return Response.json({});
    }
  });
  try {
    const res = await x.w.fetch('https://localhost:65476/exa.language_server_pb.LanguageServerService/StartCascade', {
      method: 'POST',
      body: JSON.stringify({ initialPrompt: '测试离线也不阻塞新建聊天' })
    });
    assert.equal(res.status, 200);
    assert.equal(startCascadeReachedServer, true);
    const body = await res.json();
    assert.equal(body.cascadeId, A);
  } finally {
    x.dom.window.close();
  }
});

test('Fork requests never consume or alter the new-chat draft', async () => {
  const x = openWithBridge({ responseId: A });
  try {
    selectPersonaViaMenu(x.w, 'normal');

    await x.w.fetch('https://localhost:65476/exa.language_server_pb.LanguageServerService/StartCascade', {
      method: 'POST',
      body: JSON.stringify({ parentConversationId: B })
    });
    assert.equal(x.staged.length, 0);
    assert.equal(x.saved.size, 0);

    // Subsequent genuine new chat still uses the 'normal' draft
    await x.w.fetch('https://localhost:65476/exa.language_server_pb.LanguageServerService/StartCascade', {
      method: 'POST',
      body: JSON.stringify({ initialPrompt: '真正的新聊天' })
    });
    await waitFor(() => x.saved.get(A) === 'normal');
    assert.equal(x.saved.get(A), 'normal');
    assert.equal(x.saved.has(B), false);
  } finally {
    x.dom.window.close();
  }
});

test('Regression 1: Subagent Inspector composer ("Message subagent..." placeholder or "+ self" badge) NEVER mounts #agy-new-chat-persona', async () => {
  const subagentPlaceholderDom = openWithBridge({
    html: `
      <aside class="subagent-inspector">
        <div class="surface-composer">
          <div contenteditable="true" role="textbox" aria-placeholder="Message subagent, @ to mention, / for actions"></div>
          <div class="agy-composer-footer">
            <div><button type="button">+</button></div>
            <div><button class="agy-send-button">Send</button></div>
          </div>
        </div>
      </aside>
    `
  });

  const subagentSelfBadgeDom = openWithBridge({
    html: `
      <aside class="subagent-inspector">
        <div class="surface-composer">
          <div contenteditable="true" role="textbox"></div>
          <div class="agy-composer-footer">
            <div><button type="button">+</button><button type="button"><svg></svg> self </button></div>
            <div><button type="button">Stop</button></div>
          </div>
        </div>
      </aside>
    `
  });

  const subagentLexicalOverlayDom = openWithBridge({
    html: `
      <aside class="subagent-inspector">
        <div class="surface-composer">
          <div class="editor-shell">
            <div contenteditable="true" role="textbox"></div>
            <div class="lexical-placeholder">Message subagent, @ to mention, / for actions</div>
          </div>
          <div class="agy-composer-footer">
            <div><button type="button">+</button><button type="button">Codebase Researcher</button></div>
            <div><button type="button">Stop</button></div>
          </div>
        </div>
      </aside>
    `
  });

  try {
    assert.equal(subagentPlaceholderDom.w.document.getElementById('agy-new-chat-persona'), null);
    assert.equal(subagentPlaceholderDom.w.document.getElementById('agy-new-chat-persona-menu'), null);

    assert.equal(subagentSelfBadgeDom.w.document.getElementById('agy-new-chat-persona'), null);
    assert.equal(subagentSelfBadgeDom.w.document.getElementById('agy-new-chat-persona-menu'), null);

    assert.equal(subagentLexicalOverlayDom.w.document.getElementById('agy-new-chat-persona'), null);
    assert.equal(subagentLexicalOverlayDom.w.document.getElementById('agy-new-chat-persona-menu'), null);
  } finally {
    subagentPlaceholderDom.dom.window.close();
    subagentSelfBadgeDom.dom.window.close();
    subagentLexicalOverlayDom.dom.window.close();
  }
});

test('Regression 2: Split-screen window with active [data-testid="conversation-view"][data-cascade-id] NEVER mounts #agy-new-chat-persona on secondary footer and cleans up stale DOM', async () => {
  // First verify initial split-screen mount does NOT mount persona pill anywhere
  const split = openWithBridge({
    html: `
      <div class="workbench-split">
        <section data-testid="conversation-view" data-cascade-id="${A}">
          <div class="surface-composer">
            <div contenteditable="true" role="textbox" aria-placeholder="输入任何问题"></div>
            <div class="agy-composer-footer" id="main-conv-footer">
              <div><button type="button">+</button><button type="button">Gemini 3.1 Pro</button></div>
              <div><button class="agy-send-button">Send</button></div>
            </div>
          </div>
        </section>
        <aside class="right-panel">
          <div class="surface-composer">
            <div contenteditable="true" role="textbox"></div>
            <div class="agy-composer-footer" id="secondary-footer">
              <div><button type="button">+</button></div>
              <div><button class="agy-send-button">Send</button></div>
            </div>
          </div>
        </aside>
      </div>
    `
  });

  // Also verify dynamic transition: Home screen has open menu -> active conversation mounts -> sync() cleans up pill + menu!
  const dynamic = openWithBridge();
  try {
    assert.equal(split.w.document.getElementById('agy-new-chat-persona'), null);
    assert.equal(split.w.document.getElementById('agy-new-chat-persona-menu'), null);

    const api = dynamic.w.__AGY_NEW_CHAT_PERSONA__;
    assert.ok(dynamic.w.document.getElementById('agy-new-chat-persona'));
    api.openMenu();
    assert.equal(dynamic.w.document.getElementById('agy-new-chat-persona-menu').style.display, 'block');

    // Simulate active conversation view mounting alongside a secondary composer without data-cascade-id
    const convSection = dynamic.w.document.createElement('section');
    convSection.setAttribute('data-testid', 'conversation-view');
    convSection.setAttribute('data-cascade-id', A);
    dynamic.w.document.body.appendChild(convSection);

    api.sync();
    assert.equal(dynamic.w.document.getElementById('agy-new-chat-persona'), null, 'stale persona pill must be removed when active cascade exists');
    assert.equal(dynamic.w.document.getElementById('agy-new-chat-persona-menu'), null, 'floating menu must be closed and removed when active cascade exists');

    // Typing "subagent" in genuine New Chat Home textbox must NOT falsely hide the selector
    convSection.remove();
    api.sync();
    assert.ok(dynamic.w.document.getElementById('agy-new-chat-persona'));
    dynamic.w.document.querySelector('[role="textbox"]').textContent = '帮我写一个 subagent 脚本';
    api.sync();
    assert.ok(dynamic.w.document.getElementById('agy-new-chat-persona'), 'user typing "subagent" into Home prompt must not hide New Chat persona pill');
  } finally {
    split.dom.window.close();
    dynamic.dom.window.close();
  }
});

test('Menu dismissal (outside click, Escape, resize, HUD toggle buttons) and light theme synchronization work cleanly', async () => {
  const x = openWithBridge({ lightStorage: true });
  try {
    const doc = x.w.document;
    const api = x.w.__AGY_NEW_CHAT_PERSONA__;
    assert.equal(typeof api.openMenu, 'function');
    assert.equal(typeof api.closeMenu, 'function');
    assert.equal(typeof api.setDraftMode, 'function');

    const wrap = doc.getElementById('agy-new-chat-persona');
    const menu = doc.getElementById('agy-new-chat-persona-menu');
    assert.ok(wrap.classList.contains('agy-theme-light'), 'wrap picks up light mode from localStorage');
    assert.ok(menu.classList.contains('agy-theme-light'), 'menu picks up light mode from localStorage');

    // Open and dismiss via Escape
    api.openMenu();
    assert.equal(menu.style.display, 'block');
    doc.dispatchEvent(new x.w.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    assert.equal(menu.style.display, 'none');

    // Open and dismiss via outside click
    api.openMenu();
    assert.equal(menu.style.display, 'block');
    doc.body.click();
    assert.equal(menu.style.display, 'none');

    // Open and dismiss via window resize
    api.openMenu();
    assert.equal(menu.style.display, 'block');
    x.w.dispatchEvent(new x.w.Event('resize'));
    assert.equal(menu.style.display, 'none');

    // Open and dismiss when #agy-hud-toggle-btn is clicked (even if HUD stops propagation in bubble phase)
    const hudBtn = doc.createElement('button');
    hudBtn.id = 'agy-hud-toggle-btn';
    hudBtn.addEventListener('click', (e) => e.stopPropagation());
    doc.body.appendChild(hudBtn);

    api.openMenu();
    assert.equal(menu.style.display, 'block');
    hudBtn.click();
    assert.equal(menu.style.display, 'none');

    // Verify positioning 6px above button vs flipping 6px below when rect.top < 120
    const btn = doc.getElementById('agy-new-chat-persona-btn');
    x.w.innerWidth = 1024;
    x.w.innerHeight = 768;
    btn.getBoundingClientRect = () => ({ top: 680, bottom: 704, left: 600, right: 676, width: 76, height: 24 });
    api.openMenu();
    assert.equal(menu.style.bottom, '94px');
    assert.equal(menu.style.top, '');
    assert.equal(menu.style.left, '600px');

    btn.getBoundingClientRect = () => ({ top: 80, bottom: 104, left: 900, right: 980, width: 80, height: 24 });
    api.openMenu();
    assert.equal(menu.style.top, '110px');
    assert.equal(menu.style.bottom, '');
    assert.equal(menu.style.left, '772px');

    // Verify light mode detection from #agy-hud-footer-cluster.agy-theme-light when localStorage is cleared
    x.w.localStorage.removeItem('agy_hud_theme_v2');
    api.sync();
    assert.equal(wrap.classList.contains('agy-theme-light'), false);
    const cluster = doc.createElement('div');
    cluster.id = 'agy-hud-footer-cluster';
    cluster.className = 'agy-hud-footer-cluster agy-theme-light';
    doc.querySelector('.agy-composer-footer').appendChild(cluster);
    api.sync();
    assert.equal(wrap.classList.contains('agy-theme-light'), true);
    assert.equal(menu.classList.contains('agy-theme-light'), true);

    // Cross-world CustomEvent mutual exclusion
    let hudCloseFired = 0;
    doc.addEventListener('agy-hud-close-popovers', () => { hudCloseFired++; });
    api.openMenu();
    assert.equal(hudCloseFired, 1);
    assert.equal(menu.style.display, 'block');
    doc.dispatchEvent(new x.w.CustomEvent('agy-ncp-close-menu'));
    assert.equal(menu.style.display, 'none');
  } finally {
    x.dom.window.close();
  }
});

test('Regression 3: App 2.32.1 unstarted data-cascade-id="conversation" mounts pill while [data-side-panel-composer] and [data-testid="side-question-tab-composer"] are strictly rejected', async () => {
  const unstartedAndSidePanels = openWithBridge({
    html: `
      <div class="workbench">
        <section data-testid="conversation-view" data-cascade-id="${A}">
          <div class="agy-composer-footer" id="started-footer">
            <div><button type="button">+</button></div>
            <div><button class="agy-send-button">Send</button></div>
          </div>
        </section>
        <div data-side-panel-composer="">
          <div class="agy-composer-footer" id="subagent-side-footer">
            <div><button type="button">+</button></div>
            <div><button class="agy-send-button">Send</button></div>
          </div>
        </div>
        <div data-testid="side-question-tab-composer" data-side-panel-composer="">
          <div class="agy-composer-footer" id="side-question-footer">
            <div><button type="button">+</button></div>
            <div><button class="agy-send-button">Send</button></div>
          </div>
        </div>
        <section data-testid="conversation-view" data-cascade-id="conversation">
          <div contenteditable="true" role="textbox" aria-placeholder="输入任何问题"></div>
          <div class="agy-composer-footer" id="unstarted-new-chat-footer">
            <div><button type="button">+</button><button type="button">Orchestrator (Carbon)</button></div>
            <div><button class="agy-send-button">Send</button></div>
          </div>
        </section>
      </div>
    `
  });
  try {
    const doc = unstartedAndSidePanels.w.document;
    const pill = doc.getElementById('agy-new-chat-persona');
    assert.ok(pill, 'unstarted data-cascade-id="conversation" New Chat tab must mount persona pill');
    assert.equal(pill.parentElement.id, 'unstarted-new-chat-footer');
    assert.equal(doc.querySelector('#subagent-side-footer #agy-new-chat-persona'), null);
    assert.equal(doc.querySelector('#side-question-footer #agy-new-chat-persona'), null);
    assert.equal(doc.querySelector('#started-footer #agy-new-chat-persona'), null);
  } finally {
    unstartedAndSidePanels.dom.window.close();
  }
});

test('Regression 4a: Enter keydown inside [data-side-panel-composer] textbox NEVER leaks or stages new-chat persona ticket', async () => {
  const x = openWithBridge({
    html: `
      <div class="workbench">
        <div class="surface-composer" data-testid="home-greeting">
          <div id="home-textbox" contenteditable="true" role="textbox" aria-placeholder="输入任何问题"></div>
          <div class="agy-composer-footer" id="home-footer">
            <div><button type="button">+</button><button type="button">Orchestrator (Carbon)</button></div>
            <div><button class="agy-send-button">Send</button></div>
          </div>
        </div>
        <div data-side-panel-composer="">
          <div class="surface-composer">
            <div id="side-textbox" contenteditable="true" role="textbox" aria-placeholder="Ask a side question"></div>
            <div class="agy-composer-footer" id="side-footer">
              <div><button type="button">+</button></div>
              <div><button class="agy-send-button">Send</button></div>
            </div>
          </div>
        </div>
      </div>
    `
  });
  try {
    const doc = x.w.document;
    assert.ok(doc.querySelector('#home-footer #agy-new-chat-persona'));
    const sideTextbox = doc.getElementById('side-textbox');
    sideTextbox.dispatchEvent(new x.w.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    assert.equal(x.staged.length, 0, 'Enter inside side-panel composer must never stage a new-chat ticket');

    const homeTextbox = doc.getElementById('home-textbox');
    homeTextbox.dispatchEvent(new x.w.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await waitFor(() => x.staged.length === 1);
    assert.equal(x.staged.length, 1);
  } finally {
    x.dom.window.close();
  }
});

test('Regression 4b: Stale pending ticket is cancelled when persona menu changes before StartCascade runs', async () => {
  const x = openWithBridge({ responseId: A });
  try {
    assert.equal(x.w.__AGY_NEW_CHAT_PERSONA__.getDraftMode(), 'hakimi');
    x.w.document.querySelector('.agy-send-button').click();
    await waitFor(() => x.staged.length === 1);
    assert.equal(x.staged[0].mode, 'hakimi');
    const firstToken = x.staged[0].token;

    // Before StartCascade runs, user switches persona menu to 'normal'
    selectPersonaViaMenu(x.w, 'normal');
    await waitFor(() => x.cancelled.includes(firstToken));
    assert.ok(x.cancelled.length >= 1, 'stale pending ticket must be cancelled when draft changes');

    const res = await x.w.fetch('https://localhost:65476/exa.language_server_pb.LanguageServerService/StartCascade', {
      method: 'POST',
      body: JSON.stringify({ initialPrompt: '使用最新正常助手模式' })
    });
    assert.equal(res.status, 200);
    await waitFor(() => x.saved.get(A) === 'normal');
    assert.equal(x.saved.get(A), 'normal', 'StartCascade must commit updated normal mode, never stale hakimi');
  } finally {
    x.dom.window.close();
  }
});

test('Regression 4c: AGY_HUD_DEFAULT_PERSONA via bridge.getDefault() initializes draft and governs post-StartCascade reset', async () => {
  const x = openWithBridge({ defaultPersona: 'normal', responseId: A });
  try {
    await waitFor(() => x.w.__AGY_NEW_CHAT_PERSONA__.getDraftMode() === 'normal');
    const btn = x.w.document.getElementById('agy-new-chat-persona-btn');
    assert.equal(btn.querySelector('.agy-ncp-label').textContent, '正常助手');

    const res = await x.w.fetch('https://localhost:65476/exa.language_server_pb.LanguageServerService/StartCascade', {
      method: 'POST',
      body: JSON.stringify({ initialPrompt: '默认正常助手会话' })
    });
    assert.equal(res.status, 200);
    await waitFor(() => x.saved.get(A) === 'normal');
    assert.equal(x.w.__AGY_NEW_CHAT_PERSONA__.getDraftMode(), 'normal');
    assert.equal(btn.querySelector('.agy-ncp-label').textContent, '正常助手');

    // Even if user temporarily picks 'hakimi' for one chat, draft resets back to defaultPersona ('normal') afterward
    selectPersonaViaMenu(x.w, 'hakimi');
    assert.equal(x.w.__AGY_NEW_CHAT_PERSONA__.getDraftMode(), 'hakimi');
    await x.w.fetch('https://localhost:65476/exa.language_server_pb.LanguageServerService/StartCascade', {
      method: 'POST',
      body: JSON.stringify({ initialPrompt: '临时切换一轮', workspaceUris: ['file:///workspace/demo-project'] })
    });
    assert.equal(x.w.__AGY_NEW_CHAT_PERSONA__.getDraftMode(), 'normal');
    assert.equal(btn.querySelector('.agy-ncp-label').textContent, '正常助手');
  } finally {
    x.dom.window.close();
  }
});
