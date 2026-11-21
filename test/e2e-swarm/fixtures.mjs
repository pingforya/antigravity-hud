import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const REAL_BRAIN_DIR = path.join(os.homedir(), '.gemini', 'antigravity', 'brain');
export const SWARM_56F8 = '56f8c44e-ba95-43c2-94d3-41b7a3b39a07';
export const SWARM_E0DA = 'e0dad013-dabb-4bc0-b691-776f657d5e79';

// Valid 1x1 transparent PNG (67 bytes)
export const MINIMAL_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
  'base64'
);

/**
 * Strictly read-only copier for real swarm data into an isolated SidecarHarness brainDir.
 */
export function copyRealSwarm(harness, swarmId) {
  const srcSwarmDir = path.join(REAL_BRAIN_DIR, swarmId, '.system_generated', 'swarm');
  if (!fs.existsSync(srcSwarmDir)) {
    throw new Error(`Real swarm source not found: ${srcSwarmDir}`);
  }
  const dstSwarmDir = harness.ensureSwarmDir(swarmId);
  fs.cpSync(srcSwarmDir, dstSwarmDir, { recursive: true });

  // Copy all member transcripts read-only so activity/status/counts match real environment
  const membersRaw = JSON.parse(fs.readFileSync(path.join(srcSwarmDir, 'members.json'), 'utf-8'));
  const members = membersRaw.members || {};
  for (const m of Object.values(members)) {
    const cid = m?.conversation_id;
    if (!cid || typeof cid !== 'string') continue;
    const srcTr = path.join(REAL_BRAIN_DIR, cid, '.system_generated', 'logs', 'transcript.jsonl');
    if (fs.existsSync(srcTr)) {
      const dstTr = harness.transcriptPath(cid);
      fs.mkdirSync(path.dirname(dstTr), { recursive: true });
      fs.copyFileSync(srcTr, dstTr);
    }
  }
  return dstSwarmDir;
}

export function buildBasicSwarm(harness, {
  convId = harness.conversationId,
  title = 'Audit and fix Hub window layouts',
  messages = null,
  members = null,
} = {}) {
  const workerConv = '22222222-2222-4222-8222-222222222222';
  const reviewerConv = '33333333-3333-4333-8333-333333333333';
  const defaultMembers = members || {
    coordinator: {
      conversation_id: convId,
      role: 'coordinator',
      model: 'gemini-4-neon-xhigh',
      wake_mode: 'mentions',
      last_read_seq: 3,
      killed: false,
    },
    backend: {
      conversation_id: workerConv,
      role: 'worker',
      model: 'gemini-4-neon-xhigh',
      wake_mode: 'mentions',
      last_read_seq: 3,
      killed: false,
    },
    reviewer: {
      conversation_id: reviewerConv,
      role: 'worker',
      model: 'claude-sonnet-4-6',
      wake_mode: 'working',
      last_read_seq: 2,
      killed: true,
    },
  };
  const defaultMessages = messages || [
    {
      seq: 1,
      agent: 'coordinator',
      kind: 'brief',
      time: '2026-11-19 14:00:00',
      text: '@backend Please inspect `C:\\repo\\src\\main.ts` and `/opt/app/config.json` and check https://example.com/docs/spec.',
    },
    {
      seq: 2,
      agent: 'backend',
      time: '2026-11-19 14:02:10',
      text: '@coordinator @reviewer #1 verified. Could you confirm the schema before I finalize?\n```js\nconst keepLiteral = "DO_NOT_TRANSLATE";\n```',
    },
    {
      seq: 3,
      agent: 'coordinator',
      time: '2026-11-19 14:05:00',
      text: '[done] All verification checks passed cleanly.',
    },
  ];
  harness.writeSwarmFiles(convId, {
    swarmJson: { version: 1, backend: 'local', swarm_id: convId, created_at: '2026-11-19T14:00:00Z' },
    membersJson: { title, members: defaultMembers },
    boardLines: defaultMessages,
  });
  return { convId, workerConv, reviewerConv };
}

