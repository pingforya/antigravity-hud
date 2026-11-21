import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { CdpBrowser } from './cdp-browser.mjs';
import { SidecarHarness, DEFAULT_SIDECAR_DIR } from './sidecar-harness.mjs';
import { MockLlmServer } from './mock-llm.mjs';
import {
  buildBasicSwarm,
  buildRichOverviewSwarm,
  buildRemoteSwarm,
} from './fixtures.mjs';
import {
  assertHasChinese,
  assertEveryHasChinese,
  assertTranslatedFrom,
  assertNoUntranslatedUiStrings,
  assertLiteralsPreserved,
  assertSnapshotContract,
  getLangModeState,
  assertLangModeAbsent,
  hasChinese,
} from './assertions.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const CLI_PATH = path.join(REPO_ROOT, 'cli.js');

describe('Tier 5 — Adversarial Bug Remediation & Coverage Hardening', () => {
  let browser;
  let llm;

  before(async () => {
    browser = await CdpBrowser.launch();
    llm = new MockLlmServer();
    await llm.start();
  });

  after(async () => {
    await llm?.close();
    await browser?.close();
  });

  function llmEnv(extra = {}) {
    return {
      AGY_SWARM_TRANSLATE_BASE_URL: llm.baseUrl,
      AGY_SWARM_TRANSLATE_API_KEY: 'mock-key',
      AGY_SWARM_TRANSLATE_MODEL: 'mock-zh-model',
      ...extra,
    };
  }

  it('5.1 F11 E2E: CLI verify -> patch -> SidecarHarness + CDP Chinese UI -> restore (isolated tmp copy)', async (t) => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-e2e-f11-'));
    const tmpTarget = path.join(tmpRoot, 'swarm_board');
    const tmpBak = path.join(tmpRoot, 'backup');
    t.after(() => fs.rmSync(tmpRoot, { recursive: true, force: true }));

    fs.mkdirSync(tmpTarget, { recursive: true });
    for (const roFile of ['channels.mjs', 'hive.css', 'sidecar.json']) {
      const src = path.join(DEFAULT_SIDECAR_DIR, roFile);
      if (fs.existsSync(src)) fs.copyFileSync(src, path.join(tmpTarget, roFile));
    }
    for (const stub of ['main.mjs', 'index.html', 'app.js', 'hive.js', 'narrator_bootstrap.js', 'styles.css']) {
      fs.writeFileSync(path.join(tmpTarget, stub), `/* upstream stub ${stub} */\n`, 'utf-8');
    }

    const vBefore = spawnSync(
      process.execPath,
      [CLI_PATH, 'verify-swarm', '--target', tmpTarget, '--backup-dir', tmpBak, '--json'],
      { encoding: 'utf8' }
    );
    assert.equal(vBefore.status, 2);
    assert.equal(JSON.parse(vBefore.stdout).status, 'unpatched');

    const pRes = spawnSync(
      process.execPath,
      [CLI_PATH, 'patch-swarm', '--target', tmpTarget, '--backup-dir', tmpBak, '--json'],
      { encoding: 'utf8' }
    );
    assert.equal(pRes.status, 0, pRes.stderr);
    const pDoc = JSON.parse(pRes.stdout);
    assert.equal(pDoc.status, 'patched');
    assert.equal(pDoc.backupCreated, true);

    llm.resetStats();
    llm.setMode('ok', { delayMs: 0 });
    const harness = new SidecarHarness({ sidecarDir: tmpTarget, env: llmEnv() });
    buildBasicSwarm(harness);
    await harness.start();
    try {
      const snap = await harness.waitForSwarm(
        (s) => s.messages?.length >= 3 && s.messages.every((m) => hasChinese(m.text_zh)),
        { timeout: 10000 }
      );
      assertSnapshotContract(snap);

      const page = await browser.newIsolatedPage();
      try {
        await page.navigate(`${harness.baseUrl}/?tab=feed`);
        await page.waitForSwarmReady();
        const bodies = await page.getAllText('[data-testid="swarm-message"] .msg-body');
        assertEveryHasChinese(bodies, '5.1 F11 patched sidecar feed');
        page.assertNoErrors('5.1 F11');
      } finally {
        await page.close();
      }
    } finally {
      await harness.stop();
    }

    const rRes = spawnSync(
      process.execPath,
      [CLI_PATH, 'restore-swarm', '--target', tmpTarget, '--backup-dir', tmpBak, '--json'],
      { encoding: 'utf8' }
    );
    assert.equal(rRes.status, 0, rRes.stderr);
    assert.equal(JSON.parse(rRes.stdout).status, 'restored');
    assert.equal(fs.existsSync(path.join(tmpTarget, 'translator.mjs')), false);

    const vAfter = spawnSync(
      process.execPath,
      [CLI_PATH, 'verify-swarm', '--target', tmpTarget, '--backup-dir', tmpBak, '--json'],
      { encoding: 'utf8' }
    );
    assert.equal(vAfter.status, 2);
    assert.equal(JSON.parse(vAfter.stdout).status, 'unpatched');
  });

  it('5.2 Bug 1 E2E: /api/swarm bumps etag on 500 failure (Tier-1 partial) and auto-recovers after cooldown expiry', async (t) => {
    llm.resetStats();
    llm.setMode('500', { delayMs: 0 });
    const harness = new SidecarHarness({
      env: llmEnv({
        AGY_SWARM_TRANSLATE_BACKOFF_MS: '15',
        AGY_SWARM_TRANSLATE_COOLDOWN_MS: '300',
      }),
    });
    t.after(() => harness.stop());
    buildBasicSwarm(harness, {
      messages: [
        { seq: 1, agent: 'backend', time: '2026-11-19 14:00:00', text: '@coordinator [done] Please verify this critical report now.' },
      ],
    });
    await harness.start();

    const p1 = await harness.getSwarm('');
    assert.ok(p1.translationState.pending >= 1);
    assert.equal(p1.messages[0].text_zh_pending, true);
    assert.equal(p1.messages[0].text_zh, null);

    // Must NOT remain stuck on unchanged: true after retries fail
    const p2 = await harness.waitForSwarm(
      (s) => !s.unchanged && s.translationState?.pending === 0 && s.translationState?.failed >= 1,
      { timeout: 5000 }
    );
    const p2Poll = await harness.getSwarm(p1.etag);
    assert.notEqual(p2Poll.unchanged, true, 'etag must bump after failure');
    assert.notEqual(p2Poll.etag, p1.etag, 'etag value must change after failure');
    assert.ok(p2.messages[0].text_zh.startsWith('@coordinator [已完成]'), `Expected Tier-1 partial, got: ${p2.messages[0].text_zh}`);

    // Browser sees Tier-1 partial during outage, then live LLM translation after cooldown expires
    const page = await browser.newIsolatedPage();
    t.after(() => page.close());
    await page.navigate(`${harness.baseUrl}/?tab=feed`);
    await page.waitForSwarmReady();
    const outageBody = await page.getText('[data-testid="swarm-message"] .msg-body');
    assert.ok(outageBody.includes('[已完成]'), `Expected Tier-1 tag in browser during outage, got: ${outageBody}`);

    llm.setMode('ok', { delayMs: 0 });
    await page.waitForFunction(
      () => {
        const txt = document.querySelector('[data-testid="swarm-message"] .msg-body')?.textContent || '';
        return txt.includes('[已完成]') && !txt.includes('Please verify');
      },
      [],
      { timeout: 8000 }
    );
    page.assertNoErrors('5.2');
  });

  it('5.3 Bug 2 E2E: CJK-adjacent Windows/POSIX/UNC paths, bare filenames & bare drive root mask cleanly', async (t) => {
    llm.resetStats();
    llm.setMode('ok', { delayMs: 0 });
    const harness = new SidecarHarness({ env: llmEnv() });
    t.after(() => harness.stop());
    const samples = [
      '查看src\\app.js文件 and verify logic.',
      '访问\\\\server\\share\\file.txt文件 for details.',
      '请检查C:\\repo\\main.mjs文件 before running integration checks.',
      '查看/api/swarm接口 and check status.',
      '修改app.js并测试 before merging.',
      'Check C:\\ directory immediately.',
    ];
    buildBasicSwarm(harness, {
      messages: samples.map((text, idx) => ({
        seq: idx + 1,
        agent: 'backend',
        time: `2026-11-19 14:0${idx}:00`,
        text,
      })),
    });
    await harness.start();

    await harness.waitForSwarm(
      (s) => s.messages?.length === samples.length && s.messages.every((m) => m.text_zh_source === 'llm'),
      { timeout: 10000 }
    );

    // Ensure mock-llm prompts had masked ⟦P0⟧ WITHOUT swallowing adjacent Chinese
    const prompts = llm.requests.map((r) => r.promptText);
    assert.ok(prompts.some((p) => p.includes('查看⟦P0⟧文件')), `Expected 查看⟦P0⟧文件 in prompts: ${JSON.stringify(prompts)}`);
    assert.ok(prompts.some((p) => p.includes('访问⟦P0⟧文件')), `Expected 访问⟦P0⟧文件 in prompts`);
    assert.ok(prompts.some((p) => p.includes('请检查⟦P0⟧文件')), `Expected 请检查⟦P0⟧文件 in prompts`);
    assert.ok(prompts.some((p) => p.includes('查看⟦P0⟧接口')), `Expected 查看⟦P0⟧接口 in prompts`);
    assert.ok(prompts.some((p) => p.includes('修改⟦P0⟧并测试')), `Expected 修改⟦P0⟧并测试 in prompts`);

    const page = await browser.newIsolatedPage();
    t.after(() => page.close());
    await page.navigate(`${harness.baseUrl}/?tab=feed`);
    await page.waitForSwarmReady();
    const bodies = await page.getAllText('[data-testid="swarm-message"] .msg-body');
    assertLiteralsPreserved(bodies[0], ['src\\app.js'], '5.3 win rel');
    assertLiteralsPreserved(bodies[1], ['\\\\server\\share\\file.txt'], '5.3 win unc');
    assertLiteralsPreserved(bodies[2], ['C:\\repo\\main.mjs'], '5.3 win drive');
    assertLiteralsPreserved(bodies[3], ['/api/swarm'], '5.3 posix abs');
    assertLiteralsPreserved(bodies[4], ['app.js'], '5.3 bare file');
    assertLiteralsPreserved(bodies[5], ['C:\\'], '5.3 bare drive root');
    page.assertNoErrors('5.3');
  });

  it('5.4 Bugs 7-9 + Overview lastGood / stale / paused(quota) in real Chromium', async (t) => {
    llm.resetStats();
    llm.setMode('ok', { delayMs: 0 });
    const harness = new SidecarHarness({ overview: false, env: llmEnv() });
    t.after(() => harness.stop());
    const { convId, workerConv } = buildRichOverviewSwarm(harness, {
      includeNarrator: true,
      includeHtml: true,
      includeReel: true,
    });
    // Add prototype-named members + extra posts so narrator lags behind head
    const membersData = JSON.parse(fs.readFileSync(path.join(harness.swarmDir(convId), 'members.json'), 'utf-8'));
    membersData.members.toString = {
      conversation_id: '55555555-5555-4555-8555-555555555555',
      role: 'worker',
      wake_mode: 'mentions',
      killed: false,
    };
    membersData.members.constructor = {
      conversation_id: '66666666-6666-4666-8666-666666666666',
      role: 'worker',
      wake_mode: 'mentions',
      killed: false,
    };
    const narConv = membersData.members.narrator.conversation_id;
    membersData.members.narrator.last_read_seq = 1;
    fs.writeFileSync(path.join(harness.swarmDir(convId), 'members.json'), JSON.stringify(membersData, null, 2), 'utf-8');

    // Make view.json as_of_seq=1 and board head=15 -> lag = 14 >= STALE_LAG (10)
    const viewPath = path.join(harness.swarmDir(convId), 'view.json');
    const viewObj = JSON.parse(fs.readFileSync(viewPath, 'utf-8'));
    viewObj.as_of_seq = 1;
    fs.writeFileSync(viewPath, JSON.stringify(viewObj, null, 2), 'utf-8');
    for (let s = 7; s <= 15; s++) {
      harness.appendBoardLine(convId, {
        seq: s,
        agent: s % 2 === 0 ? 'toString' : 'constructor',
        time: `2026-11-19 15:${String(s).padStart(2, '0')}:00`,
        text: `Prototype member status update ${s}.`,
      });
    }
    // Narrator transcript with 429 quota error -> paused: quota badge
    harness.writeTranscript(narConv, [
      { step_index: 1, source: 'SYSTEM', type: 'ERROR_MESSAGE', status: 'DONE', error: '429 RESOURCE_EXHAUSTED quota' },
    ]);
    await harness.start();

    await harness.waitForSwarm((s) => !!s.view_zh && s.narratorState === 'paused', { timeout: 10000 });
    const page = await browser.newIsolatedPage();
    t.after(() => page.close());
    await page.navigate(`${harness.baseUrl}/?narrator=frame&tab=overview`);
    await page.waitForSwarmReady();

    // Check paused: quota badge & stale badge
    await page.waitForSelector('[data-testid="swarm-overview-badge"]', { visible: true });
    assert.equal(await page.getText('[data-testid="swarm-overview-badge"]'), '已暂停：配额不足');
    await page.waitForSelector('[data-testid="swarm-overview-stale"]', { visible: true });
    assert.equal(await page.getText('[data-testid="swarm-overview-stale"]'), '未及时更新');

    // Check narrator iframe 💬 feedbackIntent button localized title/aria-label
    await page.waitForSelector('[data-testid="swarm-overview-iframe"]');
    let fbInfo = null;
    const deadline = Date.now() + 6000;
    while (Date.now() < deadline) {
      try {
        fbInfo = await page.evaluateInFrame('#ov-frame iframe.ov-iframe', () => {
          const attBox = document.getElementById('narrator-att');
          if (!attBox) return null;
          attBox.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
          const btn = [...document.querySelectorAll('button')].find((b) => b.textContent === '💬');
          return btn ? { title: btn.title, ariaLabel: btn.getAttribute('aria-label') } : null;
        });
        if (fbInfo) break;
      } catch {
        // initializing
      }
      await new Promise((r) => setTimeout(r, 80));
    }
    assert.deepEqual(fbInfo, { title: '对此项提供反馈', ariaLabel: '对此项提供反馈' });

    // Overwrite view.json with corrupt JSON -> lastGood notice
    harness.writeViewJson(convId, '{corrupt-view-json');
    await page.waitForFunction(
      () => (document.querySelector('[data-testid="swarm-overview-notice"]')?.textContent || '').includes('上次有效的 view.json'),
      [],
      { timeout: 6000 }
    );
    const noticeInvalid = await page.getText('[data-testid="swarm-overview-notice"]');
    assert.equal(noticeInvalid, '正在显示上次有效的 view.json；当前文件不是有效的 JSON。');

    // Overwrite view.json with >64KB -> lastGood >64KB notice
    harness.writeViewJson(convId, JSON.stringify({ version: 1, headline: 'x'.repeat(66000) }));
    await page.waitForFunction(
      () => (document.querySelector('[data-testid="swarm-overview-notice"]')?.textContent || '').includes('超过 64 KB'),
      [],
      { timeout: 6000 }
    );
    const noticeLarge = await page.getText('[data-testid="swarm-overview-notice"]');
    assert.equal(noticeLarge, '正在显示上次有效的 view.json；当前文件超过 64 KB。');

    // Switch to Board and verify toString / constructor member avatars do NOT emit #NaNNaNNaN
    await page.click('[data-testid="swarm-tab-feed"]');
    await page.waitForSelector('[data-testid="swarm-message"] .msg-av', { visible: true });
    const avStyles = await page.evaluate(() => [...document.querySelectorAll('.msg-av')].map((el) => el.getAttribute('style') || ''));
    assert.ok(avStyles.length >= 2);
    assert.equal(avStyles.some((s) => s.includes('NaN')), false, `Found NaN color in .msg-av style: ${JSON.stringify(avStyles)}`);
    page.assertNoErrors('5.4');
  });

  it('5.5 Browser UX gaps: measureClamps short vs long post, clean header without #lang-mode, #replay-caption Chinese, and remote openConversation toast', async (t) => {
    llm.resetStats();
    llm.setMode('ok', { delayMs: 0 });
    const harness = new SidecarHarness({ useTempSidecarCopy: true, env: llmEnv() });
    t.after(() => harness.stop());
    buildRemoteSwarm(harness);

    // Test short unclamped post + long clamped/expandable post on a local swarm first
    const borderHarness = new SidecarHarness({ env: llmEnv() });
    t.after(() => borderHarness.stop());
    const shortText = [
      'Paragraph one: short verification line for height check.',
      'Paragraph two: second line keeps height inside clamp.',
    ].join('\n\n');
    const longText = Array.from({ length: 8 }, (_, i) => `Paragraph ${i + 1}: long verification line that overflows the five-line fold clamp cleanly.`).join('\n\n');
    buildBasicSwarm(borderHarness, {
      messages: [
        { seq: 1, agent: 'coordinator', time: '2026-11-19 14:00:00', text: '@backend Check #1.' },
        { seq: 2, agent: 'backend', time: '2026-11-19 14:01:00', text: shortText },
        { seq: 3, agent: 'backend', time: '2026-11-19 14:02:00', text: longText },
      ],
    });
    await borderHarness.start();
    await borderHarness.waitForSwarm((s) => s.messages?.every((m) => hasChinese(m.text_zh)), { timeout: 8000 });

    const page = await browser.newIsolatedPage();
    t.after(() => page.close());
    await page.navigate(`${borderHarness.baseUrl}/?tab=feed`);
    await page.waitForSwarmReady();

    assertLangModeAbsent(await getLangModeState(page), '5.5 header');
    const clampState = await page.evaluate(() => {
      const m2 = document.querySelector('[data-seq="2"]');
      const m3 = document.querySelector('[data-seq="3"]');
      return {
        m2Clamped: m2?.querySelector('.msg-body')?.classList.contains('clamped'),
        m2MoreHidden: m2?.querySelector('.msg-more')?.classList.contains('hidden'),
        m3Clamped: m3?.querySelector('.msg-body')?.classList.contains('clamped'),
        m3MoreHidden: m3?.querySelector('.msg-more')?.classList.contains('hidden'),
      };
    });
    assert.equal(clampState.m2Clamped, false);
    assert.equal(clampState.m2MoreHidden, true);
    assert.equal(clampState.m3Clamped, true, 'Long post should clamp cleanly');
    assert.equal(clampState.m3MoreHidden, false, '.msg-more must appear on long post');

    // #replay-caption renders clean Chinese without .msg-orig
    await page.click('[data-testid="swarm-tab-graph"]');
    await page.click('#replay-start');
    await page.click('#replay-fwd');
    await page.click('#replay-fwd');
    await page.waitForSelector('#replay-caption:not(.hidden)', { visible: true });
    const repText = await page.getText('#replay-caption .msg-body');
    assertHasChinese(repText, '5.5 #replay-caption Chinese');
    assert.equal(await page.evaluate(() => document.querySelectorAll('#replay-caption .msg-orig').length), 0);
    page.assertNoErrors('5.5a');

    // Remote member click in Members/Graph triggers Chinese toast
    await harness.start();
    await harness.waitForSwarm((s) => s?.source && s.members?.length >= 2, { timeout: 8000 });
    const remotePage = await browser.newIsolatedPage();
    t.after(() => remotePage.close());
    await remotePage.navigate(`${harness.baseUrl}/?tab=members`);
    await remotePage.waitForSwarmReady();
    // Simulate host conversation opener returning false? No, standalone has no window.sidecar.openConversation;
    // inject a fake openConversation-capable host or test when remote member is clicked on Graph/Members:
    // Note: app.js:456 shows toast when m.local === false && canOpenConversation().
    await remotePage.evaluate(() => {
      window.sidecar = Object.assign(window.sidecar || {}, { ui: { toggleConversation() {} } });
    });
    await remotePage.click('#members [data-open-member="builder"]');
    await remotePage.waitForFunction(
      () => {
        const tEl = document.getElementById('toast');
        return tEl && !tEl.classList.contains('hidden') && (tEl.textContent || '').trim().length > 0;
      },
      [],
      { timeout: 4000 }
    );
    const toastTxt = await remotePage.getText('#toast');
    assertHasChinese(toastTxt, 'remote openConversation toast');
    assert.ok(toastTxt.includes('请在对应设备中打开'), `Unexpected remote toast: ${toastTxt}`);
    remotePage.assertNoErrors('5.5b');
  });

  it('5.6 assertions.mjs anti-bypass self-tests: rejects trivial prefixes, lowercased/embedded English clauses, and accepts mixed-CJK rephrasings', () => {
    const fakes = [
      ['自动翻译结果如下：Check config.json', 'Check config.json'],
      ['[译] Check config.json', 'Check config.json'],
      ['自动翻译结果如下：Waiting on @backend', 'Waiting on @backend'],
      ['自动翻译结果如下：All completed', 'All completed'],
      ['【译文】All completed', 'All completed'],
      // Gap 1: dash/colon prefixes, fullwidth （...）, and case-insensitive 1-2 word verbatim checks
      ['系统提示 - check config.json', 'Check config.json'],
      ['结果 - waiting on @backend', 'Waiting on @backend'],
      ['（译）run CI and QA', 'Run CI and QA'],
      // Gap 2: 2/3-word verbatim retention around CJK/backticks and >=10-char embedded 3-word English clause
      ['Check `app.js` 和 `main.mjs` now', 'Check `app.js` and `main.mjs` now'],
      ['请检查 status 与 progress', 'Check status and progress'],
      ['请查看：Fix bug now 并在本地验证完成所有流程', 'Run the build and test suite then Fix bug now'],
    ];
    for (const [fakeAct, orig] of fakes) {
      assert.throws(
        () => assertTranslatedFrom(fakeAct, orig, 'anti-bypass'),
        /AssertionError/,
        `Expected assertTranslatedFrom to reject fake: ${fakeAct}`
      );
    }

    // Legitimate short translations & mixed-CJK rephrasings (Gap 3) still pass
    assertTranslatedFrom('恢复运行', 'resume', 'legit 1-word');
    assertTranslatedFrom('检查 config.json', 'Check config.json', 'legit with filename');
    assertTranslatedFrom('等待 @backend', 'Waiting on @backend', 'legit with mention');
    assertTranslatedFrom('全部已完成', 'All completed', 'legit 2-word');
    assertTranslatedFrom('检查 HTTP 状态', 'Check HTTP status', 'legit with acronym');
    assertTranslatedFrom('请核查 sidecar 状态', '请检查 sidecar 的状态', 'legit mixed-CJK concise rephrasing');
    assertTranslatedFrom('核查 status', '检查 status', 'legit mixed-CJK equal-length rephrasing');
  });
});
