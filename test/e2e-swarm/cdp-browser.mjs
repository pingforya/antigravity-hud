import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';

const DEFAULT_BROWSER_CANDIDATES = [
  process.env.SWARM_E2E_BROWSER,
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
].filter(Boolean);

export function findBrowserExecutable() {
  for (const candidate of DEFAULT_BROWSER_CANDIDATES) {
    if (fs.existsSync(candidate)) return candidate;
  }
  throw new Error(`No headless browser executable found. Checked: ${DEFAULT_BROWSER_CANDIDATES.join(', ')}`);
}

function killProcessTree(proc) {
  if (!proc || proc.killed || proc.exitCode !== null) return;
  try {
    proc.kill();
  } catch {
    // ignore
  }
  if (process.platform === 'win32' && proc.pid) {
    try {
      execFileSync('taskkill', ['/PID', String(proc.pid), '/T', '/F'], { stdio: 'ignore' });
    } catch {
      // already exited
    }
  }
}

function rmDirWithRetry(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 15, retryDelay: 100 });
  } catch {
    // best-effort cleanup
  }
}

class CdpConnection {
  #ws;
  #nextId = 1;
  #pending = new Map();
  #listeners = new Map();
  #closed = false;

  constructor(wsUrl) {
    this.#ws = new globalThis.WebSocket(wsUrl);
  }

  async open(timeoutMs = 10000) {
    if (this.#ws.readyState === globalThis.WebSocket.OPEN) return;
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('CDP WebSocket open timeout')), timeoutMs);
      const onOpen = () => {
        clearTimeout(timer);
        cleanup();
        resolve();
      };
      const onError = (err) => {
        clearTimeout(timer);
        cleanup();
        reject(new Error(`CDP WebSocket error: ${err?.message || err}`));
      };
      const cleanup = () => {
        this.#ws.removeEventListener('open', onOpen);
        this.#ws.removeEventListener('error', onError);
      };
      this.#ws.addEventListener('open', onOpen);
      this.#ws.addEventListener('error', onError);
    });

    this.#ws.addEventListener('message', (ev) => {
      let msg;
      try {
        msg = JSON.parse(typeof ev.data === 'string' ? ev.data : String(ev.data));
      } catch {
        return;
      }
      if (msg.id !== undefined) {
        const entry = this.#pending.get(msg.id);
        if (!entry) return;
        this.#pending.delete(msg.id);
        clearTimeout(entry.timer);
        if (msg.error) {
          entry.reject(new Error(`CDP ${entry.method} failed: ${msg.error.message || JSON.stringify(msg.error)}`));
        } else {
          entry.resolve(msg.result || {});
        }
        return;
      }
      if (msg.method) {
        const set = this.#listeners.get(msg.method);
        if (set) {
          for (const fn of set) {
            try {
              fn(msg.params || {});
            } catch {
              // ignore listener errors
            }
          }
        }
      }
    });

    this.#ws.addEventListener('close', () => {
      this.#closed = true;
      for (const [, entry] of this.#pending) {
        clearTimeout(entry.timer);
        entry.reject(new Error('CDP WebSocket closed'));
      }
      this.#pending.clear();
    });
  }

  on(method, fn) {
    if (!this.#listeners.has(method)) this.#listeners.set(method, new Set());
    this.#listeners.get(method).add(fn);
    return () => this.#listeners.get(method)?.delete(fn);
  }

  send(method, params = {}, timeoutMs = 15000, sessionId = null) {
    if (this.#closed || this.#ws.readyState !== globalThis.WebSocket.OPEN) {
      return Promise.reject(new Error(`CDP connection closed before sending ${method}`));
    }
    const id = this.#nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`CDP ${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.#pending.set(id, { method, resolve, reject, timer });
      const payload = sessionId ? { id, method, params, sessionId } : { id, method, params };
      this.#ws.send(JSON.stringify(payload));
    });
  }

  close() {
    this.#closed = true;
    try {
      this.#ws.close();
    } catch {
      // ignore
    }
  }
}

