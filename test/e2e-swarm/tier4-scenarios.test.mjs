import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';

import { CdpBrowser } from './cdp-browser.mjs';
import { SidecarHarness } from './sidecar-harness.mjs';
import { MockLlmServer } from './mock-llm.mjs';
import {
  SWARM_56F8,
  SWARM_E0DA,
  copyRealSwarm,
  buildBasicSwarm,
  buildRichOverviewSwarm,
  buildEmptyOnboardingSwarm,
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

describe('Tier 4 — Real-World Application Scenarios (6 scenarios)', () => {
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

  it('Scenario 1: Reference Screenshot Swarm (56f8c44e, #36-#42 & >=49 posts)', async (t) => {
    llm.resetStats();
    llm.setMode('ok', { delayMs: 0 });
    const harness = new SidecarHarness({ conversationId: SWARM_56F8, env: llmEnv() });
    t.after(() => harness.stop());
    copyRealSwarm(harness, SWARM_56F8);
    await harness.start();

    // Wait until posts #36..#42 have text_zh genuinely populated (not untranslated verbatim English)
    const snap = await harness.waitForSwarm((s) => {
      if (!s?.messages || s.messages.length < 49) return false;
      const target = s.messages.filter((m) => m.seq >= 36 && m.seq <= 42);
      return target.length === 7 && target.every((m) => (
        hasChinese(m.text_zh)
        && m.text_zh.trim() !== m.text.trim()
        && !m.text_zh.includes('Please run')
        && !m.text_zh.includes('Headline findings')
        && !m.text_zh.includes('You own the')
        && !m.text_zh.includes('You are the independent verifier')
      ));
    }, { timeout: 25000 });
    assertSnapshotContract(snap);

    const page = await browser.newIsolatedPage();
    t.after(() => page.close());
    await page.navigate(`${harness.baseUrl}/?tab=feed`);
    await page.waitForSwarmReady();
    await page.waitForSelector('[data-testid="swarm-message"][data-seq="42"]', { visible: true });

    const seq36to42 = await page.evaluate(() => {
      return [36, 37, 38, 39, 40, 41, 42].map((seq) => {
        const el = document.querySelector(`[data-testid="swarm-message"][data-seq="${seq}"]`);
        const body = el?.querySelector('.msg-body');
        return {
          seq,
          fullText: el ? (el.textContent || '').trim() : '',
          bodyText: body ? (body.textContent || '').trim() : '',
        };
      });
    });

    const forbiddenEnglishBySeq = {
      36: ['Please run', 'final verification pass', 'Spot-check directly against raw'],
      37: ['Headline findings', 'Verified Verbatim on Raw Disk', 'Tiny Polish Notes'],
      38: ['completed cleanly', 'final verified report published to'],
      40: ['You own the', 'Reconcile exact counts', 'Classify EVERY'],
      41: ['You own the', 'Build the exact', 'Measure exact disk footprint'],
      42: ['You are the independent verifier', 'Wait for both', 'Once BOTH have posted'],
    };

    for (const item of seq36to42) {
      const rawMsg = snap.messages.find((m) => m.seq === item.seq);
      const rawNoMentions = String(rawMsg.text || '').replace(/^(\s*@[A-Za-z0-9_.-]+(?:\s*[,，:：、])?)+\s*/, '');
      assertHasChinese(item.bodyText, `56f8 #${item.seq}`);
      assert.notEqual(item.bodyText, rawMsg.text, `56f8 #${item.seq} rendered body must differ from raw text`);
      assert.notEqual(item.bodyText, rawNoMentions, `56f8 #${item.seq} rendered body must differ from stripped raw text`);
      assertTranslatedFrom(item.bodyText, rawNoMentions, `56f8 #${item.seq} translation check`);
      for (const phrase of forbiddenEnglishBySeq[item.seq] || []) {
        assert.ok(
          !item.bodyText.includes(phrase),
          `56f8 #${item.seq} left untranslated English phrase ${JSON.stringify(phrase)} in zh mode`
        );
      }
    }
    const p36 = seq36to42.find((x) => x.seq === 36);
    assertLiteralsPreserved(p36.fullText, ['verifier', '不要用黑话'], '56f8 #36 rendered literals');
    const snap36 = snap.messages.find((m) => m.seq === 36);
    assertLiteralsPreserved(snap36.text_zh, ['@verifier', '不要用黑话'], '56f8 #36 text_zh literals');
    const p37 = seq36to42.find((x) => x.seq === 37);
    assertLiteralsPreserved(p37.fullText, ['coordinator', '@auditor', '#35'], '56f8 #37 rendered literals');

    // Verify Members (>=20 total, >=18 retired) & Graph & Raw
    await page.click('[data-testid="swarm-tab-members"]');
    await page.waitForSelector('.o2-mret', { visible: true });
    await page.click('.o2-mret');
    const membersText = await page.getText('[data-testid="swarm-members"]');
    assertHasChinese(membersText, '56f8 members');
    assertNoUntranslatedUiStrings(membersText, ['Standing by', 'Coordinator', 'Retired'], '56f8 members');

    await page.click('[data-testid="swarm-tab-graph"]');
    await page.waitForSelector('#replay-label', { visible: true });
    assertHasChinese(await page.getText('#replay-label'), '56f8 graph replay label');

    await page.click('[data-testid="swarm-tab-raw"]');
    await page.click('.raw-btn[data-raw="board"]');
    const rawBoard = await page.getText('[data-testid="swarm-raw"]');
    assert.ok(rawBoard.includes('Phase 2B verification'), 'Raw board.jsonl must remain lossless');
    page.assertNoErrors('Scenario 1');
  });

  it('Scenario 2: Live-Member Mixed CN/EN Swarm (e0dad013, >=55 posts, >=7 active members)', async (t) => {
    llm.resetStats();
    llm.setMode('ok', { delayMs: 0 });
    const harness = new SidecarHarness({ conversationId: SWARM_E0DA, env: llmEnv() });
    t.after(() => harness.stop());
    copyRealSwarm(harness, SWARM_E0DA);
    await harness.start();

    const snap = await harness.waitForSwarm((s) => {
      if (!s?.messages || s.messages.length < 55) return false;
      return s.messages.slice(-5).every((m) => hasChinese(m.text_zh));
    }, { timeout: 20000 });
    assertSnapshotContract(snap);
    assert.ok(snap.members.length >= 7, `Expected >= 7 members in e0da, got ${snap.members.length}`);

    const page = await browser.newIsolatedPage();
    t.after(() => page.close());
    await page.navigate(`${harness.baseUrl}/?tab=feed`);
    await page.waitForSwarmReady();

    // Bilingual search for Chinese UI term inside e0da
    await page.type('[data-testid="swarm-search"]', '当前聊天');
    const matched = await page.evaluate(() => document.querySelectorAll('[data-testid="swarm-message"]').length);
    assert.ok(matched >= 1, 'Expected e0da mixed CN/EN query 当前聊天 to match');

    await page.click('[data-testid="swarm-tab-members"]');
    await page.waitForSelector('#members .o2-mrow', { visible: true });
    const rowCount = await page.evaluate(() => document.querySelectorAll('#members .o2-mrow').length);
    assert.ok(rowCount >= 6, `Expected active team rows in e0da Members, got ${rowCount}`);
    const membersText = await page.getText('[data-testid="swarm-members"]');
    assertNoUntranslatedUiStrings(membersText, ['Standing by', 'Coordinator'], 'e0da members');
    page.assertNoErrors('Scenario 2');
  });

  it('Scenario 3: Live Streaming Swarm Session (onboarding -> briefs -> tool activity -> async LLM -> [done])', async (t) => {
    llm.resetStats();
    llm.setMode('ok', { delayMs: 150 });
    const harness = new SidecarHarness({ env: llmEnv() });
    t.after(() => harness.stop());
    const { convId } = buildEmptyOnboardingSwarm(harness);
    await harness.start();

    const page = await browser.newIsolatedPage();
    t.after(() => page.close());
    await page.navigate(harness.baseUrl);
    await page.waitForSwarmReady();
    await page.waitForSelector('[data-testid="swarm-onboarding"]', { visible: true });

    const onbText = await page.getText('[data-testid="swarm-onboarding"]');
    assertHasChinese(onbText, 'Scenario 3 onboarding');

    // Step 2: Coordinator adds worker, writes brief, worker starts running tool
    const workerConv = '22222222-2222-4222-8222-222222222222';
    harness.writeSwarmFiles(convId, {
      membersJson: {
        title: 'Live Streaming Release Swarm',
        members: {
          coordinator: { conversation_id: convId, role: 'coordinator', model: 'gemini-4-neon-xhigh', wake_mode: 'mentions', last_read_seq: 1, killed: false },
          worker: { conversation_id: workerConv, role: 'worker', model: 'gemini-4-neon-xhigh', wake_mode: 'mentions', last_read_seq: 1, killed: false },
        },
      },
      boardLines: [
        { seq: 1, agent: 'coordinator', kind: 'brief', time: '2026-11-19 15:10:00', text: '@worker Audit `src/index.ts` and report.' },
      ],
    });
    harness.writeTranscript(workerConv, [
      { step_index: 1, source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE', tool_calls: [{ id: 'tc1', name: 'read_file', args: { Path: 'C:\\repo\\src\\index.ts' } }] },
    ]);

    await page.click('[data-testid="swarm-tab-members"]');
    await page.waitForFunction(() => /[\u4e00-\u9fff]/.test(document.querySelector('[data-testid="swarm-member-activity"]')?.textContent || ''), [], { timeout: 8000 });

    // Step 3: Worker posts completion & coordinator closes swarm with [done]
    harness.writeTranscript(workerConv, [
      { step_index: 1, source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE', tool_calls: [{ id: 'tc1', name: 'swarm_wait', args: {} }] },
      { step_index: 2, source: 'SYSTEM', type: 'GENERIC', status: 'DONE' },
    ]);
    harness.appendBoardLine(convId, { seq: 2, agent: 'worker', time: '2026-11-19 15:11:00', text: '@coordinator [done] `src/index.ts` audit passed.' });
    harness.appendBoardLine(convId, { seq: 3, agent: 'coordinator', time: '2026-11-19 15:12:00', text: '[done] Swarm finished cleanly.' });

    await page.click('[data-testid="swarm-tab-feed"]');
    await page.waitForFunction(() => {
      const msgs = [...document.querySelectorAll('[data-testid="swarm-message"]')];
      return msgs.length === 3 && msgs.every((m) => /[\u4e00-\u9fff]/.test(m.querySelector('.msg-body')?.textContent || ''));
    }, [], { timeout: 10000 });

    const badgeHidden = await page.evaluate(() => document.querySelector('[data-testid="swarm-tab-badge-overview"]')?.classList.contains('hidden'));
    assert.equal(badgeHidden, true, 'Final [done] must clear overview attention badge');
    page.assertNoErrors('Scenario 3');
  });

  it('Scenario 4: Full Overview, Narrator Iframe, Progress Reel Lightbox & System Alerts', async (t) => {
    llm.resetStats();
    llm.setMode('ok', { delayMs: 0 });
    const harness = new SidecarHarness({ overview: false, env: llmEnv() });
    t.after(() => harness.stop());
    const { workerConv } = buildRichOverviewSwarm(harness, { includeNarrator: true, includeHtml: true, includeReel: true });
    harness.writeTranscript(workerConv, [
      { step_index: 1, source: 'SYSTEM', type: 'ERROR_MESSAGE', status: 'DONE', error: '429 RESOURCE_EXHAUSTED quota' },
    ]);
    await harness.start();

    await harness.waitForSwarm((s) => !!s.view_zh && s.systemAttention?.length >= 1, { timeout: 8000 });
    const page = await browser.newIsolatedPage();
    t.after(() => page.close());
    await page.navigate(harness.baseUrl);
    await page.waitForSwarmReady();

    // 1. Plain Overview with view_zh + system alert + feedback_ack
    const plain = await page.getText('[data-testid="swarm-overview-plain"]');
    assertHasChinese(plain, 'Scenario 4 plain overview');
    const sysAlert = await page.getText('[data-testid="swarm-overview-system-item"]');
    assertHasChinese(sysAlert, 'Scenario 4 system alert');
    const ack = await page.getText('[data-testid="swarm-overview-ack"]');
    assertHasChinese(ack, 'Scenario 4 feedback_ack');

    // 2. Open Progress Reel lightbox (.o2-tv) and verify localized caption
    await page.waitForSelector('.o2-reel .o2-rexp', { visible: true });
    await page.click('.o2-reel .o2-rexp');
    await page.waitForSelector('.o2-tv', { visible: true });
    assertHasChinese(await page.getText('.o2-tv'), 'Scenario 4 lightbox');
    await page.evaluate(() => document.querySelector('.o2-tv .o2-tvx')?.click());

    // 3. Switch to Narrator's iframe (#ov-frame) and verify view_zh rendered
    await page.click('[data-testid="swarm-overview-mode"]');
    await page.waitForSelector('[data-testid="swarm-overview-iframe"]');
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
    assertHasChinese(frameHeadline, 'Scenario 4 narrator iframe view_zh');
    page.assertNoErrors('Scenario 4');
  });

  it('Scenario 5: Bilingual Developer Debugging (CN+EN search, clean header, #seq jump, #raw lossless)', async (t) => {
    llm.resetStats();
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

    // 1. Search by Chinese phrase AND raw English phrase without any lang-mode toggle
    assertLangModeAbsent(await getLangModeState(page), 'Scenario 5');
    await page.type('[data-testid="swarm-search"]', '已完成');
    assert.equal(await page.evaluate(() => document.querySelectorAll('[data-testid="swarm-message"]').length), 1);

    await page.type('[data-testid="swarm-search"]', 'All verification checks passed cleanly.');
    assert.equal(await page.evaluate(() => document.querySelectorAll('[data-testid="swarm-message"]').length), 1);

    // 2. Clear search, reload, verify clean Chinese rendering with no .msg-orig clutter
    await page.type('[data-testid="swarm-search"]', '');
    await page.reload();
    await page.waitForSwarmReady();
    const feedText = await page.getText('[data-testid="swarm-feed"]');
    assertHasChinese(feedText, 'Scenario 5 clean Chinese feed');
    assert.equal(await page.evaluate(() => document.querySelectorAll('.msg-orig').length), 0);

    // 3. Jump via Graph replay #seq citation back to Board
    await page.click('[data-testid="swarm-tab-graph"]');
    await page.click('#replay-start');
    await page.click('#replay-fwd');
    await page.click('#replay-fwd');
    await page.waitForSelector('#replay-caption [data-testid="swarm-seq-ref"]', { visible: true });
    await page.click('#replay-caption [data-testid="swarm-seq-ref"]');
    await page.waitForSelector('#tab-feed.active', { visible: true });

    // 4. Inspect Raw tab and confirm lossless English disk files
    await page.click('[data-testid="swarm-tab-raw"]');
    await page.click('.raw-btn[data-raw="board"]');
    const raw = await page.getText('[data-testid="swarm-raw"]');
    assert.ok(raw.includes('Please inspect `C:\\\\repo\\\\src\\\\main.ts`') || raw.includes('C:\\\\repo\\\\src\\\\main.ts'));
    page.assertNoErrors('Scenario 5');
  });

  it('Scenario 6: Offline / Fault-Tolerant Degradation & Warm Cache Persistence', async (t) => {
    let harness1 = null;
    let harness2 = null;
    let harness3 = null;
    let page1 = null;
    let page3 = null;
    t.after(async () => {
      const errors = [];
      for (const fn of [
        () => page3?.close(),
        () => page1?.close(),
        () => harness3?.stop({ cleanup: true }),
        () => harness2?.stop({ cleanup: true }),
        () => harness1?.stop({ cleanup: true }),
      ]) {
        try {
          await fn();
        } catch (err) {
          errors.push(err);
        }
      }
      if (errors.length > 0) {
        throw errors.length === 1 ? errors[0] : new AggregateError(errors, 'Scenario 6 cleanup failed');
      }
    });

    // Phase A: Outage (LLM returns 500) -> UI boots cleanly with localized chrome & Tier-1
    llm.resetStats();
    llm.setMode('500');
    harness1 = new SidecarHarness({ env: llmEnv() });
    buildBasicSwarm(harness1);
    await harness1.start();

    page1 = await browser.newIsolatedPage();
    await page1.navigate(harness1.baseUrl);
    await page1.waitForSwarmReady();
    const tabs1 = await page1.getAllText('[data-testid="swarm-tabs"] button.tab');
    for (const tab of tabs1) assertHasChinese(tab, 'Scenario 6 outage tab');
    page1.assertNoErrors('Scenario 6 phase A');
    await page1.close();
    page1 = null;

    // Phase B: Recover LLM, populate persistent cache, restart sidecar with LLM disabled
    llm.setMode('ok', { delayMs: 0 });
    const convId = harness1.conversationId;
    const sharedDataDir = harness1.sidecarDataDir;
    await harness1.stop({ cleanup: false });

    harness2 = new SidecarHarness({
      conversationId: convId,
      env: { ...llmEnv(), ANTIGRAVITY_EXECUTABLE_DATA_DIR: sharedDataDir },
    });
    await harness2.start();
    await harness2.waitForSwarm((s) => s.messages?.every((m) => hasChinese(m.text_zh)), { timeout: 8000 });
    await harness2.stop({ cleanup: true });

    llm.resetStats();
    harness3 = new SidecarHarness({
      conversationId: convId,
      env: {
        ANTIGRAVITY_EXECUTABLE_DATA_DIR: sharedDataDir,
        AGY_SWARM_TRANSLATE_DISABLED: '1',
      },
    });
    await harness3.start();

    const snap3 = await harness3.getSwarm();
    assertSnapshotContract(snap3);
    assert.equal(llm.requests.length, 0);

    page3 = await browser.newIsolatedPage();
    await page3.navigate(harness3.baseUrl);
    await page3.waitForSwarmReady();
    await page3.click('[data-testid="swarm-tab-feed"]');
    await page3.waitForSelector('[data-testid="swarm-message"] .msg-body', { visible: true });
    const bodies3 = await page3.getAllText('[data-testid="swarm-message"] .msg-body');
    assertEveryHasChinese(bodies3, 'Scenario 6 phase C DOM');
    assertNoUntranslatedUiStrings(await page3.getText('body'), undefined, 'Scenario 6 phase C UI');
    page3.assertNoErrors('Scenario 6 phase C');
  });
});
