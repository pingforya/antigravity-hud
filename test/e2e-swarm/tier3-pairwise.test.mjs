import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';

import { CdpBrowser } from './cdp-browser.mjs';
import { SidecarHarness } from './sidecar-harness.mjs';
import { MockLlmServer } from './mock-llm.mjs';
import {
  SWARM_56F8,
  copyRealSwarm,
  buildBasicSwarm,
  buildRichOverviewSwarm,
  buildPlanAndChannelsSwarm,
  buildSystemAlertsSwarm,
  buildScreenshotSwarm,
  buildRemoteSwarm,
} from './fixtures.mjs';
import {
  assertHasChinese,
  assertEveryHasChinese,
  assertTranslatedFrom,
  assertLiteralsPreserved,
  getLangModeState,
  assertLangModeAbsent,
  hasChinese,
} from './assertions.mjs';

describe('Tier 3 — Cross-Feature Pairwise Combinations (>= 14 tests)', () => {
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

  it('3.1 Pairwise: CN search + #f-agent poster filter + channel tab (#parser) in zh mode', async (t) => {
    llm.setMode('ok', { delayMs: 0 });
    const harness = new SidecarHarness({ env: llmEnv() });
    t.after(() => harness.stop());
    buildPlanAndChannelsSwarm(harness);
    await harness.start();

    await harness.waitForSwarm(
      (s) => {
        const m4 = s.messages?.find((m) => m.seq === 4);
        return m4 && hasChinese(m4.text_zh) && m4.text_zh.includes('待审阅');
      },
      { timeout: 8000 }
    );
    const page = await browser.newIsolatedPage();
    t.after(() => page.close());
    await page.navigate(harness.baseUrl);
    await page.waitForSwarmReady();

    await page.click('[data-testid="swarm-tab-feed"]');
    await page.click('[data-testid="swarm-channel-tab"][data-channel="parser"]');
    await page.click('[data-testid="swarm-filter-toggle"]');
    await page.selectOption('#f-agent', 'parser');
    await page.type('[data-testid="swarm-search"]', '待审阅');

    const count = await page.evaluate(() => document.querySelectorAll('[data-testid="swarm-message"]').length);
    assert.equal(count, 1);
    const body = await page.getText('[data-testid="swarm-message"] .msg-body');
    assertHasChinese(body, '3.1 filtered message');
    page.assertNoErrors('3.1');
  });

  it('3.2 Pairwise: Live board append preserves expanded .msg-more state and scroll anchor', async (t) => {
    llm.setMode('ok', { delayMs: 0 });
    const harness = new SidecarHarness({ env: llmEnv() });
    t.after(() => harness.stop());
    const longBody = Array.from({ length: 45 }, (_, i) => `Detail line ${i + 1}: verifying scroll and expand stability.`).join('\n\n');
    const msgs = Array.from({ length: 26 }, (_, i) => {
      const seq = i + 1;
      if (seq === 10) {
        return { seq, agent: 'backend', time: '2026-11-19 14:10:00', text: longBody };
      }
      return {
        seq,
        agent: seq % 2 === 0 ? 'backend' : 'coordinator',
        time: `2026-11-19 14:${String(seq).padStart(2, '0')}:00`,
        text: `Unique worker task item number ${seq} requires validation.\nSecond line for height.\nThird line for scroll.`,
      };
    });
    buildBasicSwarm(harness, { messages: msgs });
    await harness.start();

    await harness.waitForSwarm(
      (s) => s.messages?.length === 26 && s.messages.every((m) => hasChinese(m.text_zh)),
      { timeout: 15000 }
    );
    const page = await browser.newIsolatedPage();
    t.after(() => page.close());
    await page.navigate(`${harness.baseUrl}/?tab=feed`);
    await page.waitForSwarmReady();
    await page.waitForSelector('[data-seq="10"] [data-testid="swarm-message-more"]:not(.hidden)', { visible: true });

    await page.click('[data-seq="10"] [data-testid="swarm-message-more"]');
    const openBefore = await page.evaluate(() => document.querySelector('[data-seq="10"] .msg-body')?.classList.contains('open'));
    assert.equal(openBefore, true);

    // Scroll up so [data-seq="10"] is at rect.top ~ 0 (making #9's bottom < 0 so #10 is the anchor in renderFeed)
    await page.evaluate(() => {
      const el = document.querySelector('[data-seq="10"]');
      if (!el) return;
      const targetY = el.getBoundingClientRect().top + window.scrollY;
      window.scrollTo(0, Math.max(0, targetY));
    });
    await new Promise((r) => setTimeout(r, 120));

    const beforeState = await page.evaluate(() => {
      const el = document.querySelector('[data-seq="10"]');
      const firstAnchor = [...document.querySelectorAll('.msg[data-seq]')].find((m) => m.getBoundingClientRect().bottom > 0);
      return {
        scrollY: window.scrollY,
        maxScroll: document.documentElement.scrollHeight - window.innerHeight,
        anchorSeq: firstAnchor?.dataset?.seq || null,
        top: el ? el.getBoundingClientRect().top : null,
      };
    });
    assert.equal(beforeState.anchorSeq, '10', 'Expected [data-seq="10"] to be the top visible anchor');
    assert.ok(beforeState.scrollY < beforeState.maxScroll - 100, 'Page must be scrolled up away from bottom');

    // Append a live post while scrolled up and confirm expanded post stays open & scroll anchor stays pinned
    harness.appendBoardLine(harness.conversationId, {
      seq: 27,
      agent: 'backend',
      time: '2026-11-19 14:59:00',
      text: 'Live appended task item number 27 while user is reading older expanded message.',
    });
    await harness.waitForSwarm((s) => s.messages?.length === 27 && hasChinese(s.messages[26]?.text_zh), { timeout: 8000 });
    await page.waitForSelector('[data-seq="27"]', { visible: true });

    const afterAppend = await page.evaluate(() => {
      const el = document.querySelector('[data-seq="10"]');
      return {
        open: el?.querySelector('.msg-body')?.classList.contains('open'),
        top: el ? el.getBoundingClientRect().top : null,
      };
    });
    assert.equal(afterAppend.open, true, 'Expanded post must remain open across live feed updates');
    assert.ok(Math.abs(afterAppend.top - beforeState.top) <= 5, `Scroll anchor drifted across live update: before=${beforeState.top}, after=${afterAppend.top}`);
    page.assertNoErrors('3.2');
  });

  it('3.3 Pairwise: Live appendBoardLine during active bilingual search updates matching results only', async (t) => {
    llm.setMode('ok', { delayMs: 0 });
    const harness = new SidecarHarness({ env: llmEnv() });
    t.after(() => harness.stop());
    buildBasicSwarm(harness);
    await harness.start();

    await harness.waitForSwarm((s) => s.messages?.every((m) => hasChinese(m.text_zh)), { timeout: 8000 });
    const page = await browser.newIsolatedPage();
    t.after(() => page.close());
    await page.navigate(`${harness.baseUrl}/?tab=feed`);
    await page.waitForSwarmReady();

    await page.type('[data-testid="swarm-search"]', '已完成');
    const before = await page.evaluate(() => document.querySelectorAll('[data-testid="swarm-message"]').length);

    harness.appendBoardLine(harness.conversationId, {
      seq: 4,
      agent: 'backend',
      time: '2026-11-19 14:06:00',
      text: '@coordinator Phase 3 verification complete.',
    });
    harness.appendBoardLine(harness.conversationId, {
      seq: 5,
      agent: 'backend',
      time: '2026-11-19 14:07:00',
      text: '@coordinator Unrelated log note without target keyword.',
    });

    await page.waitForFunction((prev) => {
      return document.querySelectorAll('[data-testid="swarm-message"]').length > prev;
    }, [before], { timeout: 8000 });

    const after = await page.evaluate(() => document.querySelectorAll('[data-testid="swarm-message"]').length);
    assert.equal(after, before + 1, 'Only newly translated post matching active CN query should appear');
    page.assertNoErrors('3.3');
  });

  it('3.4 Pairwise: Overview view_zh + narrator_bootstrap iframe (#ov-frame) + #ov-system alerts', async (t) => {
    llm.setMode('ok', { delayMs: 0 });
    const harness = new SidecarHarness({ overview: false, env: llmEnv() });
    t.after(() => harness.stop());
    const { workerConv } = buildRichOverviewSwarm(harness, { includeNarrator: true, includeHtml: true });
    // Trigger immediate 429 quota systemAttention on backend worker
    harness.writeTranscript(workerConv, [
      { step_index: 1, source: 'SYSTEM', type: 'ERROR_MESSAGE', status: 'DONE', error: '429 RESOURCE_EXHAUSTED quota' },
    ]);
    await harness.start();

    await harness.waitForSwarm((s) => !!s.view_zh && s.systemAttention?.length >= 1, { timeout: 8000 });
    const page = await browser.newIsolatedPage();
    t.after(() => page.close());
    await page.navigate(`${harness.baseUrl}/?narrator=frame`);
    await page.waitForSwarmReady();
    await page.waitForSelector('[data-testid="swarm-overview-system-item"]', { visible: true });

    const sysText = await page.getText('[data-testid="swarm-overview-system-item"]');
    assertHasChinese(sysText, 'system alert in frame mode');

    let frameHeadline = '';
    const deadline = Date.now() + 6000;
    while (Date.now() < deadline) {
      try {
        frameHeadline = await page.evaluateInFrame('#ov-frame iframe.ov-iframe', () => {
          return document.getElementById('narrator-headline')?.textContent || '';
        });
        if (frameHeadline && frameHeadline !== 'Loading view...') break;
      } catch {
        // initializing
      }
      await new Promise((r) => setTimeout(r, 80));
    }
    assertHasChinese(frameHeadline, 'narrator iframe headline with system alert');
    page.assertNoErrors('3.4');
  });

  it('3.5 Pairwise: Graph replay Chinese caption (no .msg-orig) + #seq jump to Board', async (t) => {
    llm.setMode('ok', { delayMs: 0 });
    const harness = new SidecarHarness({ env: llmEnv() });
    t.after(() => harness.stop());
    buildBasicSwarm(harness);
    await harness.start();

    await harness.waitForSwarm((s) => s.messages?.every((m) => hasChinese(m.text_zh)), { timeout: 8000 });
    const page = await browser.newIsolatedPage();
    t.after(() => page.close());
    await page.navigate(`${harness.baseUrl}/?tab=graph&replay=2`);
    await page.waitForSwarmReady();
    await page.waitForSelector('#replay-caption:not(.hidden)', { visible: true });

    const zhCap = await page.getText('#replay-caption .msg-body');
    assertHasChinese(zhCap, 'replay caption in zh');
    assert.equal(await page.evaluate(() => document.querySelectorAll('#replay-caption .msg-orig').length), 0);

    await page.click('#replay-caption [data-testid="swarm-seq-ref"]');
    await page.waitForSelector('#tab-feed.active', { visible: true });
    page.assertNoErrors('3.5');
  });

  it('3.6 Pairwise: Members CN search + remote .o2-src banner + live transcript update', async (t) => {
    llm.setMode('ok', { delayMs: 0 });
    const harness = new SidecarHarness({ useTempSidecarCopy: true, env: llmEnv() });
    t.after(() => harness.stop());
    const { remoteDoc } = buildRemoteSwarm(harness);
    const builderConv = remoteDoc.members.builder.conversation_id;
    harness.writeTranscript(builderConv, [
      {
        step_index: 1,
        source: 'MODEL',
        type: 'PLANNER_RESPONSE',
        status: 'DONE',
        tool_calls: [{ id: 'tc1', name: 'read_file', args: { Path: 'C:\\repo\\build.ts' } }],
      },
    ]);
    await harness.start();

    await harness.waitForSwarm(
      (s) => s?.source && s.members?.length >= 2 && hasChinese(s.members.find((m) => m.name === 'builder')?.activity_zh),
      { timeout: 8000 }
    );
    const page = await browser.newIsolatedPage();
    t.after(() => page.close());
    await page.navigate(harness.baseUrl);
    await page.waitForSwarmReady();
    await page.click('[data-testid="swarm-tab-members"]');
    await page.waitForSelector('[data-testid="swarm-source"]', { visible: true });

    const src = await page.getText('[data-testid="swarm-source"]');
    assertHasChinese(src, 'remote source banner');

    // Search in Chinese inside .o2-msin matching builder's Chinese activity
    await page.type('#members .o2-msin', '读取');
    const visibleRows = await page.evaluate(() => {
      return [...document.querySelectorAll('#members .o2-mrow')]
        .filter((r) => r.style.display !== 'none')
        .map((r) => r.getAttribute('data-open-member'));
    });
    assert.deepEqual(visibleRows, ['builder']);

    // Clear search and update builder's live transcript.jsonl, verifying .o2-mnow updates in Chinese
    await page.type('#members .o2-msin', '');
    harness.writeTranscript(builderConv, [
      {
        step_index: 2,
        source: 'MODEL',
        type: 'PLANNER_RESPONSE',
        status: 'DONE',
        thinking: 'Checking.\n\n**Running integration checks**\nWaiting.',
        tool_calls: [{ id: 'tc2', name: 'run_command', args: { CommandLine: 'npm test' } }],
      },
    ]);

    await page.waitForFunction(() => {
      const act = document.querySelector('#members [data-open-member="builder"] .o2-mnow')?.textContent || '';
      return /[\u4e00-\u9fff]/.test(act) && !act.includes('build.ts');
    }, [], { timeout: 8000 });
    const updatedNow = await page.getText('#members [data-open-member="builder"] .o2-mnow');
    assertHasChinese(updatedNow, '3.6 live updated .o2-mnow');
    assert.ok(!/^Run\s+npm test/i.test(updatedNow), `Untranslated live .o2-mnow: ${updatedNow}`);
    page.assertNoErrors('3.6');
  });

  it('3.7 Pairwise: [done] & waiting_on protocol integrity preserved in zh mode', async (t) => {
    llm.setMode('ok', { delayMs: 0 });
    const harness = new SidecarHarness({ env: llmEnv() });
    t.after(() => harness.stop());
    buildBasicSwarm(harness, {
      messages: [
        { seq: 1, agent: 'coordinator', time: '2026-11-19 14:00:00', text: '@backend Run checks.' },
        { seq: 2, agent: 'backend', time: '2026-11-19 14:01:00', text: '@reviewer Can you verify this output?' },
        { seq: 3, agent: 'coordinator', time: '2026-11-19 14:02:00', text: '[done] All workstreams completed cleanly.' },
      ],
    });
    await harness.start();

    await harness.waitForSwarm((s) => s.messages?.every((m) => hasChinese(m.text_zh)), { timeout: 8000 });
    const page = await browser.newIsolatedPage();
    t.after(() => page.close());
    await page.navigate(harness.baseUrl);
    await page.waitForSwarmReady();

    // [done] by coordinator must clear Overview tab attention badge even when translated
    const badgeHidden = await page.evaluate(() => document.querySelector('[data-testid="swarm-tab-badge-overview"]')?.classList.contains('hidden'));
    assert.equal(badgeHidden, true, 'Coordinator [done] must still clear overview badge in zh mode');
    page.assertNoErrors('3.7');
  });

  it('3.8 Pairwise: #f-mention filter + archived channel (#parser) + bilingual search', async (t) => {
    llm.setMode('ok', { delayMs: 0 });
    const harness = new SidecarHarness({ env: llmEnv() });
    t.after(() => harness.stop());
    buildPlanAndChannelsSwarm(harness);
    await harness.start();

    await harness.waitForSwarm(
      (s) => {
        const m4 = s.messages?.find((m) => m.seq === 4);
        return m4 && hasChinese(m4.text_zh);
      },
      { timeout: 8000 }
    );
    const page = await browser.newIsolatedPage();
    t.after(() => page.close());
    await page.navigate(harness.baseUrl);
    await page.waitForSwarmReady();

    await page.click('[data-testid="swarm-tab-feed"]');
    await page.click('[data-testid="swarm-filter-toggle"]');
    await page.selectOption('#f-channel', 'parser');
    await page.selectOption('#f-mention', 'coordinator');
    await page.type('[data-testid="swarm-search"]', 'AST ready');

    const msgs = await page.getAllText('[data-testid="swarm-message"] .msg-body');
    assert.equal(msgs.length, 1, `Expected #f-mention=coordinator + #f-channel=parser + search to show seq 4, got ${msgs.length}`);
    assertHasChinese(msgs.join('\n'), '3.8 Chinese translation in archived channel');
    assert.equal(await page.evaluate(() => document.querySelectorAll('.msg-orig').length), 0);
    page.assertNoErrors('3.8');
  });

  it('3.9 Pairwise: plan_zh (no view.json) + worker filter chip (.o2-m[data-o2who]) + clean Chinese header', async (t) => {
    llm.setMode('ok', { delayMs: 0 });
    const harness = new SidecarHarness({ env: llmEnv() });
    t.after(() => harness.stop());
    buildPlanAndChannelsSwarm(harness);
    await harness.start();

    await harness.waitForSwarm((s) => !!s.plan_zh, { timeout: 8000 });
    const page = await browser.newIsolatedPage();
    t.after(() => page.close());
    await page.navigate(harness.baseUrl);
    await page.waitForSwarmReady();

    await page.click('.o2-m[data-o2who="parser"]');
    const plainZh = await page.getText('[data-testid="swarm-overview-plain"]');
    assertHasChinese(plainZh, 'filtered plan_zh overview');
    assert.equal(await page.evaluate(() => document.querySelectorAll('.o2-orig').length), 0);
    assertLangModeAbsent(await getLangModeState(page), '3.9');
    page.assertNoErrors('3.9');
  });

  it('3.10 Pairwise: Screenshot reel frames + .o2-tv lightbox + Chinese captions', async (t) => {
    llm.setMode('ok', { delayMs: 0 });
    const harness = new SidecarHarness({ env: llmEnv() });
    t.after(() => harness.stop());
    buildScreenshotSwarm(harness);
    await harness.start();

    await harness.waitForSwarm((s) => s.frames?.length >= 2 && s.frames.every((f) => hasChinese(f.caption_zh)), { timeout: 8000 });
    const page = await browser.newIsolatedPage();
    t.after(() => page.close());
    await page.navigate(harness.baseUrl);
    await page.waitForSwarmReady();
    await page.waitForSelector('.o2-reel .o2-rexp', { visible: true });

    await page.click('.o2-reel .o2-rexp');
    await page.waitForSelector('.o2-tv', { visible: true });
    const cap = await page.getText('.o2-tv .o2-tvcap');
    assertTranslatedFrom(cap, 'Aligned split pane cards', '3.10 lightbox caption');
    assert.ok(
      !/Baseline header before alignment|Aligned split pane cards/i.test(cap),
      `Untranslated 3.10 lightbox caption: ${cap}`
    );
    page.assertNoErrors('3.10');
  });

  it('3.11 Pairwise: Offline Tier-1 + real 56f8c44e corpus + #raw lossless + bilingual search', async (t) => {
    const harness = new SidecarHarness({ conversationId: SWARM_56F8, env: { AGY_SWARM_TRANSLATE_DISABLED: '1' } });
    t.after(() => harness.stop());
    copyRealSwarm(harness, SWARM_56F8);
    await harness.start();

    const page = await browser.newIsolatedPage();
    t.after(() => page.close());
    await page.navigate(`${harness.baseUrl}/?tab=feed`);
    await page.waitForSwarmReady();

    await page.type('[data-testid="swarm-search"]', 'Phase 2B');
    const count = await page.evaluate(() => document.querySelectorAll('[data-testid="swarm-message"]').length);
    assert.ok(count >= 2);

    await page.click('[data-testid="swarm-tab-raw"]');
    await page.click('.raw-btn[data-raw="board"]');
    const raw = await page.getText('[data-testid="swarm-raw"]');
    assert.ok(raw.includes('Phase 2B verification'));
    page.assertNoErrors('3.11');
  });

  it('3.12 Pairwise: view.json > 64KB + killed narrator + systemAttention quota alert simultaneously', async (t) => {
    llm.setMode('ok', { delayMs: 0 });
    const harness = new SidecarHarness({ overview: false, env: llmEnv() });
    t.after(() => harness.stop());
    const { workerConv } = buildRichOverviewSwarm(harness, { includeNarrator: true, killedNarrator: true, oversizedView: true });
    harness.writeTranscript(workerConv, [
      { step_index: 1, source: 'SYSTEM', type: 'ERROR_MESSAGE', status: 'DONE', error: '429 RESOURCE_EXHAUSTED' },
    ]);
    await harness.start();

    const page = await browser.newIsolatedPage();
    t.after(() => page.close());
    await page.navigate(harness.baseUrl);
    await page.waitForSwarmReady();

    const notice = await page.getText('[data-testid="swarm-overview-notice"]');
    const sys = await page.getText('[data-testid="swarm-overview-system-item"]');
    assertHasChinese(notice, 'killed narrator notice');
    assertHasChinese(sys, 'quota alert');
    page.assertNoErrors('3.12');
  });

  it('3.13 Pairwise: Async LLM finishes and updates live to Chinese even with stale localStorage["swarm.langMode"]="en"', async (t) => {
    llm.setMode('ok', { delayMs: 600 });
    const harness = new SidecarHarness({ env: llmEnv() });
    t.after(() => harness.stop());
    buildBasicSwarm(harness, {
      messages: [{ seq: 1, agent: 'backend', time: '2026-11-19 14:00:00', text: 'Async translation arrival check.' }],
    });
    await harness.start();

    const page = await browser.newIsolatedPage({ localStorageSeed: { 'swarm.langMode': 'en' } });
    t.after(() => page.close());
    await page.navigate(`${harness.baseUrl}/?tab=feed`);
    await page.waitForSwarmReady();

    await harness.waitForSwarm((s) => hasChinese(s.messages?.[0]?.text_zh), { timeout: 8000 });
    await page.waitForFunction(() => /[\u4e00-\u9fff]/.test(document.querySelector('[data-testid="swarm-message"] .msg-body')?.textContent || ''), [], { timeout: 8000 });

    const zhText = await page.getText('[data-testid="swarm-message"] .msg-body');
    assertHasChinese(zhText, 'async arrival renders Chinese despite stale localStorage');
    assertLangModeAbsent(await getLangModeState(page), '3.13');
    page.assertNoErrors('3.13');
  });

  it('3.14 Pairwise: etag bump on async translation updates #members and #ov-plain live', async (t) => {
    llm.setMode('ok', { delayMs: 400 });
    const harness = new SidecarHarness({ env: llmEnv() });
    t.after(() => harness.stop());
    buildRichOverviewSwarm(harness);
    await harness.start();

    const page = await browser.newIsolatedPage();
    t.after(() => page.close());
    await page.navigate(harness.baseUrl);
    await page.waitForSwarmReady();

    await page.waitForFunction(() => {
      const txt = document.querySelector('[data-testid="swarm-overview-plain"]')?.textContent || '';
      return /[\u4e00-\u9fff]/.test(txt)
        && !txt.includes('Audit and fix Hub window layouts')
        && !txt.includes('Drafting a design doc');
    }, [], { timeout: 8000 });
    const plainText = await page.getText('[data-testid="swarm-overview-plain"]');
    assert.ok(
      !plainText.includes('Audit and fix Hub window layouts') && !plainText.includes('Drafting a design doc'),
      `Untranslated view_zh prose in #ov-plain: ${plainText.slice(0, 300)}`
    );
    assertTranslatedFrom(plainText, 'Audit and fix Hub window layouts', '3.14 #ov-plain goal');
    assertTranslatedFrom(plainText, 'Drafting a design doc; research done, draft under review.', '3.14 #ov-plain headline');

    await page.click('[data-testid="swarm-tab-members"]');
    await page.waitForFunction(() => {
      const acts = [...document.querySelectorAll('[data-testid="swarm-member-activity"]')].map((e) => e.textContent || '');
      return acts.length > 0 && acts.every((a) => /[\u4e00-\u9fff]/.test(a) && !/Read\s+main\.ts|Running integration checks/i.test(a));
    }, [], { timeout: 8000 });
    const acts = await page.getAllText('[data-testid="swarm-member-activity"]');
    assertEveryHasChinese(acts, '3.14 .o2-mact');
    for (const a of acts) {
      assert.ok(
        !/Read\s+main\.ts|Running integration checks/i.test(a),
        `Untranslated .o2-mact after etag bump: ${a}`
      );
    }
    page.assertNoErrors('3.14');
  });

  it('3.15 Pairwise: Unread "New" divider + channel subscription + zh mode', async (t) => {
    llm.setMode('ok', { delayMs: 0 });
    const harness = new SidecarHarness({ env: llmEnv() });
    t.after(() => harness.stop());
    const { reviewerConv } = buildPlanAndChannelsSwarm(harness);
    await harness.start();

    const page = await browser.newIsolatedPage({ allowConversationMetadataError: true });
    t.after(() => page.close());
    await page.navigate(`${harness.baseUrl}/?conversationId=${reviewerConv}&tab=feed`);
    await page.waitForSwarmReady();
    await page.waitForSelector('[data-testid="swarm-unread-divider"]', { visible: true });

    const divText = await page.getText('[data-testid="swarm-unread-divider"]');
    assertHasChinese(divText, 'unread divider with channels');
    page.assertNoErrors('3.15');
  });

  it('3.16 Pairwise: Warm disk cache + 429 retry for live post + literal preservation in bi mode', async (t) => {
    llm.resetStats();
    llm.setMode('ok', { delayMs: 0 });
    const harness = new SidecarHarness({ env: llmEnv() });
    t.after(() => harness.stop());
    buildBasicSwarm(harness);
    await harness.start();

    await harness.waitForSwarm((s) => s.messages?.every((m) => hasChinese(m.text_zh)), { timeout: 8000 });
    llm.resetStats();
    llm.setMode('ok', { delayMs: 0, failFirstN: 1, failMode: '429' });

    harness.appendBoardLine(harness.conversationId, {
      seq: 4,
      agent: 'backend',
      time: '2026-11-19 14:08:00',
      text: '@coordinator Check `F:\\new\\file.js` and `#1` after retry.',
    });

    await harness.waitForSwarm((s) => s.messages?.length === 4 && hasChinese(s.messages[3]?.text_zh), { timeout: 10000 });
    const page = await browser.newIsolatedPage({ localStorageSeed: { 'swarm.langMode': 'bi' } });
    t.after(() => page.close());
    await page.navigate(`${harness.baseUrl}/?tab=feed`);
    await page.waitForSwarmReady();

    const feedText = await page.getText('[data-testid="swarm-feed"]');
    assertLiteralsPreserved(feedText, ['F:\\new\\file.js', '@coordinator'], 'bi mode cached+retried post');
    page.assertNoErrors('3.16');
  });
});