export function buildRichOverviewSwarm(harness, {
  convId = harness.conversationId,
  includeNarrator = true,
  includeHtml = true,
  includeReel = true,
  killedNarrator = false,
  oversizedView = false,
} = {}) {
  const workerConv = '22222222-2222-4222-8222-222222222222';
  const criticConv = '33333333-3333-4333-8333-333333333333';
  const narratorConv = '44444444-4444-4444-8444-444444444444';

  const members = {
    coordinator: {
      conversation_id: convId,
      role: 'coordinator',
      model: 'gemini-4-neon-xhigh',
      wake_mode: 'mentions',
      last_read_seq: 6,
      killed: false,
    },
    backend: {
      conversation_id: workerConv,
      role: 'worker',
      model: 'gemini-4-neon-xhigh',
      wake_mode: 'mentions',
      last_read_seq: 6,
      killed: false,
    },
    critic: {
      conversation_id: criticConv,
      role: 'worker',
      model: 'claude-sonnet-4-6',
      wake_mode: 'mentions',
      last_read_seq: 5,
      killed: false,
    },
  };

  if (includeNarrator) {
    members.narrator = {
      conversation_id: narratorConv,
      role: 'narrator',
      model: 'gemini-3-flash',
      wake_mode: 'anything',
      last_read_seq: 4,
      killed: killedNarrator,
    };
  }

  const messages = [
    { seq: 1, agent: 'coordinator', kind: 'brief', time: '2026-11-19 14:50:00', text: '@backend Investigate the main process hook and report findings.' },
    { seq: 2, agent: 'coordinator', kind: 'brief', time: '2026-11-19 14:50:05', text: '@critic Review the proposed split pane layout.' },
    { seq: 3, agent: 'backend', time: '2026-11-19 14:52:00', text: '@coordinator Hook point found in main process (`src/main.ts`).' },
    { seq: 4, agent: 'critic', time: '2026-11-19 14:54:00', text: '@coordinator I disagree with freeform HTML; can you confirm JSON view model?' },
    { seq: 5, agent: 'backend', time: '2026-11-19 14:56:00', text: '@coordinator Integration checks 2 of 5 completed.' },
    { seq: 6, agent: 'coordinator', time: '2026-11-19 14:58:00', text: '@backend Continue checking remaining integration cases #5.' },
  ];

  const shot1 = harness.writeScreenshot(convId, 'ov-shot1.png', MINIMAL_PNG);
  const shot2 = harness.writeScreenshot(convId, 'ov-shot2.png', MINIMAL_PNG);

  let viewJson;
  if (oversizedView) {
    viewJson = JSON.stringify({
      version: 1,
      as_of_seq: 6,
      headline: 'Oversized overview payload test ' + 'A'.repeat(66000),
      goal: { title: 'Test oversized view.json', line: 'Should trigger 64 KB limit.' },
    });
  } else {
    viewJson = {
      version: 1,
      as_of_seq: 6,
      updated_at: '2026-11-19T15:00:00Z',
      headline: 'Drafting a design doc; research done, draft under review.',
      running_summary: 'Backend is running integration checks while critic reviews layout.',
      goal: {
        title: 'Audit and fix Hub window layouts',
        line: 'Four fixes landed; split pane polish in review.',
      },
      phase: { label: 'Review', index: 3, total: 4 },
      attention: [
        {
          id: 'att-html-vs-json',
          kind: 'decision',
          severity: 'high',
          title: 'Decide: freeform HTML or JSON view model?',
          why: 'critic and designer disagree; blocks the final doc',
          short: { title: 'HTML or JSON model?', line: 'Critic and designer disagree on final format.' },
          refs: [{ seq: 4 }, { member: 'critic' }],
          actions: [
            { type: 'board_post', target: 4, label: 'Jump to #4' },
          ],
        },
      ],
      workstreams: [
        {
          id: 'ws-backend',
          title: 'Backend research',
          owners: ['backend'],
          state: 'active',
          progress: { done: 2, total: 5 },
          note: 'Hook point found in main process',
          short: { title: 'Backend research', line: 'Found main-process hook; 2 of 5 checks done.' },
          refs: [{ seq: 3 }],
          actions: [],
        },
        {
          id: 'ws-critic',
          title: 'Layout review',
          owners: ['critic'],
          state: 'blocked',
          note: 'Waiting on format decision',
          refs: [{ seq: 4 }],
          actions: [],
        },
      ],
      threads: [
        {
          id: 't-split',
          title: 'Split pane cards',
          goal: 'Put split panes inside shared cards.',
          now: 'Folding polish into the fix',
          workstreams: ['ws-backend', 'ws-critic'],
          attention: ['att-html-vs-json'],
        },
      ],
      milestones: [{ id: 'm-3', text: 'Backend report posted', refs: [{ seq: 3 }] }],
      risks: [{ id: 'r-cost', text: 'Always-on member adds token cost', refs: [{ seq: 3 }] }],
      now: { coordinator: 'Reviewing backend report', backend: 'Running integration checks' },
      feedback_ack: { through_seq: 4, text: 'Switched to a kanban, as you asked.' },
      ...(includeReel ? {
        reel: {
          frames: [
            { path: shot1.posixPath, seq: 3, caption: 'Baseline header before alignment' },
            { path: shot2.posixPath, seq: 5, caption: 'Aligned split pane cards' },
          ],
        },
      } : {}),
    };
  }

  const viewHtml = includeHtml
    ? `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><style>body{font-family:sans-serif;padding:12px;}</style></head>
<body>
  <h2 id="narrator-headline">Loading view...</h2>
  <div id="narrator-summary"></div>
  <div id="narrator-att" data-narrator-id="att-html-vs-json">Pending decision</div>
  <button id="narrator-jump" type="button">Open #4</button>
  <script>
    window.narrator.onData(function(view, meta) {
      document.getElementById('narrator-headline').textContent = view.headline || '';
      document.getElementById('narrator-summary').textContent = view.running_summary || '';
      if (view.attention && view.attention[0]) {
        document.getElementById('narrator-att').textContent = view.attention[0].title || '';
      }
      document.getElementById('narrator-jump').onclick = function() {
        window.narrator.navigate({ type: 'board_post', target: 4 });
      };
    });
  </script>
</body>
</html>`
    : null;

  harness.writeSwarmFiles(convId, {
    swarmJson: { version: 1, backend: 'local', swarm_id: convId, created_at: '2026-11-19T14:50:00Z' },
    membersJson: { title: 'Hub Window Layout Audit', members },
    boardLines: messages,
    viewJson,
    viewHtml,
  });

  // Write live working transcript for backend + narrator transcript
  harness.writeTranscript(workerConv, [
    {
      step_index: 1,
      source: 'MODEL',
      type: 'PLANNER_RESPONSE',
      status: 'DONE',
      thinking: 'Checking code.\n\n**Auditing search filter behavior**\nReading lines.',
      tool_calls: [{ id: 'tc1', name: 'read_file', args: { Path: 'C:\\repo\\src\\main.ts' } }],
    },
  ]);
  if (includeNarrator && !killedNarrator) {
    harness.writeTranscript(narratorConv, [
      {
        step_index: 1,
        source: 'MODEL',
        type: 'PLANNER_RESPONSE',
        status: 'DONE',
        tool_calls: [{ id: 'tc1', name: 'swarm_wait', args: {} }],
      },
      { step_index: 2, source: 'SYSTEM', type: 'GENERIC', status: 'DONE' },
    ]);
  }

  return { convId, workerConv, criticConv, narratorConv, shot1, shot2 };
}

