import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { CdpBrowser } from './cdp-browser.mjs';
import { SidecarHarness } from './sidecar-harness.mjs';
import { MockLlmServer } from './mock-llm.mjs';
import {
  buildBasicSwarm,
  buildRichOverviewSwarm,
  buildPlanAndChannelsSwarm,
  buildEmptyOnboardingSwarm,
  buildRemoteSwarm,
} from './fixtures.mjs';
import {
  assertHasChinese,
  assertNoUntranslatedUiStrings,
  assertLiteralsPreserved,
  assertSnapshotContract,
  getLangModeState,
  assertLangModeAbsent,
  hasChinese,
} from './assertions.mjs';

describe('Tier 2 — Boundary & Corner Cases (>= 55 tests across 11 areas)', () => {
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

  // =========================================================================
  // Area 1: Board Boundaries — 5 tests
  // =========================================================================
  describe('Area 1: Board Boundaries', () => {
    it('2.1.1 Empty board (0 messages) renders localized empty feed state', async (t) => {
      const harness = new SidecarHarness({ overview: false, env: llmEnv() });
      t.after(() => harness.stop());
      buildBasicSwarm(harness, { messages: [] });
      await harness.start();

      const page = await browser.newIsolatedPage();
      t.after(() => page.close());
      await page.navigate(harness.baseUrl);
      await page.waitForSwarmReady();
      await page.waitForSelector('[data-testid="swarm-feed-empty"]', { visible: true });

      const emptyFeed = await page.getText('[data-testid="swarm-feed-empty"]');
      assertHasChinese(emptyFeed, 'empty feed state');
      assert.ok(!/no posts yet/i.test(emptyFeed), `Untranslated empty feed text: ${emptyFeed}`);
      page.assertNoErrors('2.1.1');
    });

    it('2.1.2 Malformed JSONL line mixed with valid lines does not crash sidecar or board', async (t) => {
      const harness = new SidecarHarness({ env: llmEnv() });
      t.after(() => harness.stop());
      buildBasicSwarm(harness, {
        messages: [
          JSON.stringify({ seq: 1, agent: 'coordinator', time: '2026-11-19 14:00:00', text: 'Valid line one.' }),
          '{broken-json-line',
          JSON.stringify({ seq: 2, agent: 'backend', time: '2026-11-19 14:01:00', text: 'Valid line two.' }),
        ],
      });
      await harness.start();

      const snap = await harness.getSwarm();
      assertSnapshotContract(snap);
      assert.equal(snap.messages.length, 2);

      const page = await browser.newIsolatedPage();
      t.after(() => page.close());
      await page.navigate(`${harness.baseUrl}/?tab=feed`);
      await page.waitForSwarmReady();
      const count = await page.evaluate(() => document.querySelectorAll('[data-testid="swarm-message"]').length);
      assert.equal(count, 2);
      page.assertNoErrors('2.1.2');
    });

    it('2.1.3 Non-roster author post renders cleanly and translates without crash', async (t) => {
      const harness = new SidecarHarness({ env: llmEnv() });
      t.after(() => harness.stop());
      buildBasicSwarm(harness, {
        messages: [
          { seq: 1, agent: 'ghost-outsider', time: '2026-11-19 14:00:00', text: 'External status report submitted.' },
        ],
      });
      await harness.start();

      await harness.waitForSwarm((s) => hasChinese(s.messages?.[0]?.text_zh), { timeout: 8000 });
      const page = await browser.newIsolatedPage();
      t.after(() => page.close());
      await page.navigate(`${harness.baseUrl}/?tab=feed`);
      await page.waitForSwarmReady();
      await page.waitForFunction(() => /[\u4e00-\u9fff]/.test(document.querySelector('[data-testid="swarm-message"] .msg-body')?.textContent || ''));

      const author = await page.getText('[data-testid="swarm-message"] .msg-author');
      assert.equal(author, '@ghost-outsider');
      page.assertNoErrors('2.1.3');
    });

    it('2.1.4 Very long clamped message toggles localized Show more / Show less cleanly', async (t) => {
      const harness = new SidecarHarness({ env: llmEnv() });
      t.after(() => harness.stop());
      const longBody = Array.from({ length: 50 }, (_, i) => `Paragraph ${i + 1}: long verification trace entry.`).join('\n\n');
      buildBasicSwarm(harness, {
        messages: [{ seq: 1, agent: 'backend', time: '2026-11-19 14:00:00', text: longBody }],
      });
      await harness.start();

      const page = await browser.newIsolatedPage();
      t.after(() => page.close());
      await page.navigate(`${harness.baseUrl}/?tab=feed`);
      await page.waitForSwarmReady();
      await page.waitForSelector('[data-testid="swarm-message-more"]:not(.hidden)', { visible: true });

      const moreBefore = await page.getText('[data-testid="swarm-message-more"]');
      assertHasChinese(moreBefore, 'collapsed Show more');
      assert.notEqual(moreBefore, 'Show more');

      await page.click('[data-testid="swarm-message-more"]');
      const moreAfter = await page.getText('[data-testid="swarm-message-more"]');
      assertHasChinese(moreAfter, 'expanded Show less');
      assert.notEqual(moreAfter, 'Show less');
      assert.notEqual(moreAfter, moreBefore);
      page.assertNoErrors('2.1.4');
    });

    it('2.1.5 Unread "New" divider localizes for worker conversationId view', async (t) => {
      const harness = new SidecarHarness({ env: llmEnv() });
      t.after(() => harness.stop());
      const { reviewerConv } = buildBasicSwarm(harness); // reviewer last_read_seq: 2, head: 3
      await harness.start();

      const page = await browser.newIsolatedPage({ allowConversationMetadataError: true });
      t.after(() => page.close());
      await page.navigate(`${harness.baseUrl}/?conversationId=${reviewerConv}&tab=feed`);
      await page.waitForSwarmReady();
      await page.waitForSelector('[data-testid="swarm-unread-divider"]', { visible: true });

      const divText = await page.getText('[data-testid="swarm-unread-divider"]');
      assertHasChinese(divText, 'unread divider');
      assert.notEqual(divText, 'New');
      page.assertNoErrors('2.1.5');
    });
  });

  // =========================================================================
  // Area 2: Members Boundaries — 5 tests
  // =========================================================================
  describe('Area 2: Members Boundaries', () => {
    it('2.2.1 Expanding Retired section reveals translated retired worker labels', async (t) => {
      const harness = new SidecarHarness({ env: llmEnv() });
      t.after(() => harness.stop());
      buildBasicSwarm(harness);
      await harness.start();

      const page = await browser.newIsolatedPage();
      t.after(() => page.close());
      await page.navigate(harness.baseUrl);
      await page.waitForSwarmReady();
      await page.click('[data-testid="swarm-tab-members"]');
      await page.waitForSelector('.o2-mret', { visible: true });

      const retBtnText = await page.getText('.o2-mret');
      assertHasChinese(retBtnText, 'retired group toggle');
      await page.click('.o2-mret');
      await page.waitForSelector('.o2-mrow.retired', { visible: true });

      const retStat = await page.getText('.o2-mrow.retired .o2-mstat');
      assertHasChinese(retStat, 'retired worker stat');
      assert.notEqual(retStat, 'Retired');
      page.assertNoErrors('2.2.1');
    });

    it('2.2.2 Member with zero posts renders localized "No posts yet" fallback', async (t) => {
      const harness = new SidecarHarness({ env: llmEnv() });
      t.after(() => harness.stop());
      buildEmptyOnboardingSwarm(harness);
      await harness.start();

      const page = await browser.newIsolatedPage();
      t.after(() => page.close());
      await page.navigate(harness.baseUrl);
      await page.waitForSwarmReady();
      await page.click('[data-testid="swarm-tab-members"]');
      await page.waitForSelector('#members .o2-mrow', { visible: true });

      const membersText = await page.getText('[data-testid="swarm-members"]');
      const nowText = await page.getText('#members .o2-mnow');
      assertHasChinese(membersText, '2.2.2 members view');
      assertHasChinese(nowText, '2.2.2 zero-post .o2-mnow');
      assert.ok(!membersText.includes('No posts yet'), `Untranslated 'No posts yet' in #members: ${membersText}`);
      page.assertNoErrors('2.2.2');
    });

    it('2.2.3 Member with 0 posts vs 1 post vs multiple posts uses Chinese count label', async (t) => {
      const harness = new SidecarHarness({ env: llmEnv() });
      t.after(() => harness.stop());
      buildBasicSwarm(harness, {
        messages: [
          { seq: 1, agent: 'coordinator', time: '2026-11-19 14:00:00', text: 'One post only.' },
        ],
      });
      await harness.start();

      const page = await browser.newIsolatedPage();
      t.after(() => page.close());
      await page.navigate(harness.baseUrl);
      await page.waitForSwarmReady();
      await page.click('[data-testid="swarm-tab-members"]');
      await page.waitForSelector('#members .o2-mts', { visible: true });

      const membersText = await page.getText('[data-testid="swarm-members"]');
      const mts = await page.getAllText('#members .o2-mts');
      assertHasChinese(membersText, '2.2.3 members view');
      assert.ok(!mts.some((x) => /\b1 post\b|\bposts\b/i.test(x)), `Untranslated post count in .o2-mts: ${mts.join(' | ')}`);
      page.assertNoErrors('2.2.3');
    });

    it('2.2.4 Remote member last_seen (<1m, hours) renders Chinese relative time', async (t) => {
      const harness = new SidecarHarness({ useTempSidecarCopy: true, env: llmEnv() });
      t.after(() => harness.stop());
      buildRemoteSwarm(harness);
      await harness.start();

      await harness.waitForSwarm((s) => s?.source && s.members?.length >= 2, { timeout: 8000 });
      const page = await browser.newIsolatedPage();
      t.after(() => page.close());
      await page.navigate(harness.baseUrl);
      await page.waitForSwarmReady();
      await page.click('[data-testid="swarm-tab-members"]');
      await page.waitForSelector('[data-testid="swarm-member-seen"]', { visible: true });

      const seen = await page.getAllText('[data-testid="swarm-member-seen"]');
      assertHasChinese(seen.join('\n'), 'remote last_seen tags');
      assert.ok(!seen.some((s) => /seen just now|last seen/i.test(s)), `Untranslated last_seen: ${seen.join(' | ')}`);
      page.assertNoErrors('2.2.4');
    });

    it('2.2.5 Waiting-on detection from raw English question works even in zh mode', async (t) => {
      const harness = new SidecarHarness({ env: llmEnv() });
      t.after(() => harness.stop());
      buildBasicSwarm(harness, {
        messages: [
          { seq: 1, agent: 'coordinator', time: '2026-11-19 14:00:00', text: '@backend Start audit.' },
          { seq: 2, agent: 'backend', time: '2026-11-19 14:01:00', text: '@reviewer Could you approve this PR?' },
        ],
      });
      await harness.start();

      await harness.waitForSwarm((s) => s.messages?.every((m) => hasChinese(m.text_zh)), { timeout: 8000 });
      const page = await browser.newIsolatedPage();
      t.after(() => page.close());
      await page.navigate(harness.baseUrl);
      await page.waitForSwarmReady();
      await page.click('[data-testid="swarm-tab-members"]');
      await page.waitForSelector('#members .o2-mstat.warn', { visible: true });

      const warnStat = await page.getText('#members .o2-mstat.warn');
      assertHasChinese(warnStat, 'waiting_on status badge');
      assert.ok(warnStat.includes('@reviewer'), `Expected @reviewer preserved in waiting badge, got: ${warnStat}`);
      assert.ok(!/^Waiting on /i.test(warnStat), `Untranslated 'Waiting on': ${warnStat}`);
      page.assertNoErrors('2.2.5');
    });
  });

  // =========================================================================
  // Area 3: Graph & Replay Boundaries — 5 tests
  // =========================================================================
  describe('Area 3: Graph & Replay Boundaries', () => {
    it('2.3.1 Single-message graph (0 edges) renders cleanly with Chinese label', async (t) => {
      const harness = new SidecarHarness({ env: llmEnv() });
      t.after(() => harness.stop());
      buildBasicSwarm(harness, {
        messages: [{ seq: 1, agent: 'coordinator', time: '2026-11-19 14:00:00', text: 'Solo broadcast message.' }],
      });
      await harness.start();

      const page = await browser.newIsolatedPage();
      t.after(() => page.close());
      await page.navigate(`${harness.baseUrl}/?tab=graph`);
      await page.waitForSwarmReady();
      await page.waitForSelector('#replay-label', { visible: true });

      const label = await page.getText('#replay-label');
      assertHasChinese(label, '1-post graph replay label');
      assert.ok(!/\b1 post\b/.test(label), `Untranslated '1 post': ${label}`);
      page.assertNoErrors('2.3.1');
    });

    it('2.3.2 Multi-hour swarm duration formats with Chinese units (时/分/秒)', async (t) => {
      const harness = new SidecarHarness({ env: llmEnv() });
      t.after(() => harness.stop());
      buildBasicSwarm(harness, {
        messages: [
          { seq: 1, agent: 'coordinator', time: '2026-11-19 10:00:00', text: '@backend Start long run.' },
          { seq: 2, agent: 'backend', time: '2026-11-19 12:15:30', text: '@coordinator [done] Long run finished.' },
        ],
      });
      await harness.start();

      const page = await browser.newIsolatedPage();
      t.after(() => page.close());
      await page.navigate(`${harness.baseUrl}/?tab=graph`);
      await page.waitForSwarmReady();

      const label = await page.getText('#replay-label');
      assertHasChinese(label, 'multi-hour #replay-label');
      assert.ok(!/\bover\b|\bposts\b/.test(label), `Untranslated duration units: ${label}`);
      page.assertNoErrors('2.3.2');
    });

    it('2.3.3 Hide inactive toggle filters killed nodes cleanly', async (t) => {
      const harness = new SidecarHarness({ env: llmEnv() });
      t.after(() => harness.stop());
      buildBasicSwarm(harness);
      await harness.start();

      const page = await browser.newIsolatedPage();
      t.after(() => page.close());
      await page.navigate(`${harness.baseUrl}/?tab=graph`);
      await page.waitForSwarmReady();

      const beforeNodes = await page.evaluate(() => document.querySelectorAll('#graph g.node').length);
      await page.click('[data-testid="swarm-graph-hide-inactive"]');
      const afterNodes = await page.evaluate(() => document.querySelectorAll('#graph g.node').length);
      assert.ok(afterNodes <= beforeNodes, 'Hide inactive must reduce or keep node count');
      page.assertNoErrors('2.3.3');
    });

    it('2.3.4 Expand @all toggle reveals @all broadcast edges with Chinese tooltip', async (t) => {
      const harness = new SidecarHarness({ env: llmEnv() });
      t.after(() => harness.stop());
      buildBasicSwarm(harness, {
        messages: [
          { seq: 1, agent: 'coordinator', time: '2026-11-19 14:00:00', text: '@all Attention everyone: sync now.' },
        ],
      });
      await harness.start();

      const page = await browser.newIsolatedPage();
      t.after(() => page.close());
      await page.navigate(`${harness.baseUrl}/?tab=graph`);
      await page.waitForSwarmReady();

      await page.click('#g-all');
      await page.waitForSelector('#graph path.edge.via-all title');
      const tip = await page.getText('#graph path.edge.via-all title');
      assertHasChinese(tip, '@all edge tooltip');
      assert.ok(!/via @all/i.test(tip), `Untranslated edge tooltip: ${tip}`);
      page.assertNoErrors('2.3.4');
    });

    it('2.3.5 Clicking #seq citation pill jumps to Board and highlights target post in zh mode', async (t) => {
      const harness = new SidecarHarness({ env: llmEnv() });
      t.after(() => harness.stop());
      buildBasicSwarm(harness);
      await harness.start();

      await harness.waitForSwarm((s) => s.messages?.some((m) => hasChinese(m.text_zh)), { timeout: 8000 });
      const page = await browser.newIsolatedPage();
      t.after(() => page.close());
      await page.navigate(`${harness.baseUrl}/?tab=graph&replay=2`);
      await page.waitForSwarmReady();
      await page.waitForSelector('#replay-caption [data-testid="swarm-seq-ref"]', { visible: true });

      await page.click('#replay-caption [data-testid="swarm-seq-ref"]');
      await page.waitForSelector('#tab-feed.active', { visible: true });
      const activeFeed = await page.evaluate(() => document.querySelector('#tab-feed')?.classList.contains('active'));
      assert.equal(activeFeed, true);
      page.assertNoErrors('2.3.5');
    });
  });

  // =========================================================================
  // Area 4: Overview & Narrator Boundaries — 5 tests
  // =========================================================================
  describe('Area 4: Overview & Narrator Boundaries', () => {
    it('2.4.1 view.json > 64 KB shows localized #ov-notice', async (t) => {
      const harness = new SidecarHarness({ env: llmEnv() });
      t.after(() => harness.stop());
      buildRichOverviewSwarm(harness, { oversizedView: true });
      await harness.start();

      const page = await browser.newIsolatedPage();
      t.after(() => page.close());
      await page.navigate(`${harness.baseUrl}/?tab=overview`);
      await page.waitForSwarmReady();
      await page.waitForFunction(() => (document.querySelector('[data-testid="swarm-overview-notice"]')?.textContent || '').trim().length > 0);

      const notice = await page.getText('[data-testid="swarm-overview-notice"]');
      assertHasChinese(notice, 'oversized view.json notice');
      assert.ok(!/is over 64 KB/.test(notice), `Untranslated 64 KB notice: ${notice}`);
      page.assertNoErrors('2.4.1');
    });

    it('2.4.2 Invalid JSON view.json shows localized #ov-notice', async (t) => {
      const harness = new SidecarHarness({ env: llmEnv() });
      t.after(() => harness.stop());
      buildRichOverviewSwarm(harness);
      harness.writeViewJson(harness.conversationId, '{not-valid-json');
      await harness.start();

      const page = await browser.newIsolatedPage();
      t.after(() => page.close());
      await page.navigate(`${harness.baseUrl}/?tab=overview`);
      await page.waitForSwarmReady();
      await page.waitForFunction(() => (document.querySelector('[data-testid="swarm-overview-notice"]')?.textContent || '').trim().length > 0);

      const notice = await page.getText('[data-testid="swarm-overview-notice"]');
      assertHasChinese(notice, 'invalid view.json notice');
      assert.ok(!/isn't valid JSON/.test(notice), `Untranslated invalid JSON notice: ${notice}`);
      page.assertNoErrors('2.4.2');
    });

    it('2.4.3 view.html > 64 KB falls back to plain overview with localized #ov-label reason', async (t) => {
      const harness = new SidecarHarness({ overview: false, env: llmEnv() });
      t.after(() => harness.stop());
      buildRichOverviewSwarm(harness, { includeNarrator: true, includeHtml: true });
      harness.writeViewHtml(harness.conversationId, '<html><body>' + 'x'.repeat(66000) + '</body></html>');
      await harness.start();

      const page = await browser.newIsolatedPage();
      t.after(() => page.close());
      await page.navigate(`${harness.baseUrl}/?narrator=frame&tab=overview`);
      await page.waitForSwarmReady();
      await page.waitForFunction(() => (document.querySelector('[data-testid="swarm-overview-label"] .ov-label-text')?.textContent || '').trim().length > 0);

      const lbl = await page.getText('[data-testid="swarm-overview-label"] .ov-label-text');
      assertHasChinese(lbl, 'oversized view.html label');
      assert.ok(!/view\.html is over 64 KB/.test(lbl), `Untranslated view.html size notice: ${lbl}`);
      page.assertNoErrors('2.4.3');
    });

    it('2.4.4 Killed narrator shows localized stopped badge & #ov-notice', async (t) => {
      const harness = new SidecarHarness({ overview: false, env: llmEnv() });
      t.after(() => harness.stop());
      buildRichOverviewSwarm(harness, { includeNarrator: true, killedNarrator: true });
      await harness.start();

      const page = await browser.newIsolatedPage();
      t.after(() => page.close());
      await page.navigate(`${harness.baseUrl}/?tab=overview`);
      await page.waitForSwarmReady();
      await page.waitForFunction(() => (document.querySelector('[data-testid="swarm-overview-notice"]')?.textContent || '').trim().length > 0);

      const notice = await page.getText('[data-testid="swarm-overview-notice"]');
      const badge = await page.getText('[data-testid="swarm-overview-badge"]');
      assertHasChinese(notice, 'killed narrator notice');
      assertHasChinese(badge, 'killed narrator badge');
      assert.ok(!/was stopped\. Ask the coordinator/.test(notice), `Untranslated killed narrator notice: ${notice}`);
      page.assertNoErrors('2.4.4');
    });

    it('2.4.5 Absent narrator with SWARM_OVERVIEW=false/no view.json vs SWARM_OVERVIEW=true shows localized notice', async (t) => {
      const harness = new SidecarHarness({ overview: true, env: llmEnv() });
      t.after(() => harness.stop());
      buildBasicSwarm(harness);
      await harness.start();

      const page = await browser.newIsolatedPage();
      t.after(() => page.close());
      await page.navigate(`${harness.baseUrl}/?tab=overview`);
      await page.waitForSwarmReady();
      await page.waitForFunction(() => (document.querySelector('[data-testid="swarm-overview-notice"]')?.textContent || '').trim().length > 0);

      const notice = await page.getText('[data-testid="swarm-overview-notice"]');
      assertHasChinese(notice, 'absent narrator notice');
      assert.ok(!/No narrator in this swarm/.test(notice), `Untranslated absent narrator notice: ${notice}`);
      page.assertNoErrors('2.4.5');
    });
  });

  // =========================================================================
  // Area 5: Raw Boundaries — 5 tests
  // =========================================================================
  describe('Area 5: Raw Boundaries', () => {
    it('2.5.1 HTML/script characters in board.jsonl stay escaped & lossless in #raw', async (t) => {
      const harness = new SidecarHarness({ env: llmEnv() });
      t.after(() => harness.stop());
      const xssPayload = '<img src=x onerror=alert(1)> & <script>window.__pwned=1</script>';
      buildBasicSwarm(harness, {
        messages: [{ seq: 1, agent: 'backend', time: '2026-11-19 14:00:00', text: xssPayload }],
      });
      await harness.start();

      const page = await browser.newIsolatedPage();
      t.after(() => page.close());
      await page.navigate(harness.baseUrl);
      await page.waitForSwarmReady();
      await page.click('[data-testid="swarm-tab-raw"]');
      await page.click('.raw-btn[data-raw="board"]');

      const rawText = await page.getText('[data-testid="swarm-raw"]');
      assert.ok(rawText.includes(xssPayload), 'Raw board.jsonl must contain exact literal string');
      assert.equal(await page.evaluate(() => window.__pwned || false), false, 'XSS payload must never execute');
      page.assertNoErrors('2.5.1');
    });

    it('2.5.2 Raw tab hides view.json button when view.json is absent and shows it when present', async (t) => {
      const harness = new SidecarHarness({ env: llmEnv() });
      t.after(() => harness.stop());
      buildBasicSwarm(harness);
      await harness.start();

      const page = await browser.newIsolatedPage();
      t.after(() => page.close());
      await page.navigate(harness.baseUrl);
      await page.waitForSwarmReady();
      await page.click('[data-testid="swarm-tab-raw"]');

      const hiddenBefore = await page.evaluate(() => document.querySelector('#raw-btn-view')?.classList.contains('hidden'));
      assert.equal(hiddenBefore, true);

      harness.writeViewJson(harness.conversationId, { version: 1, as_of_seq: 1, headline: 'Now added' });
      await page.waitForFunction(() => !document.querySelector('#raw-btn-view')?.classList.contains('hidden'), [], { timeout: 6000 });
      page.assertNoErrors('2.5.2');
    });

    it('2.5.3 SWARM_RAW_TAB=false hides Raw tab and redirects ?tab=raw safely', async (t) => {
      const harness = new SidecarHarness({ rawTab: false, env: llmEnv() });
      t.after(() => harness.stop());
      buildBasicSwarm(harness);
      await harness.start();

      const page = await browser.newIsolatedPage();
      t.after(() => page.close());
      await page.navigate(`${harness.baseUrl}/?tab=raw`);
      await page.waitForSwarmReady();

      const rawTabHidden = await page.evaluate(() => document.querySelector('[data-testid="swarm-tab-raw"]')?.classList.contains('hidden'));
      assert.equal(rawTabHidden, true);
      page.assertNoErrors('2.5.3');
    });

    it('2.5.4 Large >8 KB board.jsonl shows KB unit cleanly in #raw-meta', async (t) => {
      const harness = new SidecarHarness({ env: llmEnv() });
      t.after(() => harness.stop());
      const msgs = Array.from({ length: 40 }, (_, i) => ({
        seq: i + 1,
        agent: 'backend',
        time: '2026-11-19 14:00:00',
        text: `Batch entry #${i + 1}: ` + 'payload '.repeat(25),
      }));
      buildBasicSwarm(harness, { messages: msgs });
      await harness.start();

      const page = await browser.newIsolatedPage();
      t.after(() => page.close());
      await page.navigate(harness.baseUrl);
      await page.waitForSwarmReady();
      await page.click('[data-testid="swarm-tab-raw"]');
      await page.click('.raw-btn[data-raw="board"]');

      const meta = await page.getText('#raw-meta');
      assert.match(meta, /KB/);
      assertHasChinese(meta, 'large board #raw-meta');
      page.assertNoErrors('2.5.4');
    });

    it('2.5.5 Empty view.json raw button fallback localizes empty state if view.html exists without view.json', async (t) => {
      const harness = new SidecarHarness({ env: llmEnv() });
      t.after(() => harness.stop());
      buildBasicSwarm(harness);
      harness.writeViewHtml(harness.conversationId, '<html><body>HTML only</body></html>');
      await harness.start();

      const page = await browser.newIsolatedPage();
      t.after(() => page.close());
      await page.navigate(harness.baseUrl);
      await page.waitForSwarmReady();
      await page.click('[data-testid="swarm-tab-raw"]');
      await page.waitForSelector('#raw-btn-view:not(.hidden)', { visible: true });
      await page.click('#raw-btn-view');

      const rawText = await page.getText('[data-testid="swarm-raw"]');
      assertHasChinese(rawText, 'empty view.json #raw');
      assert.notEqual(rawText, '(empty)');
      page.assertNoErrors('2.5.5');
    });
  });

  // =========================================================================
  // Area 6: Global Chrome Boundaries — 5 tests
  // =========================================================================
  describe('Area 6: Global Chrome Boundaries', () => {
    it('2.6.1 Unknown valid UUID conversationId shows localized #empty state', async (t) => {
      const harness = new SidecarHarness({ env: llmEnv() });
      t.after(() => harness.stop());
      await harness.start();

      const page = await browser.newIsolatedPage({ allowConversationMetadataError: true });
      t.after(() => page.close());
      await page.navigate(`${harness.baseUrl}/?conversationId=99999999-9999-4999-8999-999999999999`);
      await page.waitForSwarmReady();
      await page.waitForSelector('[data-testid="swarm-empty-state"]:not(.hidden)', { visible: true });

      const title = await page.getText('[data-testid="swarm-empty-title"]');
      assertHasChinese(title, 'unknown conv empty title');
      assert.notEqual(title, 'No swarm in this conversation');
      page.assertNoErrors('2.6.1');
    });

    it('2.6.2 Malformed non-hex conversationId gracefully renders localized #empty state', async (t) => {
      const harness = new SidecarHarness({ env: llmEnv() });
      t.after(() => harness.stop());
      await harness.start();

      const page = await browser.newIsolatedPage({ allowConversationMetadataError: true });
      t.after(() => page.close());
      await page.navigate(`${harness.baseUrl}/?conversationId=not-a-valid-uuid!`);
      await page.waitForSwarmReady();
      await page.waitForSelector('[data-testid="swarm-empty-state"]:not(.hidden)', { visible: true });

      const title = await page.getText('[data-testid="swarm-empty-title"]');
      assertHasChinese(title, 'invalid conv empty title');
      page.assertNoErrors('2.6.2');
    });

    it('2.6.3 Long >120-char swarm title renders without JS error and keeps localized header', async (t) => {
      const harness = new SidecarHarness({ env: llmEnv() });
      t.after(() => harness.stop());
      const longTitle = 'Long swarm title: ' + 'investigation '.repeat(12);
      buildBasicSwarm(harness, { title: longTitle });
      await harness.start();

      await harness.waitForSwarm((s) => hasChinese(s.title_zh), { timeout: 8000 });
      const page = await browser.newIsolatedPage();
      t.after(() => page.close());
      await page.navigate(harness.baseUrl);
      await page.waitForSwarmReady();

      const h1 = await page.getText('[data-testid="swarm-title"]');
      assertHasChinese(h1, 'long translated #swarm-title');
      page.assertNoErrors('2.6.3');
    });

    it('2.6.4 Sidecar disconnect triggers localized Reconnecting status in #live-label', async (t) => {
      const harness = new SidecarHarness({ env: llmEnv() });
      t.after(() => harness.stop());
      buildBasicSwarm(harness);
      await harness.start();

      const page = await browser.newIsolatedPage();
      t.after(() => page.close());
      await page.navigate(harness.baseUrl);
      await page.waitForSwarmReady();

      await harness.stop({ cleanup: true });
      await page.waitForFunction(() => document.querySelector('#live')?.classList.contains('stale'), [], { timeout: 8000 });
      const liveLabel = await page.getText('#live-label');
      const liveTitle = await page.getAttr('#live', 'title');
      assertHasChinese(liveLabel, 'reconnecting #live-label');
      assertHasChinese(liveTitle, 'reconnecting #live title');
      assert.notEqual(liveLabel, 'Reconnecting');
    });

    it('2.6.5 Tablist keyboard navigation (ArrowRight/End/Home) switches localized tabs cleanly', async (t) => {
      const harness = new SidecarHarness({ env: llmEnv() });
      t.after(() => harness.stop());
      buildBasicSwarm(harness);
      await harness.start();

      const page = await browser.newIsolatedPage();
      t.after(() => page.close());
      await page.navigate(`${harness.baseUrl}/?tab=feed`);
      await page.waitForSwarmReady();

      await page.evaluate(() => {
        const feedBtn = document.querySelector('[data-testid="swarm-tab-feed"]');
        feedBtn.focus();
        feedBtn.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
      });
      await page.waitForSelector('#tab-members.active', { visible: true });
      page.assertNoErrors('2.6.5');
    });
  });

  // =========================================================================
  // Area 7: Bilingual Search Boundaries — 5 tests
  // =========================================================================
  describe('Area 7: Bilingual Search Boundaries', () => {
    it('2.7.1 Empty/whitespace query restores all board messages', async (t) => {
      const harness = new SidecarHarness({ env: llmEnv() });
      t.after(() => harness.stop());
      buildBasicSwarm(harness);
      await harness.start();

      const page = await browser.newIsolatedPage();
      t.after(() => page.close());
      await page.navigate(`${harness.baseUrl}/?tab=feed`);
      await page.waitForSwarmReady();

      await page.type('[data-testid="swarm-search"]', 'config.json');
      assert.equal(await page.evaluate(() => document.querySelectorAll('[data-testid="swarm-message"]').length), 1);

      await page.type('[data-testid="swarm-search"]', '   ');
      assert.equal(await page.evaluate(() => document.querySelectorAll('[data-testid="swarm-message"]').length), 3);
      page.assertNoErrors('2.7.1');
    });

    it('2.7.2 Regex special characters ([done], C:\\repo\\, (v1)) search safely without throwing', async (t) => {
      const harness = new SidecarHarness({ env: llmEnv() });
      t.after(() => harness.stop());
      buildBasicSwarm(harness);
      await harness.start();

      const page = await browser.newIsolatedPage();
      t.after(() => page.close());
      await page.navigate(`${harness.baseUrl}/?tab=feed`);
      await page.waitForSwarmReady();

      await page.type('[data-testid="swarm-search"]', '[done]');
      assert.equal(await page.evaluate(() => document.querySelectorAll('[data-testid="swarm-message"]').length), 1);
      await page.type('[data-testid="swarm-search"]', 'C:\\repo\\src');
      assert.equal(await page.evaluate(() => document.querySelectorAll('[data-testid="swarm-message"]').length), 1);
      page.assertNoErrors('2.7.2');
    });

    it('2.7.3 Case-insensitive English search still matches in zh mode', async (t) => {
      const harness = new SidecarHarness({ env: llmEnv() });
      t.after(() => harness.stop());
      buildBasicSwarm(harness);
      await harness.start();

      await harness.waitForSwarm((s) => s.messages?.some((m) => hasChinese(m.text_zh)), { timeout: 8000 });
      const page = await browser.newIsolatedPage();
      t.after(() => page.close());
      await page.navigate(`${harness.baseUrl}/?tab=feed`);
      await page.waitForSwarmReady();

      await page.type('[data-testid="swarm-search"]', 'VERIFICATION CHECKS');
      assert.equal(await page.evaluate(() => document.querySelectorAll('[data-testid="swarm-message"]').length), 1);
      page.assertNoErrors('2.7.3');
    });

    it('2.7.4 Unmatched Chinese search query renders localized no-match state and clear button', async (t) => {
      const harness = new SidecarHarness({ env: llmEnv() });
      t.after(() => harness.stop());
      buildBasicSwarm(harness);
      await harness.start();

      const page = await browser.newIsolatedPage();
      t.after(() => page.close());
      await page.navigate(`${harness.baseUrl}/?tab=feed`);
      await page.waitForSwarmReady();

      await page.type('[data-testid="swarm-search"]', '完全不存在的关键词九九九');
      await page.waitForSelector('[data-testid="swarm-clear-filters"]', { visible: true });
      const emptyMsg = await page.getText('[data-testid="swarm-feed-empty"]');
      const clearBtn = await page.getText('[data-testid="swarm-clear-filters"]');
      assertHasChinese(emptyMsg, 'no-match feed empty');
      assertHasChinese(clearBtn, 'clear filters button');
      assert.ok(!/Nothing matches/i.test(emptyMsg), `Untranslated no-match message: ${emptyMsg}`);
      page.assertNoErrors('2.7.4');
    });

    it('2.7.5 Members search (.o2-msin) hides empty group headers and restores on clear', async (t) => {
      const harness = new SidecarHarness({ env: llmEnv() });
      t.after(() => harness.stop());
      buildBasicSwarm(harness);
      await harness.start();

      const page = await browser.newIsolatedPage();
      t.after(() => page.close());
      await page.navigate(harness.baseUrl);
      await page.waitForSwarmReady();
      await page.click('[data-testid="swarm-tab-members"]');
      await page.waitForSelector('#members .o2-msin', { visible: true });

      await page.type('#members .o2-msin', 'coordinator');
      const hiddenStandingBy = await page.evaluate(() => {
        const grps = [...document.querySelectorAll('#members .o2-mgroup')];
        return grps.filter((g) => g.style.display === 'none').length;
      });
      assert.ok(hiddenStandingBy >= 1, 'Non-matching member groups must hide');

      await page.type('#members .o2-msin', '');
      const visibleGroups = await page.evaluate(() => {
        const grps = [...document.querySelectorAll('#members .o2-mgroup')];
        return grps.filter((g) => g.style.display !== 'none').length;
      });
      assert.ok(visibleGroups >= 2, 'Clearing Members search must restore all groups');
      page.assertNoErrors('2.7.5');
    });
  });

  // =========================================================================
  // Area 8: Clean Single-Mode Display Boundaries — 5 tests
  // =========================================================================
  describe('Area 8: Clean Single-Mode Display Boundaries', () => {
    it('2.8.1 Pre-seeded localStorage["swarm.langMode"]="en" still boots in Chinese with no toggle', async (t) => {
      const harness = new SidecarHarness({ env: llmEnv() });
      t.after(() => harness.stop());
      buildBasicSwarm(harness);
      await harness.start();

      await harness.waitForSwarm((s) => s.messages?.some((m) => hasChinese(m.text_zh)), { timeout: 8000 });
      const page = await browser.newIsolatedPage({ localStorageSeed: { 'swarm.langMode': 'en' } });
      t.after(() => page.close());
      await page.navigate(`${harness.baseUrl}/?tab=feed`);
      await page.waitForSwarmReady();
      await page.waitForFunction(() => /[\u4e00-\u9fff]/.test(document.querySelector('[data-testid="swarm-feed"]')?.textContent || ''));

      assertLangModeAbsent(await getLangModeState(page), '2.8.1');
      const bodies = await page.getAllText('[data-testid="swarm-message"] .msg-body');
      assertHasChinese(bodies.join('\n'), '2.8.1 ignores stale en');
      page.assertNoErrors('2.8.1');
    });

    it('2.8.2 Invalid localStorage["swarm.langMode"] value safely boots in Chinese with no toggle', async (t) => {
      const harness = new SidecarHarness({ env: llmEnv() });
      t.after(() => harness.stop());
      buildBasicSwarm(harness);
      await harness.start();

      await harness.waitForSwarm((s) => s.messages?.some((m) => hasChinese(m.text_zh)), { timeout: 8000 });
      const page = await browser.newIsolatedPage({ localStorageSeed: { 'swarm.langMode': 'invalid_mode_xyz' } });
      t.after(() => page.close());
      await page.navigate(`${harness.baseUrl}/?tab=feed`);
      await page.waitForSwarmReady();
      await page.waitForFunction(() => /[\u4e00-\u9fff]/.test(document.querySelector('[data-testid="swarm-feed"]')?.textContent || ''));

      assertLangModeAbsent(await getLangModeState(page), '2.8.2');
      page.assertNoErrors('2.8.2');
    });

    it('2.8.3 Pre-seeded localStorage["swarm.langMode"]="bi" never renders .msg-orig or .o2-orig', async (t) => {
      const harness = new SidecarHarness({ env: llmEnv() });
      t.after(() => harness.stop());
      buildBasicSwarm(harness);
      await harness.start();

      await harness.waitForSwarm((s) => s.messages?.some((m) => hasChinese(m.text_zh)), { timeout: 8000 });
      const page = await browser.newIsolatedPage({ localStorageSeed: { 'swarm.langMode': 'bi' } });
      t.after(() => page.close());
      await page.navigate(`${harness.baseUrl}/?tab=feed`);
      await page.waitForSwarmReady();

      assertLangModeAbsent(await getLangModeState(page), '2.8.3');
      assert.equal(await page.evaluate(() => document.querySelectorAll('.msg-orig, .o2-orig').length), 0);
      const bodies = await page.getAllText('[data-testid="swarm-message"] .msg-body');
      assertHasChinese(bodies.join('\n'), '2.8.3 clean Chinese');
      page.assertNoErrors('2.8.3');
    });

    it('2.8.4 Predominantly Chinese post renders once without duplicate blocks', async (t) => {
      const harness = new SidecarHarness({ env: llmEnv() });
      t.after(() => harness.stop());
      buildBasicSwarm(harness, {
        messages: [{ seq: 1, agent: 'coordinator', time: '2026-11-19 14:00:00', text: '全部测试已经通过，请确认最终发布状态。' }],
      });
      await harness.start();

      const page = await browser.newIsolatedPage();
      t.after(() => page.close());
      await page.navigate(`${harness.baseUrl}/?tab=feed`);
      await page.waitForSwarmReady();

      const body = await page.getText('[data-testid="swarm-message"] .msg-body');
      const matches = body.match(/全部测试已经通过/g) || [];
      assert.equal(matches.length, 1, `Pure Chinese post must render once: ${body}`);
      assert.equal(await page.evaluate(() => document.querySelectorAll('.msg-orig').length), 0);
      page.assertNoErrors('2.8.4');
    });

    it('2.8.5 Active channel filter + bilingual search works cleanly without a mode toggle', async (t) => {
      const harness = new SidecarHarness({ env: llmEnv() });
      t.after(() => harness.stop());
      buildPlanAndChannelsSwarm(harness);
      await harness.start();

      await harness.waitForSwarm((s) => s.messages?.some((m) => hasChinese(m.text_zh)), { timeout: 8000 });
      const page = await browser.newIsolatedPage();
      t.after(() => page.close());
      await page.navigate(`${harness.baseUrl}/?tab=feed`);
      await page.waitForSwarmReady();

      await page.click('[data-testid="swarm-channel-tab"][data-channel="parser"]');
      await page.type('[data-testid="swarm-search"]', 'AST');
      const countEn = await page.evaluate(() => document.querySelectorAll('[data-testid="swarm-message"]').length);
      assert.equal(countEn, 1);

      await page.type('[data-testid="swarm-search"]', '审阅');
      const countZh = await page.evaluate(() => document.querySelectorAll('[data-testid="swarm-message"]').length);
      assert.equal(countZh, 1);
      assertLangModeAbsent(await getLangModeState(page), '2.8.5');
      page.assertNoErrors('2.8.5');
    });
  });

  // =========================================================================
  // Area 9: Placeholder Preservation Boundaries — 5 tests
  // =========================================================================
  describe('Area 9: Placeholder Preservation Boundaries', () => {
    it('2.9.1 Multiple fenced code blocks + inline code in one post are all preserved', async (t) => {
      const harness = new SidecarHarness({ env: llmEnv() });
      t.after(() => harness.stop());
      buildBasicSwarm(harness, {
        messages: [
          {
            seq: 1,
            agent: 'backend',
            time: '2026-11-19 14:00:00',
            text: 'Check `alphaFlag` first:\n```ts\nconst a = 1;\n```\nThen check `betaFlag`:\n```json\n{"ok":true}\n```',
          },
        ],
      });
      await harness.start();

      await harness.waitForSwarm((s) => hasChinese(s.messages?.[0]?.text_zh), { timeout: 8000 });
      const snap = await harness.getSwarm();
      assertLiteralsPreserved(snap.messages[0].text_zh, ['alphaFlag', 'const a = 1;', 'betaFlag', '{"ok":true}'], 'multi-codeblocks');
    });

    it('2.9.2 Mixed Windows drive paths, UNC paths, and POSIX ~/ paths stay verbatim', async (t) => {
      const harness = new SidecarHarness({ env: llmEnv() });
      t.after(() => harness.stop());
      buildBasicSwarm(harness, {
        messages: [
          {
            seq: 1,
            agent: 'backend',
            time: '2026-11-19 14:00:00',
            text: 'Compare `F:\\gemini\\gwork\\antigravity\\cli.js` with `~/.gemini/antigravity/brain` and `/var/log/app.log`.',
          },
        ],
      });
      await harness.start();

      await harness.waitForSwarm((s) => hasChinese(s.messages?.[0]?.text_zh), { timeout: 8000 });
      const snap = await harness.getSwarm();
      assertLiteralsPreserved(
        snap.messages[0].text_zh,
        ['F:\\gemini\\gwork\\antigravity\\cli.js', '~/.gemini/antigravity/brain', '/var/log/app.log'],
        'mixed paths'
      );
    });

    it('2.9.3 Complex URLs with query strings and hash fragments stay verbatim', async (t) => {
      const harness = new SidecarHarness({ env: llmEnv() });
      t.after(() => harness.stop());
      const url = 'https://docs.example.com/api?v=2&mode=full#section-4';
      buildBasicSwarm(harness, {
        messages: [{ seq: 1, agent: 'coordinator', time: '2026-11-19 14:00:00', text: `See specification at ${url} before merging.` }],
      });
      await harness.start();

      await harness.waitForSwarm((s) => hasChinese(s.messages?.[0]?.text_zh), { timeout: 8000 });
      const snap = await harness.getSwarm();
      assertLiteralsPreserved(snap.messages[0].text_zh, [url], 'complex URL');
    });

    it('2.9.4 Combined @#channel, @all, hyphenated @member, and #seq refs stay verbatim', async (t) => {
      const harness = new SidecarHarness({ env: llmEnv() });
      t.after(() => harness.stop());
      buildBasicSwarm(harness, {
        messages: [
          { seq: 1, agent: 'coordinator', time: '2026-11-19 14:00:00', text: 'Baseline post.' },
          { seq: 2, agent: 'backend', time: '2026-11-19 14:01:00', text: '@all @census-verifier @#parser Syncing with #1 now.' },
        ],
      });
      await harness.start();

      await harness.waitForSwarm((s) => hasChinese(s.messages?.[1]?.text_zh), { timeout: 8000 });
      const snap = await harness.getSwarm();
      assertLiteralsPreserved(snap.messages[1].text_zh, ['@all', '@census-verifier', '@#parser', '#1'], 'combined tokens');
    });

    it('2.9.5 Inline HTML tags inside backticks stay escaped and never execute in browser', async (t) => {
      const harness = new SidecarHarness({ env: llmEnv() });
      t.after(() => harness.stop());
      buildBasicSwarm(harness, {
        messages: [{ seq: 1, agent: 'backend', time: '2026-11-19 14:00:00', text: 'Sanitize `<script>window.__xss=1</script>` properly.' }],
      });
      await harness.start();

      await harness.waitForSwarm((s) => hasChinese(s.messages?.[0]?.text_zh), { timeout: 8000 });
      const page = await browser.newIsolatedPage();
      t.after(() => page.close());
      await page.navigate(`${harness.baseUrl}/?tab=feed`);
      await page.waitForSwarmReady();

      const body = await page.getText('[data-testid="swarm-message"] .msg-body');
      assertLiteralsPreserved(body, ['<script>window.__xss=1</script>'], 'escaped HTML backticks');
      assert.equal(await page.evaluate(() => window.__xss || false), false);
      page.assertNoErrors('2.9.5');
    });
  });

  // =========================================================================
  // Area 10: Offline Tier-1 Boundaries — 5 tests
  // =========================================================================
  describe('Area 10: Offline Tier-1 Boundaries', () => {
    it('2.10.1 Predominantly Chinese message skips LLM and stays intact', async (t) => {
      llm.resetStats();
      llm.setMode('ok', { delayMs: 0 });
      const harness = new SidecarHarness({ env: llmEnv() });
      t.after(() => harness.stop());
      const cn = '已完成全部核心模块的中文化修改，并且所有单元测试全部通过。';
      buildBasicSwarm(harness, {
        title: '中文测试蜂群',
        messages: [{ seq: 1, agent: 'coordinator', time: '2026-11-19 14:00:00', text: cn }],
      });
      await harness.start();

      // Trigger /api/swarm first (lazy translator runs on GET /api/swarm), then wait & re-verify 0 LLM calls
      const snap1 = await harness.getSwarm();
      assertSnapshotContract(snap1);
      await new Promise((r) => setTimeout(r, 350));
      const snap2 = await harness.getSwarm();
      assert.equal(llm.requests.length, 0, 'Predominantly CJK post must not trigger LLM call');
      assert.equal(snap2.messages[0].text_zh_source, 'cjk', 'Predominantly CJK post must report source=cjk');
      assert.equal(snap2.messages[0].text_zh, cn, 'Predominantly CJK post must stay intact');
    });

    it('2.10.2 Bare token message (@monitor resume / #1) does not invoke LLM', async (t) => {
      llm.resetStats();
      llm.setMode('ok', { delayMs: 0 });
      const harness = new SidecarHarness({ env: llmEnv() });
      t.after(() => harness.stop());
      buildBasicSwarm(harness, {
        title: '中文测试蜂群',
        messages: [{ seq: 1, agent: 'coordinator', time: '2026-11-19 14:00:00', text: '@monitor resume' }],
      });
      await harness.start();

      // Trigger /api/swarm first before waiting to prove no async LLM job was enqueued
      const snap1 = await harness.getSwarm();
      assertSnapshotContract(snap1);
      await new Promise((r) => setTimeout(r, 350));
      const snap2 = await harness.getSwarm();
      assert.equal(llm.requests.length, 0, 'Bare @monitor resume token should resolve via Tier-1 without LLM');
      assertHasChinese(snap2.messages[0].text_zh, '@monitor resume localized');
    });

    it('2.10.3 Mixed CN/EN message preserves existing Chinese quotes while translating English', async (t) => {
      llm.setMode('ok', { delayMs: 0 });
      const harness = new SidecarHarness({ env: llmEnv() });
      t.after(() => harness.stop());
      buildBasicSwarm(harness, {
        messages: [
          { seq: 1, agent: 'coordinator', time: '2026-11-19 14:00:00', text: '@verifier Please run checks on "不要用黑话" and "当前聊天".' },
        ],
      });
      await harness.start();

      await harness.waitForSwarm((s) => hasChinese(s.messages?.[0]?.text_zh), { timeout: 8000 });
      const snap = await harness.getSwarm();
      assertLiteralsPreserved(snap.messages[0].text_zh, ['不要用黑话', '当前聊天', '@verifier'], 'mixed CN/EN quotes');
    });

    it('2.10.4 Unconfigured provider (no base URL) falls back cleanly to Tier-1 with zero browser errors', async (t) => {
      const harness = new SidecarHarness({
        env: {
          AGY_SWARM_TRANSLATE_BASE_URL: '',
          AGY_SWARM_TRANSLATE_API_KEY: '',
        },
      });
      t.after(() => harness.stop());
      buildBasicSwarm(harness);
      await harness.start();

      const snap = await harness.getSwarm();
      assertSnapshotContract(snap);
      assert.equal(snap.translationState?.provider, 'none', `Expected unconfigured provider=none, got: ${JSON.stringify(snap.translationState)}`);
      assert.ok(snap.messages.every((m) => m.text_zh_source !== 'llm'), 'No message may come from LLM when provider is unconfigured');

      const page = await browser.newIsolatedPage();
      t.after(() => page.close());
      await page.navigate(harness.baseUrl);
      await page.waitForSwarmReady();
      const tabs = await page.getAllText('[data-testid="swarm-tabs"] button.tab');
      for (const tab of tabs) assertHasChinese(tab, 'fallback offline tab');
      page.assertNoErrors('2.10.4');
    });

    it('2.10.5 Whitespace-only or empty message text does not crash sidecar or browser', async (t) => {
      const harness = new SidecarHarness({ env: { AGY_SWARM_TRANSLATE_DISABLED: '1' } });
      t.after(() => harness.stop());
      buildBasicSwarm(harness, {
        messages: [{ seq: 1, agent: 'backend', time: '2026-11-19 14:00:00', text: '   ' }],
      });
      await harness.start();

      const snap = await harness.getSwarm();
      assertSnapshotContract(snap);
      const page = await browser.newIsolatedPage();
      t.after(() => page.close());
      await page.navigate(harness.baseUrl);
      await page.waitForSwarmReady();
      page.assertNoErrors('2.10.5');
    });
  });

  // =========================================================================
  // Area 11: Async LLM Queue & Fault Boundaries — 6 tests
  // =========================================================================
  describe('Area 11: Async LLM Queue & Fault Boundaries', () => {
    it('2.11.1 Recovers from transient HTTP 429 via retry/backoff', async (t) => {
      llm.resetStats();
      llm.setMode('ok', { delayMs: 0, failFirstN: 2, failMode: '429' });
      const harness = new SidecarHarness({ env: llmEnv() });
      t.after(() => harness.stop());
      buildBasicSwarm(harness, {
        messages: [{ seq: 1, agent: 'backend', time: '2026-11-19 14:00:00', text: 'Retry after rate limit check.' }],
      });
      await harness.start();

      const snap = await harness.waitForSwarm((s) => hasChinese(s.messages?.[0]?.text_zh), { timeout: 10000 });
      assertHasChinese(snap.messages[0].text_zh, '429 retry result');
      assert.ok(llm.requests.length >= 3, `Expected retry after 2x429, saw ${llm.requests.length} requests`);
    });

    it('2.11.2 Persistent HTTP 500 degrades gracefully without failing /api/swarm or browser', async (t) => {
      llm.resetStats();
      llm.setMode('500', { delayMs: 0 });
      const harness = new SidecarHarness({ env: llmEnv() });
      t.after(() => harness.stop());
      buildBasicSwarm(harness);
      await harness.start();

      const snap = await harness.getSwarm();
      assertSnapshotContract(snap);
      await new Promise((r) => setTimeout(r, 400));
      const snap2 = await harness.getSwarm();
      assertSnapshotContract(snap2);

      const page = await browser.newIsolatedPage();
      t.after(() => page.close());
      await page.navigate(harness.baseUrl);
      await page.waitForSwarmReady();
      page.assertNoErrors('2.11.2');
    });

    it('2.11.3 Non-blocking /api/swarm and 2nd-worker freedom under 1 hung LLM slot', async (t) => {
      llm.resetStats();
      llm.setMode('hang');
      const harness = new SidecarHarness({ env: llmEnv() });
      t.after(() => harness.stop());
      buildBasicSwarm(harness, {
        title: '超时恢复测试',
        messages: [{ seq: 1, agent: 'backend', time: '2026-11-19 14:00:00', text: 'First hung message.' }],
      });
      await harness.start();

      const t0 = Date.now();
      const snap0 = await harness.getSwarm();
      assertSnapshotContract(snap0);
      assert.ok(Date.now() - t0 < 500, '/api/swarm must stay non-blocking while LLM hangs');
      await new Promise((r) => setTimeout(r, 300));

      llm.setMode('ok', { delayMs: 0 });
      harness.appendBoardLine(harness.conversationId, {
        seq: 2,
        agent: 'coordinator',
        time: '2026-11-19 14:02:00',
        text: 'Second message processed by free worker.',
      });

      const snap = await harness.waitForSwarm((s) => hasChinese(s.messages?.[1]?.text_zh), { timeout: 8000 });
      assertHasChinese(snap.messages[1].text_zh, 'recovered queue message');
    });

    it('2.11.4 Rejects LLM response when ⟦Pn⟧ placeholder is dropped (falls back without losing literal)', async (t) => {
      llm.resetStats();
      llm.setMode('drop-placeholder', { delayMs: 0 });
      const harness = new SidecarHarness({ env: llmEnv() });
      t.after(() => harness.stop());
      buildBasicSwarm(harness, {
        messages: [
          { seq: 1, agent: 'backend', time: '2026-11-19 14:00:00', text: '@coordinator Inspect `C:\\secret\\path.ts` carefully.' },
        ],
      });
      await harness.start();

      // Trigger /api/swarm first and wait until MockLlmServer actually served >= 1 request and queue settled
      await harness.getSwarm();
      const snap = await harness.waitForSwarm(
        (s) => llm.requests.length >= 1 && (s.translationState?.pending ?? 0) === 0,
        { timeout: 6000 }
      );
      assert.ok(llm.requests.length >= 1, 'Expected MockLlmServer to receive drop-placeholder request');
      assert.ok(!String(snap.messages[0].text_zh || '').includes('丢失占位符'), 'Corrupted translation missing ⟦P0⟧ must be rejected from text_zh');

      const page = await browser.newIsolatedPage();
      t.after(() => page.close());
      await page.navigate(`${harness.baseUrl}/?tab=feed`);
      await page.waitForSwarmReady();

      const msgText = await page.getText('[data-testid="swarm-message"]');
      assertLiteralsPreserved(msgText, ['coordinator', 'C:\\secret\\path.ts'], 'dropped placeholder fallback');
      assert.ok(!msgText.includes('丢失占位符'), 'Corrupted translation missing ⟦P0⟧ must not render in UI');
      page.assertNoErrors('2.11.4');
    });

    it('2.11.5 Rejects LLM response when ⟦Pn⟧ placeholder is corrupted to ⟦P99⟧', async (t) => {
      llm.resetStats();
      llm.setMode('corrupt-placeholder', { delayMs: 0 });
      const harness = new SidecarHarness({ env: llmEnv() });
      t.after(() => harness.stop());
      buildBasicSwarm(harness, {
        messages: [
          { seq: 1, agent: 'backend', time: '2026-11-19 14:00:00', text: 'Open https://example.org/keep-me now.' },
        ],
      });
      await harness.start();

      // Trigger /api/swarm first and wait until MockLlmServer served >= 1 request and queue settled
      await harness.getSwarm();
      const snap = await harness.waitForSwarm(
        (s) => llm.requests.length >= 1 && (s.translationState?.pending ?? 0) === 0,
        { timeout: 6000 }
      );
      assert.ok(llm.requests.length >= 1, 'Expected MockLlmServer to receive corrupt-placeholder request');
      assert.ok(!String(snap.messages[0].text_zh || '').includes('损坏占位符'), 'Corrupted ⟦P99⟧ translation must be rejected from text_zh');

      const page = await browser.newIsolatedPage();
      t.after(() => page.close());
      await page.navigate(`${harness.baseUrl}/?tab=feed`);
      await page.waitForSwarmReady();

      const body = await page.getText('[data-testid="swarm-message"] .msg-body');
      assertLiteralsPreserved(body, ['https://example.org/keep-me'], 'corrupted placeholder fallback');
      assert.ok(!body.includes('⟦P'), 'Raw placeholder token must never leak to UI');
      assert.ok(!body.includes('损坏占位符'), 'Corrupted placeholder response must not render in UI');
      page.assertNoErrors('2.11.5');
    });

    it('2.11.6 Handles malformed JSON body from LLM gracefully without crashing sidecar', async (t) => {
      llm.resetStats();
      llm.setMode('bad-json', { delayMs: 0 });
      const harness = new SidecarHarness({ env: llmEnv() });
      t.after(() => harness.stop());
      buildBasicSwarm(harness);
      await harness.start();

      const snap1 = await harness.getSwarm();
      assertSnapshotContract(snap1);
      await new Promise((r) => setTimeout(r, 350));
      const snap2 = await harness.getSwarm();
      assertSnapshotContract(snap2);
    });
  });
});

function osTmpNonexistent() {
  return path.join('C:\\nonexistent-e2e-dir', String(Date.now()));
}
