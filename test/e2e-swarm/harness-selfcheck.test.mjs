import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { CdpBrowser } from './cdp-browser.mjs';
import { SidecarHarness } from './sidecar-harness.mjs';
import { MockLlmServer } from './mock-llm.mjs';
import {
  REAL_BRAIN_DIR,
  SWARM_56F8,
  SWARM_E0DA,
  MINIMAL_PNG,
  copyRealSwarm,
  buildBasicSwarm,
  buildRichOverviewSwarm,
  buildScreenshotSwarm,
  buildRemoteSwarm,
} from './fixtures.mjs';
import { assertSnapshotContract } from './assertions.mjs';

function sha256File(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function readRealSwarmBaseline(swarmId) {
  const swarmDir = path.join(REAL_BRAIN_DIR, swarmId, '.system_generated', 'swarm');
  const boardPath = path.join(swarmDir, 'board.jsonl');
  const membersPath = path.join(swarmDir, 'members.json');
  const boardBuf = fs.readFileSync(boardPath);
  const membersBuf = fs.readFileSync(membersPath);
  const boardStat = fs.statSync(boardPath);
  const membersStat = fs.statSync(membersPath);
  const expectedMessages = boardBuf
    .toString('utf-8')
    .split(/\r?\n/)
    .filter((line) => {
      if (!line.trim()) return false;
      try {
        JSON.parse(line);
        return true;
      } catch {
        return false;
      }
    }).length;
  const parsedMembers = JSON.parse(membersBuf.toString('utf-8'));
  const expectedMembers = Object.keys(parsedMembers.members || {}).length;
  return {
    boardPath,
    membersPath,
    boardSize: boardStat.size,
    boardMtimeMs: boardStat.mtimeMs,
    boardSha256: crypto.createHash('sha256').update(boardBuf).digest('hex'),
    membersSize: membersStat.size,
    membersMtimeMs: membersStat.mtimeMs,
    membersSha256: crypto.createHash('sha256').update(membersBuf).digest('hex'),
    expectedMessages,
    expectedMembers,
  };
}

describe('E2E Harness Self-Check', () => {
  let browser;

  before(async () => {
    browser = await CdpBrowser.launch();
  });

  after(async () => {
    await browser?.close();
  });

  it('1. Isolates SidecarHarness from real brain/ directory', async (t) => {
    const harness = new SidecarHarness({ conversationId: SWARM_56F8 });
    t.after(() => harness.stop());
    await harness.start();

    assert.ok(harness.port > 0, 'Expected ephemeral port > 0');
    assert.ok(!harness.stdoutLogs.includes(REAL_BRAIN_DIR), 'Sidecar must never scan real brain dir');

    const s1 = await harness.getSwarm({ conversationId: SWARM_56F8 });
    assert.equal(s1.swarm, null, 'Unpopulated isolated harness must return swarm: null for 56f8');

    const s2 = await harness.getSwarm({ conversationId: SWARM_E0DA });
    assert.equal(s2.swarm, null, 'Unpopulated isolated harness must return swarm: null for e0da');
  });

  it('2. Copies real swarms 56f8c44e and e0dad013 read-only without mutating real disk', async (t) => {
    const base56 = readRealSwarmBaseline(SWARM_56F8);
    const baseE0 = readRealSwarmBaseline(SWARM_E0DA);
    assert.ok(base56.expectedMessages >= 49, `Expected >= 49 messages in 56f8, got ${base56.expectedMessages}`);
    assert.ok(base56.expectedMembers >= 20, `Expected >= 20 members in 56f8, got ${base56.expectedMembers}`);
    assert.ok(baseE0.expectedMessages >= 55, `Expected >= 55 messages in e0da, got ${baseE0.expectedMessages}`);
    assert.ok(baseE0.expectedMembers >= 7, `Expected >= 7 members in e0da, got ${baseE0.expectedMembers}`);

    const harness = new SidecarHarness({ conversationId: SWARM_56F8 });
    t.after(() => harness.stop());
    copyRealSwarm(harness, SWARM_56F8);
    copyRealSwarm(harness, SWARM_E0DA);
    await harness.start();

    // Verify 1:1 copy parity on disk inside isolated harness brainDir
    assert.equal(sha256File(path.join(harness.swarmDir(SWARM_56F8), 'board.jsonl')), base56.boardSha256);
    assert.equal(sha256File(path.join(harness.swarmDir(SWARM_56F8), 'members.json')), base56.membersSha256);
    assert.equal(sha256File(path.join(harness.swarmDir(SWARM_E0DA), 'board.jsonl')), baseE0.boardSha256);
    assert.equal(sha256File(path.join(harness.swarmDir(SWARM_E0DA), 'members.json')), baseE0.membersSha256);

    const snap56 = await harness.getSwarm({ conversationId: SWARM_56F8 });
    assertSnapshotContract(snap56);
    assert.equal(snap56.messages.length, base56.expectedMessages);
    assert.equal(snap56.members.length, base56.expectedMembers);

    const snapE0 = await harness.getSwarm({ conversationId: SWARM_E0DA });
    assertSnapshotContract(snapE0);
    assert.equal(snapE0.messages.length, baseE0.expectedMessages);
    assert.equal(snapE0.members.length, baseE0.expectedMembers);

    // Verify real disk source files (board.jsonl & members.json) were not mutated
    for (const [label, b] of [['56f8', base56], ['e0da', baseE0]]) {
      const boardAfter = fs.statSync(b.boardPath);
      const membersAfter = fs.statSync(b.membersPath);
      assert.equal(boardAfter.size, b.boardSize, `${label} board.jsonl size changed`);
      assert.equal(boardAfter.mtimeMs, b.boardMtimeMs, `${label} board.jsonl mtime changed`);
      assert.equal(sha256File(b.boardPath), b.boardSha256, `${label} board.jsonl SHA-256 changed`);
      assert.equal(membersAfter.size, b.membersSize, `${label} members.json size changed`);
      assert.equal(membersAfter.mtimeMs, b.membersMtimeMs, `${label} members.json mtime changed`);
      assert.equal(sha256File(b.membersPath), b.membersSha256, `${label} members.json SHA-256 changed`);
    }
  });

  it('3. MockLlmServer handles ok, tokens, concurrency telemetry, delay, 429, 500, and drop-placeholder', async (t) => {
    const llm = new MockLlmServer();
    t.after(() => llm.close());
    await llm.start();

    // OK mode preserving ⟦Pn⟧ tokens
    const res1 = await fetch(`${llm.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'mock',
        messages: [{ role: 'user', content: '⟦P0⟧ Please run ⟦P1⟧ check' }],
      }),
    });
    assert.equal(res1.status, 200);
    const j1 = await res1.json();
    const content1 = j1.choices[0].message.content;
    assert.match(content1, /[\u4e00-\u9fff]/);
    assert.ok(content1.includes('⟦P0⟧') && content1.includes('⟦P1⟧'));

    // Delay + concurrency telemetry
    llm.resetStats();
    llm.setMode('ok', { delayMs: 80 });
    await Promise.all([
      fetch(`${llm.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages: [{ role: 'user', content: 'Tests passed' }] }),
      }),
      fetch(`${llm.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages: [{ role: 'user', content: 'Waiting for posts' }] }),
      }),
    ]);
    assert.equal(llm.requests.length, 2);
    assert.equal(llm.maxConcurrent, 2);

    // failFirstN (429 then 200)
    llm.resetStats();
    llm.setMode('ok', { delayMs: 0, failFirstN: 1, failMode: '429' });
    const r429 = await fetch(`${llm.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages: [{ role: 'user', content: 'hello' }] }),
    });
    assert.equal(r429.status, 429);
    const rOk = await fetch(`${llm.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages: [{ role: 'user', content: 'hello' }] }),
    });
    assert.equal(rOk.status, 200);

    // 500 mode
    llm.setMode('500');
    const r500 = await fetch(`${llm.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages: [{ role: 'user', content: 'hello' }] }),
    });
    assert.equal(r500.status, 500);

    // Drop-placeholder mode
    llm.setMode('drop-placeholder');
    const rDrop = await fetch(`${llm.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages: [{ role: 'user', content: 'Check ⟦P0⟧ now' }] }),
    });
    const jDrop = await rDrop.json();
    assert.ok(!jDrop.choices[0].message.content.includes('⟦P0⟧'));
  });

  it('4. Headless CDP BrowserContext isolates localStorage across pages', async (t) => {
    const harness = new SidecarHarness();
    t.after(() => harness.stop());
    buildBasicSwarm(harness);
    await harness.start();

    const p1 = await browser.newIsolatedPage({ localStorageSeed: { 'swarm.langMode': 'en' } });
    t.after(() => p1.close());
    await p1.navigate(harness.baseUrl);
    await p1.waitForSwarmReady();
    assert.equal(await p1.getLocalStorage('swarm.langMode'), 'en');

    const p2 = await browser.newIsolatedPage();
    t.after(() => p2.close());
    await p2.navigate(harness.baseUrl);
    await p2.waitForSwarmReady();
    const p2Val = await p2.getLocalStorage('swarm.langMode');
    assert.notEqual(p2Val, 'en', 'Isolated BrowserContext must not inherit localStorage from p1');
  });

  it('5. Renders Board, Members, Graph, and Raw tabs with zero console errors or exceptions', async (t) => {
    const harness = new SidecarHarness();
    t.after(() => harness.stop());
    buildBasicSwarm(harness);
    await harness.start();

    const page = await browser.newIsolatedPage();
    t.after(() => page.close());
    await page.navigate(harness.baseUrl);
    await page.waitForSwarmReady();
    await page.click('[data-testid="swarm-tab-feed"]');
    await page.waitForSelector('[data-testid="swarm-message"]', { visible: true });

    const msgCount = await page.evaluate(() => document.querySelectorAll('[data-testid="swarm-message"]').length);
    assert.equal(msgCount, 3);

    await page.click('[data-testid="swarm-tab-members"]');
    await page.waitForSelector('#members .o2-mrow', { visible: true });

    await page.click('[data-testid="swarm-tab-graph"]');
    await page.waitForSelector('[data-testid="swarm-graph"] g.node', { visible: true });

    await page.click('[data-testid="swarm-tab-raw"]');
    await page.waitForSelector('[data-testid="swarm-raw"]', { visible: true });

    page.assertNoErrors('selfcheck basic tabs');
  });

  it('6. Serves Screenshot: frames via /api/frame on Windows with POSIX path & matching cwd drive', async (t) => {
    const harness = new SidecarHarness();
    t.after(() => harness.stop());
    const { convId, s1 } = buildScreenshotSwarm(harness);
    await harness.start();

    const res = await harness.getFrame({ conversationId: convId, path: s1.posixPath, seq: 2 });
    assert.equal(res.status, 200, `Expected 200 for /api/frame path=${s1.posixPath}`);
    assert.equal(res.headers.get('content-type'), 'image/png');
    const buf = Buffer.from(await res.arrayBuffer());
    assert.deepEqual(buf, MINIMAL_PNG);
  });

  it('7. Remote board mock CLI via temp sidecar copy renders [data-testid="swarm-source"]', async (t) => {
    const harness = new SidecarHarness({ useTempSidecarCopy: true });
    t.after(() => harness.stop());
    buildRemoteSwarm(harness);
    await harness.start();

    const snap = await harness.waitForSwarm((s) => s && s.source && s.members && s.members.length >= 2, { timeout: 8000 });
    assert.equal(snap.source.kind, 'remote');
    assert.equal(snap.source.state, 'live');

    const page = await browser.newIsolatedPage();
    t.after(() => page.close());
    await page.navigate(harness.baseUrl);
    await page.waitForSwarmReady();
    await page.click('[data-testid="swarm-tab-members"]');
    await page.waitForSelector('[data-testid="swarm-source"]', { visible: true });
    const srcText = await page.getText('[data-testid="swarm-source"]');
    assert.ok(srcText && srcText.includes('Fleet'), `Expected Fleet source banner, got: ${srcText}`);
    page.assertNoErrors('selfcheck remote board');
  });

  it('8. Evaluates inside sandboxed #ov-frame narrator iframe', async (t) => {
    const harness = new SidecarHarness({ overview: false });
    t.after(() => harness.stop());
    buildRichOverviewSwarm(harness, { includeNarrator: true, includeHtml: true });
    await harness.start();

    const page = await browser.newIsolatedPage();
    t.after(() => page.close());
    await page.navigate(`${harness.baseUrl}/?narrator=frame`);
    await page.waitForSwarmReady();
    await page.waitForSelector('[data-testid="swarm-overview-iframe"]');

    await page.waitForFunction(() => {
      const fr = document.querySelector('#ov-frame iframe.ov-iframe');
      return !!fr;
    });

    // Wait for narrator_bootstrap READY + RENDERED to populate #narrator-headline inside iframe
    let headline = '';
    const deadline = Date.now() + 6000;
    while (Date.now() < deadline) {
      try {
        headline = await page.evaluateInFrame('#ov-frame iframe.ov-iframe', () => {
          return document.getElementById('narrator-headline')?.textContent || '';
        });
        if (headline && headline !== 'Loading view...') break;
      } catch {
        // frame context still initializing
      }
      await new Promise((r) => setTimeout(r, 80));
    }
    assert.ok(headline && headline !== 'Loading view...', `Expected rendered narrator iframe headline, got: ${headline}`);
    page.assertNoErrors('selfcheck narrator iframe');
  });
});