export function buildPlanAndChannelsSwarm(harness, { convId = harness.conversationId } = {}) {
  const parserConv = '22222222-2222-4222-8222-222222222222';
  const reviewerConv = '33333333-3333-4333-8333-333333333333';

  const members = {
    coordinator: {
      conversation_id: convId,
      role: 'coordinator',
      model: 'gemini-4-neon-xhigh',
      wake_mode: 'mentions',
      last_read_seq: 7,
      killed: false,
    },
    parser: {
      conversation_id: parserConv,
      role: 'worker',
      model: 'gemini-4-neon-xhigh',
      wake_mode: 'mentions',
      last_read_seq: 5,
      channels: ['parser'],
      killed: false,
    },
    reviewer: {
      conversation_id: reviewerConv,
      role: 'worker',
      model: 'claude-sonnet-4-6',
      wake_mode: 'mentions',
      last_read_seq: 2,
      channels: [],
      killed: false,
    },
  };

  const messages = [
    { seq: 1, agent: 'coordinator', kind: 'brief', time: '2026-11-19 15:00:00', text: '@parser Implement AST parser module.' },
    { seq: 2, agent: 'coordinator', channel: 'parser', time: '2026-11-19 15:00:10', text: '[channel] created #parser (lexer and parser)', control: { op: 'create', channel: 'parser', topic: 'lexer and parser' } },
    { seq: 3, agent: 'coordinator', time: '2026-11-19 15:00:20', text: '[channel] subscribed reviewer to #parser', control: { op: 'subscribe', channel: 'parser', members: ['reviewer'], prev: { reviewer: [] }, next: { reviewer: ['parser'] } } },
    { seq: 4, agent: 'parser', channel: 'parser', time: '2026-11-19 15:01:00', text: '@#parser AST ready for review.' },
    { seq: 5, agent: 'coordinator', time: '2026-11-19 15:02:00', text: '[channel] unsubscribed reviewer from #parser', control: { op: 'unsubscribe', channel: 'parser', members: ['reviewer'], prev: { reviewer: ['parser'] }, next: { reviewer: [] } } },
    { seq: 6, agent: 'coordinator', time: '2026-11-19 15:03:00', text: '[channel] archived #parser', control: { op: 'archive', channel: 'parser' } },
    { seq: 7, agent: 'parser', time: '2026-11-19 15:04:00', text: '@coordinator @#parser Posting to archived channel and main summary.' },
  ];

  const planJson = {
    goal: { title: 'Fix Hub split pane layouts', line: 'Audit, fix, then verify in both themes.' },
    tasks: { parser: 'Audit split panes across states', reviewer: 'Put split panes in one card' },
    threads: [
      { id: 't-split', title: 'Split pane cards', goal: 'Panes share one card with clean headers.', tasks: ['parser', 'reviewer'] },
    ],
  };

  harness.writeSwarmFiles(convId, {
    swarmJson: { version: 1, backend: 'local', swarm_id: convId, created_at: '2026-11-19T15:00:00Z' },
    membersJson: { title: 'Parser & Channel Plan Swarm', members },
    boardLines: messages,
    planJson,
  });

  return { convId, parserConv, reviewerConv };
}