export class CdpPage {
  #browser;
  #conn;
  #targetId;
  #browserContextId;
  #mainFrameId = null;
  #frameContexts = new Map(); // frameId -> executionContextId (default world)
  #exceptions = [];
  #consoleErrors = [];
  #allowConversationMetadataError = false;
  #closed = false;

  constructor({ browser, conn, targetId, browserContextId, allowConversationMetadataError = false }) {
    this.#browser = browser;
    this.#conn = conn;
    this.#targetId = targetId;
    this.#browserContextId = browserContextId;
    this.#allowConversationMetadataError = allowConversationMetadataError;

    this.#conn.on('Runtime.exceptionThrown', (params) => {
      const details = params.exceptionDetails || {};
      const desc = details.exception?.description || details.text || 'Uncaught exception';
      this.#exceptions.push({
        text: desc,
        url: details.url || '',
        lineNumber: details.lineNumber,
      });
    });

    this.#conn.on('Runtime.consoleAPICalled', (params) => {
      if (params.type !== 'error') return;
      const text = (params.args || [])
        .map((a) => (a.value !== undefined ? String(a.value) : a.description || a.type || ''))
        .join(' ');
      if (this.#isWhitelistedConsoleError(text, '')) return;
      this.#consoleErrors.push({ source: 'console.error', text });
    });

    this.#conn.on('Log.entryAdded', (params) => {
      const entry = params.entry || {};
      if (entry.level !== 'error') return;
      const text = entry.text || '';
      const url = entry.url || '';
      if (this.#isWhitelistedConsoleError(text, url)) return;
      this.#consoleErrors.push({ source: `log.${entry.source || 'browser'}`, text, url });
    });

    this.#conn.on('Runtime.executionContextCreated', (params) => {
      const ctx = params.context;
      if (!ctx || !ctx.auxData) return;
      if (ctx.auxData.isDefault && ctx.auxData.frameId) {
        this.#frameContexts.set(ctx.auxData.frameId, ctx.id);
      }
    });

    this.#conn.on('Runtime.executionContextDestroyed', (params) => {
      for (const [fid, cid] of this.#frameContexts) {
        if (cid === params.executionContextId) this.#frameContexts.delete(fid);
      }
    });

    this.#conn.on('Runtime.executionContextsCleared', () => {
      this.#frameContexts.clear();
    });
  }

  #isWhitelistedConsoleError(text, url) {
    const combined = `${text} ${url}`;
    // Browser automatic /favicon.ico probe on 127.0.0.1 sidecar
    if (/\/favicon\.ico$/i.test(url || '')) return true;
    // Offline Google Fonts CDN loads in index.html:12-14
    if (/fonts\.googleapis\.com|fonts\.gstatic\.com/i.test(combined)) return true;
    // Expected preload.js metadata RPC when explicitly testing ?conversationId= without agentapi
    if (this.#allowConversationMetadataError && /Failed to resolve project ID for conversation|_sidecar\/get-conversation-metadata/i.test(combined)) {
      return true;
    }
    // Status 500 log from network layer caused by the whitelisted _sidecar metadata call
    if (this.#allowConversationMetadataError && /status of 500/i.test(combined) && (!url || /_sidecar\/get-conversation-metadata/i.test(url))) {
      return true;
    }
    return false;
  }

  setAllowConversationMetadataError(allow) {
    this.#allowConversationMetadataError = !!allow;
  }

  async init() {
    await this.#conn.send('Page.enable');
    await this.#conn.send('Runtime.enable');
    await this.#conn.send('Log.enable');
    await this.#conn.send('DOM.enable');
    // Stub external Google Fonts requests locally so offline/GFW TCP stalls never hang Page.loadEventFired
    await this.#conn.send('Fetch.enable', {
      patterns: [
        { urlPattern: 'https://fonts.googleapis.com/*' },
        { urlPattern: 'https://fonts.gstatic.com/*' },
      ],
    });
    this.#conn.on('Fetch.requestPaused', (params) => {
      const url = params.request?.url || '';
      const isCss = url.includes('fonts.googleapis.com');
      this.#conn.send('Fetch.fulfillRequest', {
        requestId: params.requestId,
        responseCode: 200,
        responseHeaders: [{ name: 'Content-Type', value: isCss ? 'text/css; charset=utf-8' : 'font/woff2' }],
        body: '',
      }).catch(() => {});
    });
    const tree = await this.#conn.send('Page.getFrameTree');
    this.#mainFrameId = tree?.frameTree?.frame?.id || null;
  }

  async addInitScript(source) {
    await this.#conn.send('Page.addScriptToEvaluateOnNewDocument', { source });
  }

  async seedLocalStorage(entries) {
    const json = JSON.stringify(entries);
    await this.addInitScript(`(() => {
      const data = ${json};
      for (const [k, v] of Object.entries(data)) {
        if (v === null || v === undefined) localStorage.removeItem(k);
        else localStorage.setItem(k, String(v));
      }
    })();`);
  }

  async navigate(url, { timeout = 12000 } = {}) {
    if (url.includes('conversationId=')) {
      this.#allowConversationMetadataError = true;
    }
    let cancelLoad = () => {};
    const loadPromise = new Promise((resolve, reject) => {
      let settled = false;
      let timer = null;
      let off = () => {};
      cancelLoad = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        off();
        resolve();
      };
      timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        off();
        reject(new Error(`Page.loadEventFired timeout navigating to ${url}`));
      }, timeout);
      off = this.#conn.on('Page.loadEventFired', () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        off();
        resolve();
      });
    });
    try {
      const nav = await this.#conn.send('Page.navigate', { url });
      if (nav.errorText) {
        cancelLoad();
        throw new Error(`Navigation error (${url}): ${nav.errorText}`);
      }
      await loadPromise;
    } catch (err) {
      cancelLoad();
      throw err;
    }
  }

  async reload({ timeout = 12000 } = {}) {
    let cancelLoad = () => {};
    const loadPromise = new Promise((resolve, reject) => {
      let settled = false;
      let timer = null;
      let off = () => {};
      cancelLoad = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        off();
        resolve();
      };
      timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        off();
        reject(new Error('Page.loadEventFired timeout on reload'));
      }, timeout);
      off = this.#conn.on('Page.loadEventFired', () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        off();
        resolve();
      });
    });
    try {
      await this.#conn.send('Page.reload', { ignoreCache: false });
      await loadPromise;
    } catch (err) {
      cancelLoad();
      throw err;
    }
  }

  async evaluate(fnOrExpr, ...args) {
    const expression = typeof fnOrExpr === 'function'
      ? `(${fnOrExpr.toString()})(${args.map((a) => JSON.stringify(a)).join(',')})`
      : String(fnOrExpr);
    const res = await this.#conn.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    if (res.exceptionDetails) {
      throw new Error(`Page evaluate failed: ${res.exceptionDetails.exception?.description || res.exceptionDetails.text}`);
    }
    return res.result?.value;
  }

  async evaluateInFrame(iframeSelector, fnOrExpr, ...args) {
    const expression = typeof fnOrExpr === 'function'
      ? `(${fnOrExpr.toString()})(${args.map((a) => JSON.stringify(a)).join(',')})`
      : String(fnOrExpr);

    // 1. Try same-process child frame via Page.getFrameTree
    const tree = await this.#conn.send('Page.getFrameTree');
    const childFrames = [];
    const collect = (node) => {
      for (const c of node.childFrames || []) {
        childFrames.push(c.frame);
        collect(c);
      }
    };
    collect(tree.frameTree);
    if (childFrames.length) {
      let frameId = childFrames[0].id;
      if (childFrames.length > 1) {
        const doc = await this.#conn.send('DOM.getDocument', { depth: 1 });
        const q = await this.#conn.send('DOM.querySelector', {
          nodeId: doc.root.nodeId,
          selector: iframeSelector,
        });
        if (q.nodeId) {
          const desc = await this.#conn.send('DOM.describeNode', { nodeId: q.nodeId });
          if (desc.node?.frameId) frameId = desc.node.frameId;
        }
      }
      const deadline = Date.now() + 5000;
      let contextId = this.#frameContexts.get(frameId);
      while (!contextId && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 40));
        contextId = this.#frameContexts.get(frameId);
      }
      if (contextId) {
        const res = await this.#conn.send('Runtime.evaluate', {
          expression,
          contextId,
          returnByValue: true,
          awaitPromise: true,
        });
        if (res.exceptionDetails) {
          throw new Error(`Frame evaluate failed: ${res.exceptionDetails.exception?.description || res.exceptionDetails.text}`);
        }
        return res.result?.value;
      }
    }

    // 2. Fallback for OOPIF sandboxed iframe (e.g. sandbox="allow-scripts" srcdoc)
    return this.#browser._evaluateInOopif(this.#browserContextId, expression);
  }

  async waitForFunction(fnOrExpr, args = [], { timeout = 8000, interval = 60, message = '' } = {}) {
    const deadline = Date.now() + timeout;
    let lastErr = null;
    while (Date.now() < deadline) {
      try {
        const val = await this.evaluate(fnOrExpr, ...args);
        if (val) return val;
      } catch (e) {
        lastErr = e;
      }
      await new Promise((r) => setTimeout(r, interval));
    }
    throw new Error(
      `waitForFunction timed out after ${timeout}ms${message ? `: ${message}` : ''}${lastErr ? ` (${lastErr.message})` : ''}`
    );
  }

  async waitForSelector(selector, { timeout = 8000, visible = false } = {}) {
    return this.waitForFunction(
      (sel, reqVis) => {
        const el = document.querySelector(sel);
        if (!el) return false;
        if (!reqVis) return true;
        const st = getComputedStyle(el);
        if (st.display === 'none' || st.visibility === 'hidden') return false;
        if (el.classList.contains('hidden')) return false;
        const rect = el.getBoundingClientRect();
        return rect.width > 0 || rect.height > 0;
      },
      [selector, visible],
      { timeout, message: `selector "${selector}" (visible=${visible})` }
    );
  }

  async waitForSwarmReady({ timeout = 15000 } = {}) {
    await this.waitForFunction(
      () => {
        const board = document.querySelector('[data-testid="swarm-board"]');
        const empty = document.querySelector('[data-testid="swarm-empty-state"]');
        return (board && !board.classList.contains('hidden')) || (empty && !empty.classList.contains('hidden'));
      },
      [],
      { timeout, message: 'swarm board or empty state ready' }
    );
  }

  async click(selector) {
    await this.waitForSelector(selector, { timeout: 6000 });
    const ok = await this.evaluate((sel) => {
      const el = document.querySelector(sel);
      if (!el) return false;
      el.scrollIntoView({ block: 'center', inline: 'center' });
      el.focus?.();
      el.click();
      return true;
    }, selector);
    if (!ok) throw new Error(`click failed: "${selector}" not found`);
  }

  async mouseClick(selector) {
    await this.waitForSelector(selector, { timeout: 6000, visible: true });
    const box = await this.evaluate((sel) => {
      const el = document.querySelector(sel);
      if (!el) return null;
      el.scrollIntoView({ block: 'center', inline: 'center' });
      const r = el.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    }, selector);
    if (!box) throw new Error(`mouseClick failed: "${selector}" not visible`);
    await this.#conn.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: box.x, y: box.y });
    await this.#conn.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: box.x, y: box.y, button: 'left', clickCount: 1 });
    await this.#conn.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: box.x, y: box.y, button: 'left', clickCount: 1 });
  }

  async type(selector, value) {
    await this.waitForSelector(selector, { timeout: 6000 });
    const ok = await this.evaluate((sel, val) => {
      const el = document.querySelector(sel);
      if (!el) return false;
      el.focus();
      el.value = val;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    }, selector, value);
    if (!ok) throw new Error(`type failed: "${selector}" not found`);
  }

  async selectOption(selector, value) {
    await this.waitForSelector(selector, { timeout: 6000 });
    const ok = await this.evaluate((sel, val) => {
      const el = document.querySelector(sel);
      if (!el) return false;
      el.value = val;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    }, selector, value);
    if (!ok) throw new Error(`selectOption failed: "${selector}" not found`);
  }

  async getText(selector) {
    return this.evaluate((sel) => {
      const el = document.querySelector(sel);
      return el ? (el.textContent || '').trim() : null;
    }, selector);
  }

  async getAllText(selector) {
    return this.evaluate((sel) => {
      return [...document.querySelectorAll(sel)].map((el) => (el.textContent || '').trim());
    }, selector);
  }

  async getAttr(selector, attr) {
    return this.evaluate((sel, a) => {
      const el = document.querySelector(sel);
      return el ? el.getAttribute(a) : null;
    }, selector, attr);
  }

  async getLocalStorage(key) {
    return this.evaluate((k) => localStorage.getItem(k), key);
  }

  async setLocalStorage(key, value) {
    await this.evaluate((k, v) => {
      if (v === null || v === undefined) localStorage.removeItem(k);
      else localStorage.setItem(k, String(v));
    }, key, value);
  }

  getErrors() {
    return {
      exceptions: [...this.#exceptions],
      consoleErrors: [...this.#consoleErrors],
    };
  }

  clearErrors() {
    this.#exceptions.length = 0;
    this.#consoleErrors.length = 0;
  }

  assertNoErrors(label = 'browser page') {
    const { exceptions, consoleErrors } = this.getErrors();
    assert.deepEqual(exceptions, [], `${label}: unexpected uncaught page exceptions`);
    assert.deepEqual(consoleErrors, [], `${label}: unexpected console/browser errors`);
  }

  async close() {
    if (this.#closed) return;
    this.#closed = true;
    this.#conn.close();
    await this.#browser._disposePage(this.#targetId, this.#browserContextId);
  }
}

export class CdpBrowser {
  #proc = null;
  #profileDir = null;
  #browserConn = null;
  #httpBase = null;
  #pages = new Set();

  static async launch({ executablePath } = {}) {
    const browser = new CdpBrowser();
    await browser.#start(executablePath || findBrowserExecutable());
    return browser;
  }

  async #start(exe) {
    this.#profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-e2e-cdp-'));
    const args = [
      '--headless=new',
      '--disable-gpu',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-background-networking',
      '--disable-extensions',
      '--remote-debugging-port=0',
      `--user-data-dir=${this.#profileDir}`,
      'about:blank',
    ];
    try {
      this.#proc = spawn(exe, args, { stdio: ['ignore', 'pipe', 'pipe'] });

      let stderrBuf = '';
      const browserWsUrl = await new Promise((resolve, reject) => {
        let settled = false;
        let timer = null;
        const cleanup = () => {
          clearTimeout(timer);
          this.#proc?.stderr?.off('data', onData);
          this.#proc?.off('exit', onExit);
          this.#proc?.off('error', onError);
        };
        const onError = (err) => {
          if (settled) return;
          settled = true;
          cleanup();
          reject(new Error(`Browser spawn error (${exe}): ${err?.message || err}`));
        };
        const onData = (chunk) => {
          stderrBuf += chunk.toString('utf-8');
          const m = stderrBuf.match(/DevTools listening on (ws:\/\/[^\s]+)/);
          if (m && !settled) {
            settled = true;
            cleanup();
            resolve(m[1]);
          }
        };
        const onExit = (code, sig) => {
          if (settled) return;
          settled = true;
          cleanup();
          reject(new Error(`Browser exited early (${code}/${sig}): ${stderrBuf}`));
        };
        timer = setTimeout(() => {
          if (settled) return;
          settled = true;
          cleanup();
          reject(new Error(`Browser DevTools startup timeout. stderr=${stderrBuf}`));
        }, 15000);
        this.#proc.once('error', onError);
        this.#proc.stderr.on('data', onData);
        this.#proc.once('exit', onExit);
      });

      const parsed = new URL(browserWsUrl);
      this.#httpBase = `http://${parsed.host}`;
      this.#browserConn = new CdpConnection(browserWsUrl);
      await this.#browserConn.open();
    } catch (err) {
      try {
        this.#browserConn?.close();
      } catch {
        // ignore
      }
      this.#browserConn = null;
      killProcessTree(this.#proc);
      this.#proc = null;
      if (this.#profileDir) {
        rmDirWithRetry(this.#profileDir);
        this.#profileDir = null;
      }
      throw err;
    }
  }

  async newIsolatedPage({ allowConversationMetadataError = false, localStorageSeed = null, width = 1280, height = 900 } = {}) {
    const { browserContextId } = await this.#browserConn.send('Target.createBrowserContext', {
      disposeOnDetach: true,
    });
    const { targetId } = await this.#browserConn.send('Target.createTarget', {
      url: 'about:blank',
      browserContextId,
      width,
      height,
    });

    const listRes = await fetch(`${this.#httpBase}/json/list`);
    const targets = await listRes.json();
    const target = targets.find((t) => t.id === targetId);
    const pageWsUrl = target?.webSocketDebuggerUrl || `ws://${new URL(this.#httpBase).host}/devtools/page/${targetId}`;

    const pageConn = new CdpConnection(pageWsUrl);
    await pageConn.open();

    const page = new CdpPage({
      browser: this,
      conn: pageConn,
      targetId,
      browserContextId,
      allowConversationMetadataError,
    });
    await page.init();
    if (localStorageSeed && typeof localStorageSeed === 'object') {
      await page.seedLocalStorage(localStorageSeed);
    }
    this.#pages.add(page);
    return page;
  }

  async _evaluateInOopif(browserContextId, expression) {
    const { targetInfos } = await this.#browserConn.send('Target.getTargets');
    const iframeTarget = (targetInfos || []).find(
      (t) => t.browserContextId === browserContextId && (t.type === 'iframe' || t.url === 'about:srcdoc')
    );
    if (!iframeTarget) {
      throw new Error(`No OOPIF iframe target found for browserContextId=${browserContextId}`);
    }
    const { sessionId } = await this.#browserConn.send('Target.attachToTarget', {
      targetId: iframeTarget.targetId,
      flatten: true,
    });
    try {
      await this.#browserConn.send('Runtime.enable', {}, 5000, sessionId);
      const res = await this.#browserConn.send(
        'Runtime.evaluate',
        { expression, returnByValue: true, awaitPromise: true },
        10000,
        sessionId
      );
      if (res.exceptionDetails) {
        throw new Error(`OOPIF evaluate failed: ${res.exceptionDetails.exception?.description || res.exceptionDetails.text}`);
      }
      return res.result?.value;
    } finally {
      try {
        await this.#browserConn.send('Target.detachFromTarget', { sessionId }, 3000);
      } catch {
        // ignore
      }
    }
  }

  async _disposePage(targetId, browserContextId) {
    try {
      await this.#browserConn?.send('Target.closeTarget', { targetId });
    } catch {
      // ignore
    }
    try {
      await this.#browserConn?.send('Target.disposeBrowserContext', { browserContextId });
    } catch {
      // ignore
    }
  }

  async close() {
    for (const p of [...this.#pages]) {
      try {
        await p.close();
      } catch {
        // ignore
      }
      this.#pages.delete(p);
    }
    try {
      await this.#browserConn?.send('Browser.close', {}, 3000);
    } catch {
      // ignore
    }
    try {
      this.#browserConn?.close();
    } catch {
      // ignore
    }
    if (this.#proc && this.#proc.exitCode === null) {
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, 1500);
        this.#proc.once('exit', () => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
    killProcessTree(this.#proc);
    if (this.#profileDir) {
      rmDirWithRetry(this.#profileDir);
      this.#profileDir = null;
    }
  }
}
