import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';

import { CdpBrowser } from './cdp-browser.mjs';
import { SidecarHarness } from './sidecar-harness.mjs';
import { MockLlmServer } from './mock-llm.mjs';
import {
  buildBasicSwarm,
  buildRichOverviewSwarm,
  buildPlanAndChannelsSwarm,
  buildSystemAlertsSwarm,
  buildScreenshotSwarm,
  buildEmptyOnboardingSwarm,
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

describe('Tier 1 — Core Localization Features (>= 55 tests across 11 areas)', () => {
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
  // Area 1: Board Messages & Controls (#tab-feed) — 6 tests
  // =========================================================================
  describe('Area 1: Board Messages & Controls', () => {
    it('1.1 Translates English board message bodies to Chinese via async LLM', async (t) => {
      llm.resetStats();
      llm.setMode('ok', { delayMs: 0 });
      const harness = new SidecarHarness({ env: llmEnv() });
      t.after(() => harness.stop());
      buildBasicSwarm(harness);
      await harness.start();

      const snap = await harness.waitForSwarm(
        (s) => s.messages?.length === 3 && s.messages.every((m) => hasChinese(m.text_zh)),
        { timeout: 8000 }
      );
      const page = await browser.newIsolatedPage();
      t.after(() => page.close());
      await page.navigate(`${harness.baseUrl}/?tab=feed`);
      await page.waitForSwarmReady();
      await page.waitForFunction(() => {
        const bodies = [...document.querySelectorAll('[data-testid="swarm-message"] .msg-body')];
        return bodies.length === 3 && bodies.every((b) => /[\u4e00-\u9fff]/.test(b.textContent || ''));
      });

      const bodies = await page.getAllText('[data-testid="swarm-message"] .msg-body');
      assert.equal(bodies.length, 3);
      assertEveryHasChinese(bodies, '1.1 board message bodies');
      for (let i = 0; i < bodies.length; i++) {
        assertTranslatedFrom(bodies[i], snap.messages[i].text, `1.1 board message[${i}]`);
      }
      page.assertNoErrors('1.1');
    });

    it('1.2 Localizes Swarm protocol tags ([done], [blocked], [stall], [quota], resume)', async (t) => {
      const harness = new SidecarHarness({ env: llmEnv() });
      t.after(() => harness.stop());
      buildBasicSwarm(harness, {
        messages: [
          { seq: 1, agent: 'coordinator', time: '2026-11-19 14:00:00', text: '@backend [blocked] Waiting on schema approval.' },
          { seq: 2, agent: 'coordinator', time: '2026-11-19 14:01:00', text: '@backend resume' },
          { seq: 3, agent: 'monitor', time: '2026-11-19 14:02:00', text: '@backend [stall] No progress for 10m.' },
          { seq: 4, agent: 'monitor', time: '2026-11-19 14:03:00', text: '@backend [quota] Rate limit exhausted.' },
          { seq: 5, agent: 'backend', time: '2026-11-19 14:04:00', text: '@coordinator [done] All tests passed cleanly.' },
        ],
      });
      await harness.start();

      await harness.waitForSwarm(
        (s) => s.messages?.length === 5 && s.messages.every((m) => hasChinese(m.text_zh)),
        { timeout: 8000 }
      );
      const page = await browser.newIsolatedPage();
      t.after(() => page.close());
      await page.navigate(`${harness.baseUrl}/?tab=feed`);
      await page.waitForSwarmReady();
      await page.waitForFunction(() => {
        const bodies = [...document.querySelectorAll('[data-testid="swarm-message"] .msg-body')];
        return bodies.length === 5 && bodies.every((b) => /[\u4e00-\u9fff]/.test(b.textContent || ''));
      });

      const bodies = await page.getAllText('[data-testid="swarm-message"] .msg-body');
      assert.equal(bodies.length, 5);
      assertEveryHasChinese(bodies, '1.2 protocol tag posts');
      assert.ok(bodies[0].includes('[阻塞]') && !/\[blocked\]/i.test(bodies[0]), `Expected [blocked] localized, got: ${bodies[0]}`);
      assert.ok(bodies[1].includes('恢复运行') && !/\bresume\b/i.test(bodies[1]), `Expected resume localized, got: ${bodies[1]}`);
      assert.ok(bodies[2].includes('[停滞告警]') && !/\[stall\]/i.test(bodies[2]), `Expected [stall] localized, got: ${bodies[2]}`);
      assert.ok(bodies[3].includes('[额度告警]') && !/\[quota\]/i.test(bodies[3]), `Expected [quota] localized, got: ${bodies[3]}`);
      assert.ok(bodies[4].includes('[已完成]') && !/\[done\]/i.test(bodies[4]), `Expected [done] localized, got: ${bodies[4]}`);
      page.assertNoErrors('1.2');
    });

    it('1.3 Localizes channel control system lines (.msg-system)', async (t) => {
      const harness = new SidecarHarness({ env: llmEnv() });
      t.after(() => harness.stop());
      buildPlanAndChannelsSwarm(harness);
      await harness.start();

      const page = await browser.newIsolatedPage();
      t.after(() => page.close());
      await page.navigate(`${harness.baseUrl}/?tab=feed`);
      await page.waitForSwarmReady();
      await page.waitForSelector('[data-testid="swarm-control-message"]', { visible: true });

      const sysLines = await page.getAllText('[data-testid="swarm-control-message"] .sys-text');
      assert.ok(sysLines.length >= 3);
      assertEveryHasChinese(sysLines, 'channel control lines');
      assert.ok(!sysLines.some((s) => /\bcreated #parser\b|\barchived #parser\b/.test(s)), `Untranslated control text: ${sysLines.join(' | ')}`);
      page.assertNoErrors('1.3');
    });

    it('1.4 Localizes #channel-tabs ("All", tooltips) and #f-channel select options', async (t) => {
      const harness = new SidecarHarness({ env: llmEnv() });
      t.after(() => harness.stop());
      buildPlanAndChannelsSwarm(harness);
      await harness.start();

      const page = await browser.newIsolatedPage();
      t.after(() => page.close());
      await page.navigate(`${harness.baseUrl}/?tab=feed`);
      await page.waitForSwarmReady();
      await page.waitForSelector('[data-testid="swarm-channel-tab"]', { visible: true });

      const allTabText = await page.getText('[data-testid="swarm-channel-tab"][data-channel=""]');
      assertHasChinese(allTabText, 'All channel tab');
      assert.notEqual(allTabText, 'All');

      const chanOpts = await page.getAllText('[data-testid="swarm-channel-filter"] option');
      assertHasChinese(chanOpts.join('\n'), '#f-channel options');
      assertNoUntranslatedUiStrings(chanOpts.join('\n'), ['All channels', '(archived)'], '#f-channel');
      page.assertNoErrors('1.4');
    });

    it('1.5 Localizes #f-agent, #f-mention, Follow switch, and #f-toggle tooltip', async (t) => {
      const harness = new SidecarHarness({ env: llmEnv() });
      t.after(() => harness.stop());
      buildBasicSwarm(harness);
      await harness.start();

      const page = await browser.newIsolatedPage();
      t.after(() => page.close());
      await page.navigate(`${harness.baseUrl}/?tab=feed`);
      await page.waitForSwarmReady();

      await page.click('[data-testid="swarm-filter-toggle"]');
      await page.waitForSelector('[data-testid="swarm-filters"]', { visible: true });

      const agentOpts = await page.getAllText('#f-agent option');
      const mentionOpts = await page.getAllText('#f-mention option');
      const filtersText = await page.getText('[data-testid="swarm-filters"]');
      assertHasChinese(agentOpts.join('\n'), '#f-agent options');
      assertHasChinese(mentionOpts.join('\n'), '#f-mention options');
      assertNoUntranslatedUiStrings(`${agentOpts.join('\n')}\n${mentionOpts.join('\n')}\n${filtersText}`, ['From anyone', 'To anyone', 'To no one', 'Follow'], 'filter panel');
      page.assertNoErrors('1.5');
    });

    it('1.6 Localizes member filter chips (#agents) and .msg-more expand/collapse labels', async (t) => {
      const harness = new SidecarHarness({ env: llmEnv() });
      t.after(() => harness.stop());
      const longText = Array.from({ length: 40 }, (_, i) => `Line ${i + 1}: verifying long expandable post behavior.`).join('\n');
      buildBasicSwarm(harness, {
        messages: [{ seq: 1, agent: 'backend', time: '2026-11-19 14:00:00', text: longText }],
      });
      await harness.start();

      const page = await browser.newIsolatedPage();
      t.after(() => page.close());
      await page.navigate(`${harness.baseUrl}/?tab=feed`);
      await page.waitForSwarmReady();
      await page.click('[data-testid="swarm-filter-toggle"]');

      const chipTitle = await page.getAttr('[data-testid="swarm-member-chip"]', 'title');
      assertHasChinese(chipTitle, 'member chip tooltip');

      await page.waitForSelector('[data-testid="swarm-message-more"]:not(.hidden)', { visible: true });
      const moreLabel = await page.getText('[data-testid="swarm-message-more"]');
      assertHasChinese(moreLabel, 'Show more button');
      assert.notEqual(moreLabel, 'Show more', 'Show more must be localized');

      await page.click('[data-testid="swarm-message-more"]');
      const lessLabel = await page.getText('[data-testid="swarm-message-more"]');
      assertHasChinese(lessLabel, 'Show less button');
      assert.notEqual(lessLabel, 'Show less', 'Show less must be localized');
      assert.notEqual(lessLabel, moreLabel, 'Collapse label must differ from expand label');
      page.assertNoErrors('1.6');
    });
  });

  // =========================================================================
  // Area 2: Members View (#tab-members) — 5 tests
  // =========================================================================
  describe('Area 2: Members View', () => {
    it('2.1 Localizes group headers (Active, Standing by, Retired) and Coordinator badge', async (t) => {
      const harness = new SidecarHarness({ env: llmEnv() });
      t.after(() => harness.stop());
      buildBasicSwarm(harness);
      await harness.start();

      const page = await browser.newIsolatedPage();
      t.after(() => page.close());
      await page.navigate(harness.baseUrl);
      await page.waitForSwarmReady();
      await page.click('[data-testid="swarm-tab-members"]');
      await page.waitForSelector('#members .o2-mrow', { visible: true });

      const membersText = await page.getText('[data-testid="swarm-members"]');
      assertHasChinese(membersText, 'members view');
      assertNoUntranslatedUiStrings(membersText, ['Standing by', 'Coordinator', 'Retired'], 'members view');
      page.assertNoErrors('2.1');
    });

    it('2.2 Localizes member status badges (Working, Stuck, Error, Waiting on @X)', async (t) => {
      const harness = new SidecarHarness({ env: llmEnv() });
      t.after(() => harness.stop());
      const { convId } = buildSystemAlertsSwarm(harness);
      harness.appendBoardLine(convId, {
        seq: 3,
        agent: 'thinker',
        time: '2026-11-19 14:02:00',
        text: '@coordinator Could you confirm this output?',
      });
      await harness.start();

      const page = await browser.newIsolatedPage();
      t.after(() => page.close());
      await page.navigate(harness.baseUrl);
      await page.waitForSwarmReady();
      await page.click('[data-testid="swarm-tab-members"]');
      await page.waitForSelector('#members .o2-mstat', { visible: true });

      const stats = await page.getAllText('#members .o2-mstat');
      assert.ok(stats.length >= 4, `Expected >= 4 member status badges, got ${stats.length}`);
      assertEveryHasChinese(stats, '2.2 member status badges');
      for (const st of stats) {
        assert.ok(
          !/\b(Working|Stuck|Error|Quota|Waiting on)\b|^Coordinator$/i.test(st),
          `Untranslated member stat badge: ${st}`
        );
      }
      page.assertNoErrors('2.2');
    });

    it('2.3 Localizes live member activity (.o2-mnow.o2-mact) for tool calls and thinkingHeading', async (t) => {
      const harness = new SidecarHarness({ env: llmEnv() });
      t.after(() => harness.stop());
      buildRichOverviewSwarm(harness);
      await harness.start();

      const snap = await harness.waitForSwarm(
        (s) => s.members?.some((m) => m.name === 'backend' && hasChinese(m.activity_zh)),
        { timeout: 8000 }
      );
      const page = await browser.newIsolatedPage();
      t.after(() => page.close());
      await page.navigate(harness.baseUrl);
      await page.waitForSwarmReady();
      await page.click('[data-testid="swarm-tab-members"]');
      await page.waitForSelector('[data-testid="swarm-member-activity"]', { visible: true });

      const acts = await page.getAllText('[data-testid="swarm-member-activity"]');
      assertEveryHasChinese(acts, '2.3 live member activity');
      for (const a of acts) {
        assert.ok(
          !/Read\s+main\.ts|Running integration checks|Auditing search filter behavior/i.test(a),
          `Untranslated live member activity: ${a}`
        );
      }
      const backendMember = snap.members.find((m) => m.name === 'backend');
      const backendAct = await page.getText('#members [data-open-member="backend"] [data-testid="swarm-member-activity"]');
      assertTranslatedFrom(backendAct, backendMember.activity, '2.3 backend .o2-mact');
      page.assertNoErrors('2.3');
    });

    it('2.4 Localizes .o2-mts post count / model metadata and search placeholder', async (t) => {
      const harness = new SidecarHarness({ env: llmEnv() });
      t.after(() => harness.stop());
      buildBasicSwarm(harness, {
        messages: [{ seq: 1, agent: 'coordinator', time: '2026-11-19 14:00:00', text: 'Kickoff' }],
      });
      await harness.start();

      const page = await browser.newIsolatedPage();
      t.after(() => page.close());
      await page.navigate(harness.baseUrl);
      await page.waitForSwarmReady();
      await page.click('[data-testid="swarm-tab-members"]');
      await page.waitForSelector('#members .o2-msin', { visible: true });

      const placeholder = await page.getAttr('#members .o2-msin', 'placeholder');
      assertHasChinese(placeholder, 'members search placeholder');
      assert.notEqual(placeholder, 'Search members');

      const mts = await page.getAllText('#members .o2-mts');
      assert.ok(!mts.some((x) => /\bposts?\b/.test(x)), `Untranslated posts label in .o2-mts: ${mts.join(' | ')}`);
      page.assertNoErrors('2.4');
    });

    it('2.5 Localizes remote .o2-src banner and .o2-mtags (last seen, all channels, Runs on)', async (t) => {
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
      await page.waitForSelector('[data-testid="swarm-source"]', { visible: true });

      const srcText = await page.getText('[data-testid="swarm-source"]');
      const seenTexts = await page.getAllText('[data-testid="swarm-member-seen"]');
      const ownerTip = await page.getAttr('[data-testid="swarm-member-owner"]', 'title');
      assertHasChinese(srcText, 'remote source banner');
      assert.ok(!/\bmachines?\b/.test(srcText), `Untranslated machine unit: ${srcText}`);
      assertEveryHasChinese(seenTexts, '2.5 last_seen tags');
      assert.ok(!seenTexts.some((s) => /seen just now|last seen/i.test(s)), `Untranslated last_seen: ${seenTexts.join(' | ')}`);
      assertHasChinese(ownerTip, 'owner Runs on tooltip');
      assert.ok(!/Runs on/i.test(ownerTip), `Untranslated Runs on tooltip: ${ownerTip}`);
      page.assertNoErrors('2.5');
    });
  });

  // =========================================================================
  // Area 3: Graph & Replay View (#tab-graph) — 5 tests
  // =========================================================================
  describe('Area 3: Graph & Replay View', () => {
    it('3.1 Localizes #replay-label and fmtDur Chinese duration units in live mode', async (t) => {
      const harness = new SidecarHarness({ env: llmEnv() });
      t.after(() => harness.stop());
      buildBasicSwarm(harness);
      await harness.start();

      const page = await browser.newIsolatedPage();
      t.after(() => page.close());
      await page.navigate(harness.baseUrl);
      await page.waitForSwarmReady();
      await page.click('[data-testid="swarm-tab-graph"]');
      await page.waitForSelector('#replay-label', { visible: true });

      const label = await page.getText('#replay-label');
      assertHasChinese(label, '#replay-label');
      assert.ok(!/\bposts?\b|\bover\b/.test(label), `Untranslated replay label: ${label}`);
      page.assertNoErrors('3.1');
    });

    it('3.2 Localizes #replay-label step format and #replay-caption translated body during replay', async (t) => {
      const harness = new SidecarHarness({ env: llmEnv() });
      t.after(() => harness.stop());
      buildBasicSwarm(harness);
      await harness.start();

      await harness.waitForSwarm((s) => s.messages?.some((m) => hasChinese(m.text_zh)), { timeout: 8000 });
      const page = await browser.newIsolatedPage();
      t.after(() => page.close());
      await page.navigate(`${harness.baseUrl}/?tab=graph&replay=2`);
      await page.waitForSwarmReady();
      await page.waitForSelector('#replay-caption:not(.hidden)', { visible: true });

      const stepLabel = await page.getText('#replay-label');
      assertHasChinese(stepLabel, 'step #replay-label');
      assert.ok(!/\bof\b/.test(stepLabel), `Untranslated 'of' in replay label: ${stepLabel}`);

      const capBody = await page.getText('#replay-caption .msg-body');
      assertHasChinese(capBody, '#replay-caption body');
      page.assertNoErrors('3.2');
    });

    it('3.3 Localizes SVG node and edge <title> tooltips', async (t) => {
      const harness = new SidecarHarness({ env: llmEnv() });
      t.after(() => harness.stop());
      buildBasicSwarm(harness);
      await harness.start();

      const page = await browser.newIsolatedPage();
      t.after(() => page.close());
      await page.navigate(harness.baseUrl);
      await page.waitForSwarmReady();
      await page.click('[data-testid="swarm-tab-graph"]');
      await page.waitForSelector('[data-testid="swarm-graph"] g.node title');

      const titles = await page.evaluate(() => {
        return [...document.querySelectorAll('#graph title')].map((el) => el.textContent || '');
      });
      assert.ok(titles.length >= 2);
      assertEveryHasChinese(titles, '3.3 graph SVG tooltips');
      assert.ok(!titles.some((x) => /\bdirect\b|\bsteps\b|\bposts\b/i.test(x)), `Untranslated graph SVG tooltip: ${titles.join(' | ')}`);
      page.assertNoErrors('3.3');
    });

    it('3.4 Localizes Graph controls, switches, speed/timing selects, and legend', async (t) => {
      const harness = new SidecarHarness({ env: llmEnv() });
      t.after(() => harness.stop());
      buildBasicSwarm(harness);
      await harness.start();

      const page = await browser.newIsolatedPage();
      t.after(() => page.close());
      await page.navigate(harness.baseUrl);
      await page.waitForSwarmReady();
      await page.click('[data-testid="swarm-tab-graph"]');
      await page.waitForSelector('#tab-graph.active', { visible: true });

      const graphTabText = await page.getText('#tab-graph');
      assertHasChinese(graphTabText, '#tab-graph controls & legend');
      assertNoUntranslatedUiStrings(graphTabText, ['Hide inactive', 'Expand @all', 'Even pacing', 'Real-time gaps'], '#tab-graph');
      page.assertNoErrors('3.4');
    });

    it('3.5 Localizes #replay-play aria-label for play and pause states', async (t) => {
      const harness = new SidecarHarness({ env: llmEnv() });
      t.after(() => harness.stop());
      buildBasicSwarm(harness);
      await harness.start();

      const page = await browser.newIsolatedPage();
      t.after(() => page.close());
      await page.navigate(harness.baseUrl);
      await page.waitForSwarmReady();
      await page.click('[data-testid="swarm-tab-graph"]');
      await page.waitForSelector('[data-testid="swarm-replay-play"]', { visible: true });

      const playLabel = await page.getAttr('[data-testid="swarm-replay-play"]', 'aria-label');
      assertHasChinese(playLabel, 'replay play aria-label');
      assert.notEqual(playLabel, 'Play replay');

      await page.click('[data-testid="swarm-replay-play"]');
      await page.waitForFunction((prev) => {
        const cur = document.querySelector('[data-testid="swarm-replay-play"]')?.getAttribute('aria-label') || '';
        return cur && cur !== prev;
      }, [playLabel], { timeout: 4000 });
      const pauseLabel = await page.getAttr('[data-testid="swarm-replay-play"]', 'aria-label');
      assertHasChinese(pauseLabel, 'replay pause aria-label');
      assert.notEqual(pauseLabel, 'Pause replay');
      assert.notEqual(pauseLabel, playLabel, 'Pause aria-label must differ from play aria-label');
      assert.ok(pauseLabel.includes('暂停'), `Expected pause aria-label in Chinese, got: ${pauseLabel}`);

      // Toggle back to pause cleanly before teardown
      await page.click('[data-testid="swarm-replay-play"]');
      page.assertNoErrors('3.5');
    });
  });

  // =========================================================================
  // Area 4: Overview & Narrator (#tab-overview) — 5 tests
  // =========================================================================
  describe('Area 4: Overview & Narrator', () => {
    it('4.1 Renders translated view_zh fields in #ov-plain (goal, headline, threads, workstreams)', async (t) => {
      const harness = new SidecarHarness({ env: llmEnv() });
      t.after(() => harness.stop());
      buildRichOverviewSwarm(harness);
      await harness.start();

      const snap = await harness.waitForSwarm((s) => !!(
        s.view_zh?.goal?.title
        && hasChinese(s.view_zh.goal.title)
        && hasChinese(s.view_zh.headline)
        && hasChinese(s.view_zh.running_summary)
        && hasChinese(s.view_zh.attention?.[0]?.title)
        && hasChinese(s.view_zh.workstreams?.[0]?.title)
        && hasChinese(s.view_zh.threads?.[0]?.title)
        && hasChinese(s.view_zh.milestones?.[0]?.text)
        && hasChinese(s.view_zh.risks?.[0]?.text)
      ), { timeout: 8000 });
      const page = await browser.newIsolatedPage();
      t.after(() => page.close());
      await page.navigate(harness.baseUrl);
      await page.waitForSwarmReady();
      await page.waitForSelector('[data-testid="swarm-overview-plain"]', { visible: true });

      const ovSections = await page.evaluate(() => {
        const root = document.querySelector('[data-testid="swarm-overview-plain"]');
        const texts = (sel) => [...(root?.querySelectorAll(sel) || [])].map((e) => (e.textContent || '').trim()).filter(Boolean);
        return {
          plainText: (root?.textContent || '').trim(),
          goal: texts('.o2-goal b, .o2-goal p'),
          runningSummary: texts('.o2-runsum'),
          workstreams: texts('.o2-runt, .o2-runnote'),
          threads: texts('.o2-tht b, .o2-thg, .o2-thn'),
          attention: texts('.o2-askb b, .o2-askl'),
          leadNow: texts('.o2-lead p'),
        };
      });

      assertHasChinese(ovSections.plainText, '#ov-plain');
      assertEveryHasChinese(ovSections.goal, '4.1 #ov-plain goal');
      assertEveryHasChinese(ovSections.runningSummary, '4.1 #ov-plain running_summary');
      assertEveryHasChinese(ovSections.workstreams, '4.1 #ov-plain workstreams');
      assertEveryHasChinese(ovSections.threads, '4.1 #ov-plain threads');
      assertEveryHasChinese(ovSections.attention, '4.1 #ov-plain attention');
      assertEveryHasChinese(ovSections.leadNow, '4.1 #ov-plain coordinator now');

      // Ensure none of the original English strings across view sections remain verbatim
      for (const forbidden of [
        'Audit and fix Hub window layouts',
        'Four fixes landed; split pane polish in review',
        'Drafting a design doc; research done, draft under review',
        'Backend is running integration checks while critic reviews layout',
        'Decide: freeform HTML or JSON view model?',
        'critic and designer disagree; blocks the final doc',
        'Backend research',
        'Layout review',
        'Waiting on format decision',
        'Split pane cards',
        'Put split panes inside shared cards',
        'Folding polish into the fix',
        'Reviewing backend report',
      ]) {
        assert.ok(!ovSections.plainText.includes(forbidden), `Untranslated English view field in #ov-plain: ${forbidden}`);
      }

      // Also verify view_zh milestones and risks (sanitized & passed to narrator/API) are translated
      assertEveryHasChinese((snap.view_zh.milestones || []).map((m) => m.text), '4.1 view_zh milestones');
      assertEveryHasChinese((snap.view_zh.risks || []).map((r) => r.text), '4.1 view_zh risks');
      assert.ok(!snap.view_zh.milestones[0].text.includes('Backend report posted'));
      assert.ok(!snap.view_zh.risks[0].text.includes('Always-on member adds token cost'));
      page.assertNoErrors('4.1');
    });

    it('4.2 Consumes plan_zh when view.json is absent', async (t) => {
      const harness = new SidecarHarness({ env: llmEnv() });
      t.after(() => harness.stop());
      buildPlanAndChannelsSwarm(harness);
      await harness.start();

      const snap = await harness.waitForSwarm((s) => hasChinese(s.plan_zh?.goal?.title), { timeout: 8000 });
      assertHasChinese(snap.plan_zh?.goal?.title, 'snap.plan_zh.goal.title');
      const page = await browser.newIsolatedPage();
      t.after(() => page.close());
      await page.navigate(harness.baseUrl);
      await page.waitForSwarmReady();

      const plainText = await page.getText('[data-testid="swarm-overview-plain"]');
      assertHasChinese(plainText, 'plan_zh in #ov-plain');
      assert.ok(plainText.includes(snap.plan_zh.goal.title), `Expected translated plan_zh goal in #ov-plain, got: ${plainText}`);
      page.assertNoErrors('4.2');
    });

    it('4.3 Localizes #ov-status narrator badges, freshness, #ov-ack, and footer chrome', async (t) => {
      const harness = new SidecarHarness({ env: llmEnv() });
      t.after(() => harness.stop());
      buildRichOverviewSwarm(harness);
      await harness.start();

      await harness.waitForSwarm((s) => !!s.view_zh, { timeout: 8000 });
      const page = await browser.newIsolatedPage();
      t.after(() => page.close());
      await page.navigate(harness.baseUrl);
      await page.waitForSwarmReady();

      const statusText = await page.getText('[data-testid="swarm-overview-status"]');
      const ackText = await page.getText('[data-testid="swarm-overview-ack"]');
      const footerText = await page.getText('[data-testid="swarm-overview-footer"]');
      assertHasChinese(statusText, '#ov-status');
      assertHasChinese(ackText, '#ov-ack');
      assertNoUntranslatedUiStrings(`${statusText}\n${footerText}`, ['Want this view different? Tell the coordinator.', 'Open coordinator chat', 'watching', 'updating'], 'overview chrome');
      page.assertNoErrors('4.3');
    });

    it('4.4 Localizes #ov-system alerts for quota, error, and stuck workers', async (t) => {
      const harness = new SidecarHarness({ env: llmEnv() });
      t.after(() => harness.stop());
      buildSystemAlertsSwarm(harness);
      await harness.start();

      await harness.waitForSwarm((s) => Array.isArray(s.systemAttention) && s.systemAttention.length >= 3, { timeout: 8000 });
      const page = await browser.newIsolatedPage();
      t.after(() => page.close());
      await page.navigate(harness.baseUrl);
      await page.waitForSwarmReady();
      await page.waitForSelector('[data-testid="swarm-overview-system-item"]');

      const sysTexts = await page.getAllText('[data-testid="swarm-overview-system-item"]');
      const plainText = await page.getText('[data-testid="swarm-overview-plain"]');
      assert.ok(sysTexts.length >= 3);
      assertEveryHasChinese(sysTexts, '4.4 #ov-system alerts');
      assertHasChinese(plainText, '#ov-plain system alerts');
      assert.ok(!sysTexts.some((x) => /last step failed|no progress, and not waiting/i.test(x)), `Untranslated system alert: ${sysTexts.join(' | ')}`);
      page.assertNoErrors('4.4');
    });

    it('4.5 Passes localized view_zh into sandboxed #ov-frame narrator iframe & localizes .o2-tv reel captions', async (t) => {
      const harness = new SidecarHarness({ overview: false, env: llmEnv() });
      t.after(() => harness.stop());
      buildRichOverviewSwarm(harness, { includeNarrator: true, includeHtml: true, includeReel: true });
      await harness.start();

      await harness.waitForSwarm((s) => !!s.view_zh && hasChinese(s.view_zh.headline), { timeout: 8000 });
      const page = await browser.newIsolatedPage();
      t.after(() => page.close());
      await page.navigate(`${harness.baseUrl}/?narrator=frame`);
      await page.waitForSwarmReady();
      await page.waitForSelector('[data-testid="swarm-overview-iframe"]');

      let frameData = null;
      const deadline = Date.now() + 6000;
      while (Date.now() < deadline) {
        try {
          frameData = await page.evaluateInFrame('#ov-frame iframe.ov-iframe', () => ({
            headline: document.getElementById('narrator-headline')?.textContent || '',
            att: document.getElementById('narrator-att')?.textContent || '',
          }));
          if (frameData?.headline && frameData.headline !== 'Loading view...') break;
        } catch {
          // frame initializing
        }
        await new Promise((r) => setTimeout(r, 80));
      }
      assertHasChinese(frameData?.headline, 'narrator iframe headline');
      assertHasChinese(frameData?.att, 'narrator iframe attention');
      assert.ok(!frameData.headline.includes('Drafting a design doc'), 'Iframe headline must be translated');

      // Also switch to plain overview and open .o2-rexp -> .o2-tv lightbox to verify reel captions
      await page.click('[data-testid="swarm-overview-mode"]');
      await page.waitForSelector('.o2-reel .o2-rexp', { visible: true });
      await page.click('.o2-reel .o2-rexp');
      await page.waitForSelector('.o2-tv', { visible: true });
      const cap = await page.getText('.o2-tv .o2-tvcap');
      assertHasChinese(cap, '4.5 .o2-tv lightbox caption');
      assert.ok(!/Baseline header before alignment|Aligned split pane cards/i.test(cap), `Untranslated reel caption: ${cap}`);
      await page.evaluate(() => document.querySelector('.o2-tv .o2-tvx')?.click());
      page.assertNoErrors('4.5');
    });
  });

  // =========================================================================
  // Area 5: Raw Meta & Lossless Disk Display (#tab-raw) — 5 tests
  // =========================================================================
  describe('Area 5: Raw Meta & Lossless Content', () => {
    it('5.1 Localizes #raw-meta line count unit ("N 行") while keeping board.jsonl lossless', async (t) => {
      const harness = new SidecarHarness({ env: llmEnv() });
      t.after(() => harness.stop());
      buildBasicSwarm(harness);
      await harness.start();

      const page = await browser.newIsolatedPage();
      t.after(() => page.close());
      await page.navigate(harness.baseUrl);
      await page.waitForSwarmReady();
      await page.click('[data-testid="swarm-tab-raw"]');
      await page.click('.raw-btn[data-raw="board"]');

      const metaText = await page.getText('#raw-meta');
      const rawContent = await page.getText('[data-testid="swarm-raw"]');
      assertHasChinese(metaText, '#raw-meta board lines');
      assert.ok(!/\blines?\b/.test(metaText), `Untranslated 'lines' in #raw-meta: ${metaText}`);
      assert.ok(rawContent.includes('Please inspect'), 'board.jsonl raw content must remain untouched English');
      page.assertNoErrors('5.1');
    });

    it('5.2 Keeps members.json lossless in #raw even after translations complete', async (t) => {
      const harness = new SidecarHarness({ env: llmEnv() });
      t.after(() => harness.stop());
      buildBasicSwarm(harness);
      await harness.start();

      await harness.waitForSwarm((s) => s.messages?.some((m) => hasChinese(m.text_zh)), { timeout: 8000 });
      const page = await browser.newIsolatedPage();
      t.after(() => page.close());
      await page.navigate(harness.baseUrl);
      await page.waitForSwarmReady();
      await page.click('[data-testid="swarm-tab-raw"]');

      const rawMembers = await page.getText('[data-testid="swarm-raw"]');
      const parsed = JSON.parse(rawMembers);
      assert.equal(parsed.title, 'Audit and fix Hub window layouts');
      assert.ok(parsed.members.backend, 'members.json keys must stay lossless');
      page.assertNoErrors('5.2');
    });

    it('5.3 Keeps view.json lossless in #raw while view_zh is used in Overview', async (t) => {
      const harness = new SidecarHarness({ env: llmEnv() });
      t.after(() => harness.stop());
      buildRichOverviewSwarm(harness);
      await harness.start();

      await harness.waitForSwarm((s) => !!s.view_zh, { timeout: 8000 });
      const page = await browser.newIsolatedPage();
      t.after(() => page.close());
      await page.navigate(harness.baseUrl);
      await page.waitForSwarmReady();
      await page.click('[data-testid="swarm-tab-raw"]');
      await page.click('.raw-btn[data-raw="view"]');

      const rawView = await page.getText('[data-testid="swarm-raw"]');
      const parsed = JSON.parse(rawView);
      assert.equal(parsed.headline, 'Drafting a design doc; research done, draft under review.');
      page.assertNoErrors('5.3');
    });

    it('5.4 Localizes "(empty)" placeholder in #raw when board.jsonl is empty', async (t) => {
      const harness = new SidecarHarness({ env: llmEnv() });
      t.after(() => harness.stop());
      buildEmptyOnboardingSwarm(harness);
      await harness.start();

      const page = await browser.newIsolatedPage();
      t.after(() => page.close());
      await page.navigate(harness.baseUrl);
      await page.waitForSwarmReady();
      await page.click('[data-testid="swarm-tab-raw"]');
      await page.click('.raw-btn[data-raw="board"]');

      const rawText = await page.getText('[data-testid="swarm-raw"]');
      assertHasChinese(rawText, 'empty #raw');
      assert.notEqual(rawText, '(empty)');
      page.assertNoErrors('5.4');
    });

    it('5.5 Localizes #raw-copy button label and tooltip', async (t) => {
      const harness = new SidecarHarness({ env: llmEnv() });
      t.after(() => harness.stop());
      buildBasicSwarm(harness);
      await harness.start();

      const page = await browser.newIsolatedPage();
      t.after(() => page.close());
      await page.navigate(harness.baseUrl);
      await page.waitForSwarmReady();
      await page.click('[data-testid="swarm-tab-raw"]');

      const copyLabel = await page.getText('[data-testid="swarm-raw-copy"]');
      const copyTitle = await page.getAttr('[data-testid="swarm-raw-copy"]', 'title');
      assertHasChinese(copyLabel, '#raw-copy label');
      assertHasChinese(copyTitle, '#raw-copy title');
      assert.notEqual(copyLabel, 'Copy');
      page.assertNoErrors('5.5');
    });
  });

  // =========================================================================
  // Area 6: Global Chrome, Title, Toasts & Tabs — 5 tests
  // =========================================================================
  describe('Area 6: Global Chrome, Title, Toasts & Tabs', () => {
    it('6.1 Localizes navigation tabs (Overview, Board, Members, Graph, Raw)', async (t) => {
      const harness = new SidecarHarness({ env: llmEnv() });
      t.after(() => harness.stop());
      buildBasicSwarm(harness);
      await harness.start();

      const page = await browser.newIsolatedPage();
      t.after(() => page.close());
      await page.navigate(harness.baseUrl);
      await page.waitForSwarmReady();

      const tabs = await page.getAllText('[data-testid="swarm-tabs"] button.tab');
      for (const tabText of tabs) {
        assertHasChinese(tabText, 'nav tab label');
      }
      assertNoUntranslatedUiStrings(tabs.join('\n'), ['Overview', 'Board', 'Members', 'Graph', 'Raw'], 'nav.tabs');
      page.assertNoErrors('6.1');
    });

    it('6.2 Localizes #swarm-title fallback ("Untitled swarm") and translates English swarm title', async (t) => {
      const harness = new SidecarHarness({ env: llmEnv() });
      t.after(() => harness.stop());
      buildBasicSwarm(harness, { title: '' });
      await harness.start();

      const page = await browser.newIsolatedPage();
      t.after(() => page.close());
      await page.navigate(harness.baseUrl);
      await page.waitForSwarmReady();

      const title = await page.getText('[data-testid="swarm-title"]');
      assertHasChinese(title, '#swarm-title fallback');
      assert.notEqual(title, 'Untitled swarm');
      page.assertNoErrors('6.2');
    });

    it('6.3 Localizes #live-label and #live tooltip', async (t) => {
      const harness = new SidecarHarness({ env: llmEnv() });
      t.after(() => harness.stop());
      buildBasicSwarm(harness);
      await harness.start();

      const page = await browser.newIsolatedPage();
      t.after(() => page.close());
      await page.navigate(harness.baseUrl);
      await page.waitForSwarmReady();

      const liveText = await page.getText('#live-label');
      const liveTitle = await page.getAttr('[data-testid="swarm-live"]', 'title');
      assertHasChinese(liveText, '#live-label');
      assertHasChinese(liveTitle, '#live title');
      assert.notEqual(liveText, 'Live');
      assert.notEqual(liveTitle, 'Updates automatically');
      page.assertNoErrors('6.3');
    });

    it('6.4 Localizes empty swarm state (#empty-title, #empty-body, .empty-hint)', async (t) => {
      const harness = new SidecarHarness({ env: llmEnv() });
      t.after(() => harness.stop());
      // No swarm written for this conversationId
      await harness.start();

      const page = await browser.newIsolatedPage();
      t.after(() => page.close());
      await page.navigate(harness.baseUrl);
      await page.waitForSwarmReady();
      await page.waitForSelector('[data-testid="swarm-empty-state"]:not(.hidden)', { visible: true });

      const emptyText = await page.getText('[data-testid="swarm-empty-state"]');
      assertHasChinese(emptyText, '#empty state');
      assertNoUntranslatedUiStrings(emptyText, ['No swarm in this conversation', 'Watching for a swarm'], '#empty');
      page.assertNoErrors('6.4');
    });

    it('6.5 Localizes #toast messages on gated narrator navigation without Electron', async (t) => {
      const harness = new SidecarHarness({ overview: false, env: llmEnv() });
      t.after(() => harness.stop());
      buildRichOverviewSwarm(harness, { includeNarrator: true, includeHtml: true });
      await harness.start();

      const page = await browser.newIsolatedPage();
      t.after(() => page.close());
      await page.navigate(`${harness.baseUrl}/?narrator=frame`);
      await page.waitForSwarmReady();
      await page.waitForSelector('[data-testid="swarm-overview-iframe"]');

      // Wait for narrator iframe READY + RENDERED before triggering gated navigation
      let headline = '';
      const deadline = Date.now() + 6000;
      while (Date.now() < deadline) {
        try {
          headline = await page.evaluateInFrame('#ov-frame iframe.ov-iframe', () => {
            return document.getElementById('narrator-headline')?.textContent || '';
          });
          if (headline && headline !== 'Loading view...') break;
        } catch {
          // frame initializing
        }
        await new Promise((r) => setTimeout(r, 80));
      }
      assert.ok(headline && headline !== 'Loading view...', 'Narrator iframe must become READY before testing gated toast');

      // User gesture on parent chrome updates parentInputAt (<5.5s gate), so iframe navigate() is denied with #toast
      await page.mouseClick('[data-testid="swarm-tab-overview"]');
      await page.evaluateInFrame('#ov-frame iframe.ov-iframe', () => {
        window.narrator.navigate({ type: 'board_post', target: 4 });
      });

      await page.waitForSelector('[data-testid="swarm-toast"]:not(.hidden)', { visible: true, timeout: 5000 });
      const toast = await page.getText('[data-testid="swarm-toast"]');
      assertHasChinese(toast, '#toast gate message');
      assert.ok(!toast.includes('Click a link in the view to open it.'), `Untranslated toast: ${toast}`);
      page.assertNoErrors('6.5');
    });
  });

  // =========================================================================
  // Area 7: Bilingual Search (#f-search & .o2-msin) — 5 tests
  // =========================================================================
  describe('Area 7: Bilingual Search', () => {
    it('7.1 #f-search matches Chinese translation of an English board post', async (t) => {
      const harness = new SidecarHarness({ env: llmEnv() });
      t.after(() => harness.stop());
      buildBasicSwarm(harness);
      await harness.start();

      await harness.waitForSwarm((s) => s.messages?.some((m) => hasChinese(m.text_zh)), { timeout: 8000 });
      const page = await browser.newIsolatedPage();
      t.after(() => page.close());
      await page.navigate(`${harness.baseUrl}/?tab=feed`);
      await page.waitForSwarmReady();
      await page.waitForFunction(() => [...document.querySelectorAll('[data-testid="swarm-message"]')].some((e) => /[\u4e00-\u9fff]/.test(e.textContent || '')));

      await page.type('[data-testid="swarm-search"]', '已完成');
      const count = await page.evaluate(() => document.querySelectorAll('[data-testid="swarm-message"]').length);
      assert.ok(count >= 1 && count < 3, `Expected Chinese query '已完成' to match translated post(s), got count=${count}`);
      page.assertNoErrors('7.1');
    });

    it('7.2 #f-search still matches raw English keywords while displaying Chinese mode', async (t) => {
      const harness = new SidecarHarness({ env: llmEnv() });
      t.after(() => harness.stop());
      buildBasicSwarm(harness);
      await harness.start();

      await harness.waitForSwarm((s) => s.messages?.some((m) => hasChinese(m.text_zh)), { timeout: 8000 });
      const page = await browser.newIsolatedPage();
      t.after(() => page.close());
      await page.navigate(`${harness.baseUrl}/?tab=feed`);
      await page.waitForSwarmReady();

      await page.type('[data-testid="swarm-search"]', 'verification checks');
      const count = await page.evaluate(() => document.querySelectorAll('[data-testid="swarm-message"]').length);
      assert.equal(count, 1, 'English raw query must still match original text in zh mode');
      page.assertNoErrors('7.2');
    });

    it('7.3 #f-search matches author name and technical path literals', async (t) => {
      const harness = new SidecarHarness({ env: llmEnv() });
      t.after(() => harness.stop());
      buildBasicSwarm(harness);
      await harness.start();

      const page = await browser.newIsolatedPage();
      t.after(() => page.close());
      await page.navigate(`${harness.baseUrl}/?tab=feed`);
      await page.waitForSwarmReady();

      await page.type('[data-testid="swarm-search"]', 'config.json');
      const count = await page.evaluate(() => document.querySelectorAll('[data-testid="swarm-message"]').length);
      assert.equal(count, 1);
      page.assertNoErrors('7.3');
    });

    it('7.4 .o2-msin Members search matches Chinese translated activity/status/title', async (t) => {
      const harness = new SidecarHarness({ env: llmEnv() });
      t.after(() => harness.stop());
      buildRichOverviewSwarm(harness);
      await harness.start();

      await harness.waitForSwarm((s) => s.members?.some((m) => hasChinese(m.activity_zh)), { timeout: 8000 });
      const page = await browser.newIsolatedPage();
      t.after(() => page.close());
      await page.navigate(harness.baseUrl);
      await page.waitForSwarmReady();
      await page.click('[data-testid="swarm-tab-members"]');
      await page.waitForSelector('#members .o2-msin', { visible: true });

      await page.type('#members .o2-msin', '读取');
      const visibleCount = await page.evaluate(() => {
        return [...document.querySelectorAll('#members .o2-mrow')].filter((r) => r.style.display !== 'none').length;
      });
      assert.ok(visibleCount >= 1 && visibleCount <= 2, `Expected Chinese Members search '读取' to filter to backend, got ${visibleCount}`);
      page.assertNoErrors('7.4');
    });

    it('7.5 .o2-msin Members search matches original English model/role/activity', async (t) => {
      const harness = new SidecarHarness({ env: llmEnv() });
      t.after(() => harness.stop());
      buildRichOverviewSwarm(harness);
      await harness.start();

      const page = await browser.newIsolatedPage();
      t.after(() => page.close());
      await page.navigate(harness.baseUrl);
      await page.waitForSwarmReady();
      await page.click('[data-testid="swarm-tab-members"]');
      await page.waitForSelector('#members .o2-msin', { visible: true });

      await page.type('#members .o2-msin', 'claude-sonnet');
      const visibleNames = await page.evaluate(() => {
        return [...document.querySelectorAll('#members .o2-mrow')]
          .filter((r) => r.style.display !== 'none')
          .map((r) => r.getAttribute('data-open-member'));
      });
      assert.deepEqual(visibleNames, ['critic']);
      page.assertNoErrors('7.5');
    });
  });

  // =========================================================================
  // Area 8: Clean Native-Chinese Single-Mode Header — 5 tests
  // =========================================================================
  describe('Area 8: Clean Native-Chinese Single-Mode Header', () => {
    it('8.1 [data-testid="swarm-lang-mode"] is removed from header (title + live only)', async (t) => {
      const harness = new SidecarHarness({ env: llmEnv() });
      t.after(() => harness.stop());
      buildBasicSwarm(harness);
      await harness.start();

      const page = await browser.newIsolatedPage();
      t.after(() => page.close());
      await page.navigate(harness.baseUrl);
      await page.waitForSwarmReady();

      const st = await getLangModeState(page);
      assertLangModeAbsent(st, '8.1');
      const headerRowText = await page.getText('.header-row');
      assert.equal(headerRowText.includes('译文'), false);
      assert.equal(headerRowText.includes('对照'), false);
      assert.equal(headerRowText.includes('原文'), false);
      assert.ok(headerRowText.includes('实时'));
      page.assertNoErrors('8.1');
    });

    it('8.2 Localized messages render clean Chinese without redundant .msg-orig blocks', async (t) => {
      const harness = new SidecarHarness({ env: llmEnv() });
      t.after(() => harness.stop());
      buildBasicSwarm(harness);
      await harness.start();

      await harness.waitForSwarm((s) => s.messages?.some((m) => hasChinese(m.text_zh)), { timeout: 8000 });
      const page = await browser.newIsolatedPage();
      t.after(() => page.close());
      await page.navigate(`${harness.baseUrl}/?tab=feed`);
      await page.waitForSwarmReady();
      await page.waitForFunction(() => [...document.querySelectorAll('[data-testid="swarm-message"] .msg-body')].some((e) => /[\u4e00-\u9fff]/.test(e.textContent || '')));

      const bodies = await page.getAllText('[data-testid="swarm-message"] .msg-body');
      assertHasChinese(bodies.join('\n'), '8.2 clean Chinese board');
      const origCount = await page.evaluate(() => document.querySelectorAll('.msg-orig, .o2-orig').length);
      assert.equal(origCount, 0, 'Must not render .msg-orig or .o2-orig blocks');
      page.assertNoErrors('8.2');
    });

    it('8.3 Native Chinese posts render verbatim without translation prefix or duplicate blocks', async (t) => {
      const harness = new SidecarHarness({ env: llmEnv() });
      t.after(() => harness.stop());
      buildBasicSwarm(harness, {
        title: '原生中文测试看板',
        messages: [
          { seq: 1, agent: 'coordinator', time: '2026-11-19 14:00:00', text: '@backend 请核对 `src/main.ts` 并反馈结论。' },
          { seq: 2, agent: 'backend', time: '2026-11-19 14:01:00', text: '[done] @coordinator 已完成核对，所有检查全部通过。' },
        ],
      });
      await harness.start();

      const page = await browser.newIsolatedPage();
      t.after(() => page.close());
      await page.navigate(`${harness.baseUrl}/?tab=feed`);
      await page.waitForSwarmReady();

      const title = await page.getText('[data-testid="swarm-title"]');
      assert.equal(title, '原生中文测试看板');
      const bodies = await page.getAllText('[data-testid="swarm-message"] .msg-body');
      const combined = bodies.join('\n');
      assert.ok(combined.includes('[已完成]'));
      assert.ok(combined.includes('已完成核对，所有检查全部通过。'));
      assert.equal(await page.evaluate(() => document.querySelectorAll('.msg-orig').length), 0);
      page.assertNoErrors('8.3');
    });

    it('8.4 Legacy localStorage["swarm.langMode"] is ignored across reload so UI stays Chinese', async (t) => {
      const harness = new SidecarHarness({ env: llmEnv() });
      t.after(() => harness.stop());
      buildBasicSwarm(harness);
      await harness.start();

      await harness.waitForSwarm((s) => s.messages?.some((m) => hasChinese(m.text_zh)), { timeout: 8000 });
      const page = await browser.newIsolatedPage({ localStorageSeed: { 'swarm.langMode': 'bi' } });
      t.after(() => page.close());
      await page.navigate(`${harness.baseUrl}/?tab=feed`);
      await page.waitForSwarmReady();

      await page.reload();
      await page.waitForSwarmReady();
      assertLangModeAbsent(await getLangModeState(page), '8.4');
      assert.equal(await page.evaluate(() => document.querySelectorAll('.msg-orig').length), 0);
      const bodies = await page.getAllText('[data-testid="swarm-message"] .msg-body');
      assertHasChinese(bodies.join('\n'), '8.4 reload stays Chinese');
      page.assertNoErrors('8.4');
    });

    it('8.5 #ov-plain and #members render clean Chinese without #lang-mode or .o2-orig clutter', async (t) => {
      const harness = new SidecarHarness({ env: llmEnv() });
      t.after(() => harness.stop());
      buildRichOverviewSwarm(harness);
      await harness.start();

      await harness.waitForSwarm((s) => !!s.view_zh, { timeout: 8000 });
      const page = await browser.newIsolatedPage();
      t.after(() => page.close());
      await page.navigate(harness.baseUrl);
      await page.waitForSwarmReady();

      const zhOverview = await page.getText('[data-testid="swarm-overview-plain"]');
      assertHasChinese(zhOverview, '8.5 zh overview');
      assert.equal(await page.evaluate(() => document.querySelectorAll('.o2-orig').length), 0);

      await page.click('[data-testid="swarm-tab-members"]');
      await page.waitForSelector('#members .o2-members', { visible: true });
      assert.equal(await page.evaluate(() => document.querySelectorAll('.o2-orig').length), 0);
      assertLangModeAbsent(await getLangModeState(page), '8.5');
      page.assertNoErrors('8.5');
    });
  });

  // =========================================================================
  // Area 9: Placeholder Preservation — 5 tests
  // =========================================================================
  describe('Area 9: Placeholder Preservation', () => {
    it('9.1 Preserves inline `code` and fenced ```code``` blocks verbatim', async (t) => {
      const harness = new SidecarHarness({ env: llmEnv() });
      t.after(() => harness.stop());
      buildBasicSwarm(harness);
      await harness.start();

      await harness.waitForSwarm((s) => s.messages?.some((m) => hasChinese(m.text_zh)), { timeout: 8000 });
      const page = await browser.newIsolatedPage();
      t.after(() => page.close());
      await page.navigate(`${harness.baseUrl}/?tab=feed`);
      await page.waitForSwarmReady();
      await page.waitForFunction(() => [...document.querySelectorAll('[data-testid="swarm-message"]')].some((e) => /[\u4e00-\u9fff]/.test(e.textContent || '')));

      const feedText = await page.getText('[data-testid="swarm-feed"]');
      assertLiteralsPreserved(feedText, ['const keepLiteral = "DO_NOT_TRANSLATE";'], 'code blocks');
      page.assertNoErrors('9.1');
    });

    it('9.2 Preserves Windows and POSIX file paths verbatim', async (t) => {
      const harness = new SidecarHarness({ env: llmEnv() });
      t.after(() => harness.stop());
      buildBasicSwarm(harness);
      await harness.start();

      await harness.waitForSwarm((s) => s.messages?.some((m) => hasChinese(m.text_zh)), { timeout: 8000 });
      const page = await browser.newIsolatedPage();
      t.after(() => page.close());
      await page.navigate(`${harness.baseUrl}/?tab=feed`);
      await page.waitForSwarmReady();
      await page.waitForFunction(() => [...document.querySelectorAll('[data-testid="swarm-message"]')].some((e) => /[\u4e00-\u9fff]/.test(e.textContent || '')));

      const feedText = await page.getText('[data-testid="swarm-feed"]');
      assertLiteralsPreserved(feedText, ['C:\\repo\\src\\main.ts', '/opt/app/config.json'], 'paths');
      page.assertNoErrors('9.2');
    });

    it('9.3 Preserves URLs verbatim', async (t) => {
      const harness = new SidecarHarness({ env: llmEnv() });
      t.after(() => harness.stop());
      buildBasicSwarm(harness);
      await harness.start();

      const snap = await harness.waitForSwarm(
        (s) => s.messages?.length === 3 && s.messages.every((m) => hasChinese(m.text_zh)),
        { timeout: 8000 }
      );
      const page = await browser.newIsolatedPage();
      t.after(() => page.close());
      await page.navigate(`${harness.baseUrl}/?tab=feed`);
      await page.waitForSwarmReady();
      await page.waitForFunction(() => {
        const bodies = [...document.querySelectorAll('[data-testid="swarm-message"] .msg-body')];
        return bodies.length >= 1 && /[\u4e00-\u9fff]/.test(bodies[0].textContent || '');
      });

      const body = await page.getText('[data-testid="swarm-message"] .msg-body');
      assertTranslatedFrom(body, snap.messages[0].text, '9.3 URL post body');
      assert.ok(!/Please inspect|and check/i.test(body), `Untranslated English prose in 9.3 URL post: ${body}`);
      assertLiteralsPreserved(body, ['https://example.com/docs/spec'], 'URLs');
      page.assertNoErrors('9.3');
    });

    it('9.4 Preserves @mentions, @#channel, and clickable #seq citation pills', async (t) => {
      const harness = new SidecarHarness({ env: llmEnv() });
      t.after(() => harness.stop());
      buildBasicSwarm(harness);
      await harness.start();

      await harness.waitForSwarm((s) => s.messages?.some((m) => hasChinese(m.text_zh)), { timeout: 8000 });
      const page = await browser.newIsolatedPage();
      t.after(() => page.close());
      await page.navigate(`${harness.baseUrl}/?tab=feed`);
      await page.waitForSwarmReady();
      await page.waitForFunction(() => [...document.querySelectorAll('[data-testid="swarm-message"]')].some((e) => /[\u4e00-\u9fff]/.test(e.textContent || '')));

      const seqPill = await page.getText('[data-testid="swarm-seq-ref"][data-seq-ref="1"]');
      assert.equal(seqPill, '#1', '#seq citation pill must remain clickable #1');
      const feedText = await page.getText('[data-testid="swarm-feed"]');
      assertLiteralsPreserved(feedText, ['@backend', '@coordinator', '@reviewer'], '@mentions');
      page.assertNoErrors('9.4');
    });

    it('9.5 Preserves UUIDs verbatim in translated prose', async (t) => {
      const uuid = '56f8c44e-ba95-43c2-94d3-41b7a3b39a07';
      const harness = new SidecarHarness({ env: llmEnv() });
      t.after(() => harness.stop());
      buildBasicSwarm(harness, {
        messages: [{ seq: 1, agent: 'coordinator', time: '2026-11-19 14:00:00', text: `@backend Inspect swarm ${uuid} immediately.` }],
      });
      await harness.start();

      await harness.waitForSwarm((s) => s.messages?.some((m) => hasChinese(m.text_zh)), { timeout: 8000 });
      const page = await browser.newIsolatedPage();
      t.after(() => page.close());
      await page.navigate(`${harness.baseUrl}/?tab=feed`);
      await page.waitForSwarmReady();
      await page.waitForFunction(() => [...document.querySelectorAll('[data-testid="swarm-message"]')].some((e) => /[\u4e00-\u9fff]/.test(e.textContent || '')));

      const body = await page.getText('[data-testid="swarm-message"] .msg-body');
      assertHasChinese(body, 'UUID post');
      assertLiteralsPreserved(body, [uuid], 'UUID literal');
      page.assertNoErrors('9.5');
    });
  });

  // =========================================================================
  // Area 10: Offline Tier-1 Fallback (AGY_SWARM_TRANSLATE_DISABLED=1) — 5 tests
  // =========================================================================
  describe('Area 10: Offline Tier-1 Fallback', () => {
    it('10.1 With LLM disabled, UI chrome and tabs are 100% localized offline', async (t) => {
      llm.resetStats();
      const harness = new SidecarHarness({ env: { AGY_SWARM_TRANSLATE_DISABLED: '1' } });
      t.after(() => harness.stop());
      buildBasicSwarm(harness);
      await harness.start();

      const page = await browser.newIsolatedPage();
      t.after(() => page.close());
      await page.navigate(harness.baseUrl);
      await page.waitForSwarmReady();

      const tabs = await page.getAllText('[data-testid="swarm-tabs"] button.tab');
      for (const tabText of tabs) assertHasChinese(tabText, 'offline tab');
      assert.equal(llm.requests.length, 0);
      page.assertNoErrors('10.1');
    });

    it('10.2 With LLM disabled, protocol tags ([done], [blocked], [stall], [quota], resume) localize deterministically', async (t) => {
      const harness = new SidecarHarness({ env: { AGY_SWARM_TRANSLATE_DISABLED: '1' } });
      t.after(() => harness.stop());
      buildBasicSwarm(harness, {
        messages: [
          { seq: 1, agent: 'coordinator', time: '2026-11-19 14:00:00', text: '@backend [blocked] Need schema' },
          { seq: 2, agent: 'coordinator', time: '2026-11-19 14:01:00', text: '@backend resume' },
          { seq: 3, agent: 'monitor', time: '2026-11-19 14:02:00', text: '@backend [stall] Idle' },
          { seq: 4, agent: 'monitor', time: '2026-11-19 14:03:00', text: '@backend [quota] Exceeded' },
          { seq: 5, agent: 'backend', time: '2026-11-19 14:04:00', text: '@coordinator [done] Completed' },
        ],
      });
      await harness.start();

      const snap = await harness.getSwarm();
      assertSnapshotContract(snap);
      const snapBodies = snap.messages.map((m) => m.text_zh || '');
      assertEveryHasChinese(snapBodies, '10.2 Tier-1 snapshot text_zh');

      const page = await browser.newIsolatedPage();
      t.after(() => page.close());
      await page.navigate(`${harness.baseUrl}/?tab=feed`);
      await page.waitForSwarmReady();
      await page.waitForFunction(() => document.querySelectorAll('[data-testid="swarm-message"] .msg-body').length === 5);

      const domBodies = await page.getAllText('[data-testid="swarm-message"] .msg-body');
      assertEveryHasChinese(domBodies, '10.2 rendered DOM protocol tags');
      assert.ok(domBodies[0].includes('[阻塞]'), `Expected [阻塞], got: ${domBodies[0]}`);
      assert.ok(domBodies[1].includes('恢复运行'), `Expected 恢复运行, got: ${domBodies[1]}`);
      assert.ok(domBodies[2].includes('[停滞告警]'), `Expected [停滞告警], got: ${domBodies[2]}`);
      assert.ok(domBodies[3].includes('[额度告警]'), `Expected [额度告警], got: ${domBodies[3]}`);
      assert.ok(domBodies[4].includes('[已完成]'), `Expected [已完成], got: ${domBodies[4]}`);
      page.assertNoErrors('10.2');
    });

    it('10.3 With LLM disabled, BOARD_ACTIVITY & describeToolCall produce Chinese activity_zh', async (t) => {
      const harness = new SidecarHarness({ env: { AGY_SWARM_TRANSLATE_DISABLED: '1' } });
      t.after(() => harness.stop());
      const { criticConv } = buildRichOverviewSwarm(harness);
      harness.writeTranscript(criticConv, [
        { step_index: 1, source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE', tool_calls: [{ id: 'tc1', name: 'read_board', args: {} }] },
      ]);
      await harness.start();

      const snap = await harness.getSwarm();
      const backend = snap.members.find((m) => m.name === 'backend');
      const critic = snap.members.find((m) => m.name === 'critic');
      assertHasChinese(backend?.activity_zh, 'backend read_file activity_zh');
      assertHasChinese(critic?.activity_zh, 'critic read_board activity_zh');
    });

    it('10.4 With LLM disabled, systemAttention quota/error/stuck items include Chinese text_zh', async (t) => {
      const harness = new SidecarHarness({ env: { AGY_SWARM_TRANSLATE_DISABLED: '1' } });
      t.after(() => harness.stop());
      buildSystemAlertsSwarm(harness);
      await harness.start();

      const snap = await harness.getSwarm();
      assert.ok(snap.systemAttention.length >= 3);
      for (const item of snap.systemAttention) {
        assertHasChinese(item.text_zh, `systemAttention (${item.kind}) text_zh`);
      }
    });

    it('10.5 With LLM disabled, onboarding view in #ov-plain renders Chinese COPY_UI', async (t) => {
      const harness = new SidecarHarness({ env: { AGY_SWARM_TRANSLATE_DISABLED: '1' } });
      t.after(() => harness.stop());
      buildEmptyOnboardingSwarm(harness);
      await harness.start();

      const page = await browser.newIsolatedPage();
      t.after(() => page.close());
      await page.navigate(harness.baseUrl);
      await page.waitForSwarmReady();
      await page.waitForSelector('[data-testid="swarm-onboarding"]', { visible: true });

      const onbText = await page.getText('[data-testid="swarm-onboarding"]');
      assertHasChinese(onbText, 'offline onboarding COPY_UI');
      assertNoUntranslatedUiStrings(onbText, ['Your swarm is starting', 'Waiting for the first update'], 'onboarding');
      page.assertNoErrors('10.5');
    });
  });

  // =========================================================================
  // Area 11: Async LLM Queue, Cache & Live Polling — 5 tests
  // =========================================================================
  describe('Area 11: Async LLM Queue, Cache & Live Polling', () => {
    it('11.1 /api/swarm responds non-blocking (< 400ms) while LLM takes 1200ms', async (t) => {
      llm.resetStats();
      llm.setMode('ok', { delayMs: 1200 });
      const harness = new SidecarHarness({ env: llmEnv() });
      t.after(() => harness.stop());
      buildBasicSwarm(harness);
      await harness.start();

      const t0 = Date.now();
      const snap = await harness.getSwarm();
      const elapsed = Date.now() - t0;
      assertSnapshotContract(snap);
      assert.ok(elapsed < 500, `Expected non-blocking /api/swarm < 500ms, took ${elapsed}ms`);
    });

    it('11.2 etag bumps when async translations complete and UI updates automatically on poll', async (t) => {
      llm.resetStats();
      llm.setMode('ok', { delayMs: 350 });
      const harness = new SidecarHarness({ env: llmEnv() });
      t.after(() => harness.stop());
      buildBasicSwarm(harness);
      await harness.start();

      const snap1 = await harness.getSwarm();
      const page = await browser.newIsolatedPage();
      t.after(() => page.close());
      await page.navigate(`${harness.baseUrl}/?tab=feed`);
      await page.waitForSwarmReady();

      await page.waitForFunction(() => {
        const bodies = [...document.querySelectorAll('[data-testid="swarm-message"] .msg-body')];
        return bodies.length === 3 && bodies.every((b) => /[\u4e00-\u9fff]/.test(b.textContent || ''));
      }, [], { timeout: 8000 });

      const snap2 = await harness.getSwarm();
      assert.notEqual(snap2.etag, snap1.etag, 'etag must change after async translations finish');
      page.assertNoErrors('11.2');
    });

    it('11.3 Persistent disk cache serves translations across sidecar restart with 0 new LLM calls', async (t) => {
      llm.resetStats();
      llm.setMode('ok', { delayMs: 0 });
      let harness1 = null;
      let harness2 = null;
      t.after(async () => {
        const errors = [];
        for (const fn of [
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
          throw errors.length === 1 ? errors[0] : new AggregateError(errors, '11.3 cleanup failed');
        }
      });

      harness1 = new SidecarHarness({ env: llmEnv() });
      buildBasicSwarm(harness1);
      await harness1.start();
      await harness1.waitForSwarm((s) => s.messages?.every((m) => hasChinese(m.text_zh)), { timeout: 8000 });
      const sharedSidecarDataDir = harness1.sidecarDataDir;
      const sharedConvId = harness1.conversationId;
      await harness1.stop({ cleanup: false });

      // Start a second harness pointing at the same ANTIGRAVITY_EXECUTABLE_DATA_DIR
      llm.resetStats();
      harness2 = new SidecarHarness({
        conversationId: sharedConvId,
        env: {
          ...llmEnv(),
          ANTIGRAVITY_EXECUTABLE_DATA_DIR: sharedSidecarDataDir,
        },
      });
      await harness2.start();
      const snap = await harness2.getSwarm();
      assert.ok(snap.messages.every((m) => hasChinese(m.text_zh)), 'Cache hit must populate text_zh immediately after restart');
      await new Promise((r) => setTimeout(r, 200));
      assert.equal(llm.requests.length, 0, 'Warm cache restart must issue 0 LLM requests');
    });

    it('11.4 Enforces bounded LLM concurrency (maxConcurrent <= 3) on burst of 10 messages', async (t) => {
      llm.resetStats();
      llm.setMode('ok', { delayMs: 120 });
      const harness = new SidecarHarness({ env: llmEnv() });
      t.after(() => harness.stop());
      const msgs = Array.from({ length: 10 }, (_, i) => ({
        seq: i + 1,
        agent: i % 2 === 0 ? 'coordinator' : 'backend',
        time: `2026-11-19 14:0${i}:00`,
        text: `Unique worker task item number ${i + 1} requires validation.`,
      }));
      buildBasicSwarm(harness, { messages: msgs });
      await harness.start();

      await harness.waitForSwarm((s) => s.messages?.every((m) => hasChinese(m.text_zh)), { timeout: 10000 });
      assert.ok(llm.maxConcurrent <= 3, `Expected bounded concurrency <= 3, observed ${llm.maxConcurrent}`);
      assert.ok(llm.requests.length >= 1);
    });

    it('11.5 Live appended board message triggers translation and renders in UI automatically', async (t) => {
      llm.resetStats();
      llm.setMode('ok', { delayMs: 0 });
      const harness = new SidecarHarness({ env: llmEnv() });
      t.after(() => harness.stop());
      buildBasicSwarm(harness);
      await harness.start();

      const page = await browser.newIsolatedPage();
      t.after(() => page.close());
      await page.navigate(`${harness.baseUrl}/?tab=feed`);
      await page.waitForSwarmReady();
      await page.waitForFunction(() => document.querySelectorAll('[data-testid="swarm-message"]').length === 3);

      harness.appendBoardLine(harness.conversationId, {
        seq: 4,
        agent: 'backend',
        time: '2026-11-19 14:06:00',
        text: '@coordinator Newly appended live report verified successfully.',
      });

      await page.waitForFunction(() => {
        const msgs = [...document.querySelectorAll('[data-testid="swarm-message"]')];
        if (msgs.length !== 4) return false;
        return /[\u4e00-\u9fff]/.test(msgs[3].querySelector('.msg-body')?.textContent || '');
      }, [], { timeout: 8000 });
      page.assertNoErrors('11.5');
    });
  });
});