export function buildSystemAlertsSwarm(harness, { convId = harness.conversationId } = {}) {
  const quotaConv = '22222222-2222-4222-8222-222222222222';
  const errConv = '33333333-3333-4333-8333-333333333333';
  const stuckConv = '44444444-4444-4444-8444-444444444444';
  const thinkConv = '55555555-5555-4555-8555-555555555555';

  const members = {
    coordinator: { conversation_id: convId, role: 'coordinator', model: 'gemini-4-neon-xhigh', wake_mode: 'mentions', last_read_seq: 2, killed: false },
    quotaworker: { conversation_id: quotaConv, role: 'worker', model: 'gemini-4-neon-xhigh', wake_mode: 'mentions', last_read_seq: 2, killed: false },
    errworker: { conversation_id: errConv, role: 'worker', model: 'gemini-4-neon-xhigh', wake_mode: 'mentions', last_read_seq: 2, killed: false },
    stuckworker: { conversation_id: stuckConv, role: 'worker', model: 'gemini-4-neon-xhigh', wake_mode: 'mentions', last_read_seq: 2, killed: false },
    thinker: { conversation_id: thinkConv, role: 'worker', model: 'gemini-4-neon-xhigh', wake_mode: 'mentions', last_read_seq: 2, killed: false },
  };

  const messages = [
    { seq: 1, agent: 'coordinator', kind: 'brief', time: '2026-11-19 14:00:00', text: '@quotaworker @errworker @stuckworker @thinker Execute diagnostics.' },
    { seq: 2, agent: 'thinker', time: '2026-11-19 14:01:00', text: '@coordinator Starting diagnostics pass.' },
  ];

  harness.writeSwarmFiles(convId, {
    swarmJson: { version: 1, backend: 'local', swarm_id: convId, created_at: '2026-11-19T14:00:00Z' },
    membersJson: { title: 'System Alerts Diagnostic Swarm', members },
    boardLines: messages,
  });

  // 1. Immediate ERROR_MESSAGE 429 quota
  harness.writeTranscript(quotaConv, [
    { step_index: 1, source: 'SYSTEM', type: 'ERROR_MESSAGE', status: 'DONE', error: 'API error (attempt 1): 429 RESOURCE_EXHAUSTED quota exceeded' },
  ]);

  // 2. Settled tool step error (mtime 90s ago)
  harness.writeTranscript(errConv, [
    { step_index: 1, source: 'SYSTEM', type: 'GENERIC', status: 'ERROR', error: 'Command failed with exit code 1' },
  ], { mtimeMs: Date.now() - 90_000 });

  // 3. Stuck working > 10 minutes (mtime 15m ago, working status)
  harness.writeTranscript(stuckConv, [
    { step_index: 1, source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE', tool_calls: [{ id: 'tc1', name: 'read_file', args: { Path: 'C:\\repo\\a.js' } }] },
  ], { mtimeMs: Date.now() - 15 * 60_000 });

  // 4. Thinking heading live worker
  harness.writeTranscript(thinkConv, [
    { step_index: 1, source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE', thinking: 'Analyzing.\n\n**Auditing search filter behavior**\nChecking lines.', tool_calls: [] },
    { step_index: 2, source: 'USER', type: 'USER_INPUT', status: 'DONE' },
  ]);
  // Note: to keep thinkingHeading as the activity of an actively working member, put USER_INPUT before PLANNER_RESPONSE with empty tool_calls? Wait:
  // If newest step is PLANNER_RESPONSE with tool_calls: [], idle=true (waiting/replied).
  // To have status === 'working' AND thinkingHeading, put a tool_calls entry that describeToolCall returns '' for (or put PLANNER_RESPONSE followed by pending state? Wait: let's write a PLANNER_RESPONSE with thinkingHeading and an unknown tool_call? No, unknown tool_call returns tc.name!).
  // Wait: if the newest step is USER_INPUT or EPHEMERAL_MESSAGE AFTER a PLANNER_RESPONSE with thinkingHeading and tool_calls: [], summarizeTranscript walks backwards, skips USER_INPUT? No, it STOPS at USER_INPUT!
  // Let's re-check: if step 1 is PLANNER_RESPONSE (thinkingHeading, tool_calls: []) -> idle: true, activity: 'Auditing search filter behavior', activityKind: 'thinking'.
  // What if step 1 is PLANNER_RESPONSE (thinkingHeading, tool_calls: [{ name: '' }]) -> wait: activity is STILL populated for idle/working!
  harness.writeTranscript(thinkConv, [
    { step_index: 1, source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE', thinking: 'Analyzing.\n\n**Auditing search filter behavior**\nChecking lines.', tool_calls: [] },
  ]);

  return { convId, quotaConv, errConv, stuckConv, thinkConv };
}

export function buildScreenshotSwarm(harness, { convId = harness.conversationId } = {}) {
  const uiConv = '22222222-2222-4222-8222-222222222222';
  const s1 = harness.writeScreenshot(convId, 'screen-1.png', MINIMAL_PNG);
  const s2 = harness.writeScreenshot(convId, 'screen-2.png', MINIMAL_PNG);

  harness.writeSwarmFiles(convId, {
    swarmJson: { version: 1, backend: 'local', swarm_id: convId, created_at: '2026-11-19T15:00:00Z' },
    membersJson: {
      title: 'Screenshot Reel Swarm',
      members: {
        coordinator: { conversation_id: convId, role: 'coordinator', model: 'gemini-4-neon-xhigh', wake_mode: 'mentions', last_read_seq: 3, killed: false },
        uiworker: { conversation_id: uiConv, role: 'worker', model: 'gemini-4-neon-xhigh', wake_mode: 'mentions', last_read_seq: 3, killed: false },
      },
    },
    boardLines: [
      { seq: 1, agent: 'coordinator', kind: 'brief', time: '2026-11-19 15:00:00', text: '@uiworker Capture before and after UI screenshots.' },
      { seq: 2, agent: 'uiworker', time: '2026-11-19 15:01:00', text: `First screenshot ready.\nScreenshot: ${s1.posixPath} | Baseline header before alignment` },
      { seq: 3, agent: 'uiworker', time: '2026-11-19 15:02:00', text: `@coordinator [done] Fixed layout.\nScreenshot: ${s2.posixPath} | Aligned split pane cards` },
    ],
  });

  return { convId, uiConv, s1, s2 };
}

export function buildEmptyOnboardingSwarm(harness, { convId = harness.conversationId } = {}) {
  harness.writeSwarmFiles(convId, {
    swarmJson: { version: 1, backend: 'local', swarm_id: convId, created_at: '2026-11-19T15:00:00Z' },
    membersJson: {
      title: 'Onboarding Swarm',
      members: {
        coordinator: { conversation_id: convId, role: 'coordinator', model: 'gemini-4-neon-xhigh', wake_mode: 'mentions', last_read_seq: 0, killed: false },
      },
    },
    boardLines: [],
  });
  return { convId };
}

export function buildRemoteSwarm(harness, {
  convId = '11111111-1111-4111-8111-111111111111',
  remoteSwarmId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  label = 'Fleet',
} = {}) {
  const remoteDoc = {
    version: 1,
    swarm_id: remoteSwarmId,
    title: 'Remote Build Swarm',
    head: 2,
    since: 0,
    channels: [{ name: 'build', topic: 'CI pipeline', created_by: 'coordinator', archived: false }],
    members: {
      coordinator: {
        conversation_id: remoteSwarmId,
        role: 'coordinator',
        model: 'gemini-4-neon-xhigh',
        wake_mode: 'mentions',
        phase: 'RUNNING',
        desired_state: 'RUNNING',
        owner_label: 'agent@host-1',
        owner_kind: 'AGENT',
        updated_at: new Date(Date.now() - 60_000).toISOString(),
      },
      builder: {
        conversation_id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        role: 'worker',
        model: 'gemini-4-neon-xhigh',
        wake_mode: 'mentions',
        phase: 'RUNNING',
        desired_state: 'RUNNING',
        owner_label: 'ci-worker@linux-2',
        owner_kind: 'HUMAN',
        updated_at: new Date(Date.now() - 5 * 60_000).toISOString(),
      },
    },
    messages: [
      { seq: 1, agent: 'coordinator', text: '@builder run tests on #build', time: '2026-11-19 14:54:00' },
      { seq: 2, agent: 'builder', channel: 'build', text: '@coordinator [done] Tests passed cleanly', time: '2026-11-19 14:55:00' },
    ],
  };

  const scriptBody = `
const doc = ${JSON.stringify(remoteDoc)};
process.stdout.write(JSON.stringify(doc) + '\\n');
process.stdin.resume();
process.stdin.on('end', () => process.exit(0));
`;
  harness.configureRemoteBoard({ backend: 'mock-remote', label, scriptBody });
  harness.writeSwarmFiles(convId, {
    swarmJson: { version: 1, backend: 'mock-remote', swarm_id: remoteSwarmId, db: 'testdb' },
  });
  return { convId, remoteSwarmId, remoteDoc };
}
