'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawnSync } = require('node:child_process');
const P = require('../paths.cjs');

const root = path.resolve(__dirname, '..');
const plugin = path.join(root, 'plugins/agy-hud');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'hakimi-mode-test-'));
process.env.AGY_HUD_DATA_DIR = temp;
const tempBrainRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hakimi-brain-default-'));
const tempBrainDefault = path.join(tempBrainRoot, 'brain');
fs.mkdirSync(tempBrainDefault, { recursive: true });
process.env.AGY_BRAIN_DIR = tempBrainDefault;
process.env.AGY_HUD_MEMORY_FILE = path.join(plugin, 'assets', 'hakimi-memory.md');
delete process.env.AGY_HUD_DEFAULT_PERSONA;

const mode = require(path.join(plugin, 'scripts/persona-mode.cjs'));
const { handleHook, pruneOldTimingFiles } = require(path.join(plugin, 'scripts/hud-hook.cjs'));

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const C = '33333333-3333-4333-8333-333333333333';
let server, base;

function loadJSDOM() {
  try { return require('jsdom').JSDOM; } catch (_) {}
  for (const c of [path.join(root, 'node_modules', 'jsdom'), path.join(P.CHINESE_ROOT, 'node_modules', 'jsdom')]) {
    if (fs.existsSync(c)) return require(c).JSDOM;
  }
  throw new Error('JSDOM not found');
}

before(async () => {
  server = http.createServer((req, res) => {
    if (!mode.handleRequest(req, res, new URL(req.url, 'http://localhost'))) {
      res.writeHead(404);
      res.end();
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = 'http://127.0.0.1:' + server.address().port;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  assert.ok(path.resolve(temp).startsWith(path.resolve(os.tmpdir()) + path.sep));
  fs.rmSync(temp, { recursive: true, force: true });
  assert.ok(path.resolve(tempBrainRoot).startsWith(path.resolve(os.tmpdir()) + path.sep));
  fs.rmSync(tempBrainRoot, { recursive: true, force: true });
});

test('default cat, independent chat modes, and persistence in another process', () => {
  assert.equal(mode.getMode(A), 'hakimi');
  mode.setMode(A, 'normal');
  assert.equal(mode.getMode(A), 'normal');
  assert.equal(mode.getMode(B), 'hakimi');
  const child = spawnSync(
    process.execPath,
    ['-e', `console.log(require(${JSON.stringify(path.join(plugin, 'scripts/persona-mode.cjs'))}).getMode(${JSON.stringify(A)}))`],
    { encoding: 'utf8', env: process.env }
  );
  assert.equal(child.status, 0);
  assert.equal(child.stdout.trim(), 'normal');
  mode.setMode(A, 'hakimi');
});

test('staged new-chat draft is claimed on Turn #1 PreInvocation even before StartCascadeResponse returns cascadeId', () => {
  const staged = mode.stagePendingNewChat('normal', 'tok-first-turn');
  assert.equal(staged.mode, 'normal');
  // PreInvocation fires for brand-new conversation C before commitPendingNewChat runs
  const firstTurnHook = handleHook('PreInvocation', {
    common: { conversationId: C },
    preInvocationHookArgs: { invocationNum: 0, initialNumSteps: 1 }
  });
  assert.equal(firstTurnHook.injectSteps.length, 1);
  assert.ok(firstTurnHook.injectSteps[0].ephemeralMessage.includes('正常助手模式'));
  assert.equal(mode.getMode(C), 'normal');
  // Subsequent commitPendingNewChat cleans up the ticket idempotently
  mode.commitPendingNewChat(C, 'normal', staged.token);
  assert.equal(mode.getMode(C), 'normal');
});

test('hook changes actual context, never tool permission or another chat', () => {
  mode.setMode(A, 'normal');
  const normal = handleHook('PreInvocation', { conversationId: A });
  assert.equal(normal.injectSteps.length, 1);
  assert.ok(normal.injectSteps[0].ephemeralMessage.includes('正常助手模式'));
  assert.ok(!normal.injectSteps[0].ephemeralMessage.includes('## 哈基米'));
  assert.ok(normal.injectSteps[0].ephemeralMessage.includes('不主动读写 hakimi-memory'));
  assert.ok(!normal.injectSteps[0].ephemeralMessage.includes('sync_retain'));

  const cat = handleHook('PreInvocation', { common: { conversationId: B } });
  assert.ok(cat.injectSteps[0].ephemeralMessage.includes('## 哈基米'));
  assert.ok(cat.injectSteps[0].ephemeralMessage.includes('sync_retain'));

  for (const ev of ['PostInvocation', 'Stop', 'PreToolUse']) {
    assert.deepEqual(handleHook(ev, { conversationId: A }), {});
  }
  assert.deepEqual(mode.hookContext({}), {});
  assert.ok(!('decision' in normal));
  mode.setMode(A, 'hakimi');
});

test('subagent invocations via payload markers never steal staged tickets or inject hakimi-memory', () => {
  const SUB_1 = '44444444-4444-4444-8444-444444444444';
  const SUB_2 = '55555555-5555-4555-8555-555555555555';
  const SUB_3 = '66666666-6666-4666-8666-666666666666';
  const USER_CHAT = '77777777-7777-4777-8777-777777777777';

  const staged = mode.stagePendingNewChat('normal', 'tok-subagent-safe-payload');

  // Various payload representations of worker subagents on Turn #1
  const res1 = handleHook('PreInvocation', {
    common: { conversationId: SUB_1, parentConversationId: A },
    preInvocationHookArgs: { invocationNum: 0, initialNumSteps: 0 }
  });
  const res2 = handleHook('PreInvocation', {
    conversationId: SUB_2,
    parentConversationId: A,
    invocationNum: 0,
    initialNumSteps: 1
  });
  const res3 = handleHook('PreInvocation', {
    common: { conversationId: SUB_3, isSubagent: true, subagentType: 'research', nestingDepth: 1 },
    preInvocationHookArgs: { invocationNum: 0, initialNumSteps: 1 }
  });

  assert.deepEqual(res1, {});
  assert.deepEqual(res2, {});
  assert.deepEqual(res3, {});
  for (const sid of [SUB_1, SUB_2, SUB_3]) {
    assert.equal(fs.existsSync(path.join(temp, `persona_${sid}.json`)), false);
  }

  // The user's staged ticket must still be intact for the real new user chat
  const userTurn = handleHook('PreInvocation', {
    common: { conversationId: USER_CHAT },
    preInvocationHookArgs: { invocationNum: 0, initialNumSteps: 1 }
  });
  assert.equal(userTurn.injectSteps.length, 1);
  assert.ok(userTurn.injectSteps[0].ephemeralMessage.includes('正常助手模式'));
  assert.equal(mode.getMode(USER_CHAT), 'normal');
  mode.commitPendingNewChat(USER_CHAT, 'normal', staged.token);

  // If a user explicitly sets a persona file for a subagent ID, honor it
  mode.setMode(SUB_1, 'normal');
  const explicitOverride = handleHook('PreInvocation', {
    common: { conversationId: SUB_1, parentConversationId: A }
  });
  assert.equal(explicitOverride.injectSteps.length, 1);
  assert.ok(explicitOverride.injectSteps[0].ephemeralMessage.includes('正常助手模式'));
});

test('subagent invocations identified via isolated AGY_BRAIN_DIR transcript.jsonl or summary DB never steal tickets or inject persona', () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hakimi-brain-test-'));
  const tempBrain = path.join(tempRoot, 'brain');
  fs.mkdirSync(tempBrain, { recursive: true });
  const prevBrain = process.env.AGY_BRAIN_DIR;
  process.env.AGY_BRAIN_DIR = tempBrain;

  const SUB_TRANSCRIPT_DIRECT = '88888888-8888-4888-8888-888888888888';
  const SUB_TRANSCRIPT_EPHEMERAL = '99999999-9999-4999-8999-999999999999';
  const SUB_DB_TURN0 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const MAIN_QUOTING_LOG = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  const MAIN_DEFAULT = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
  const MAIN_ORCHESTRATOR = 'ffffffff-ffff-4fff-8fff-ffffffffffff';

  const writeTranscript = (cid, steps) => {
    const dir = path.join(tempBrain, cid, '.system_generated', 'logs');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'transcript.jsonl'),
      steps.map((s) => JSON.stringify(s)).join('\n') + '\n',
      'utf8'
    );
  };

  try {
    // 1. Subagent transcript starting directly with SYSTEM_MESSAGE from parent sender
    writeTranscript(SUB_TRANSCRIPT_DIRECT, [
      {
        step_index: 0,
        source: 'SYSTEM',
        type: 'SYSTEM_MESSAGE',
        status: 'DONE',
        content: `The following is a <SYSTEM_MESSAGE> not actually sent by the user.\n\n<SYSTEM_MESSAGE>\n[Message] timestamp=2026-11-14T18:06:12Z sender=${A} priority=MESSAGE_PRIORITY_HIGH content=Generate audit report.\n</SYSTEM_MESSAGE>`
      }
    ]);

    // 2. Subagent transcript with an earlier EPHEMERAL_MESSAGE at step 0 and SYSTEM_MESSAGE at step 1
    writeTranscript(SUB_TRANSCRIPT_EPHEMERAL, [
      {
        step_index: 0,
        source: 'SYSTEM_SDK',
        type: 'EPHEMERAL_MESSAGE',
        status: 'DONE',
        content: 'ephemeral header'
      },
      {
        step_index: 1,
        source: 'SYSTEM',
        type: 'SYSTEM_MESSAGE',
        status: 'DONE',
        content: `<SYSTEM_MESSAGE>\n[Message] timestamp=2026-11-14T18:06:12Z sender=${B} priority=MESSAGE_PRIORITY_HIGH content=Build slides.\n</SYSTEM_MESSAGE>`
      }
    ]);

    // 3. Main user chat where USER_INPUT happens to quote a subagent [Message] log AND later gets a subagent reply
    writeTranscript(MAIN_QUOTING_LOG, [
      {
        step_index: 0,
        source: 'USER_EXPLICIT',
        type: 'USER_INPUT',
        status: 'DONE',
        content: `<USER_REQUEST>\nCheck this log: [Message] timestamp=2026-11-14T18:06:12Z sender=${A} and <subagent_reminder>\n</USER_REQUEST>`
      },
      {
        step_index: 1,
        source: 'MODEL',
        type: 'PLANNER_RESPONSE',
        status: 'DONE',
        content: 'Inspecting...'
      },
      {
        step_index: 2,
        source: 'SYSTEM',
        type: 'SYSTEM_MESSAGE',
        status: 'DONE',
        content: `<SYSTEM_MESSAGE>\n[Message] timestamp=2026-11-14T18:07:00Z sender=${SUB_TRANSCRIPT_DIRECT} content=Done.\n</SYSTEM_MESSAGE>`
      }
    ]);

    // 4. Optional Turn-0 SQLite summary DB before transcript.jsonl is flushed
    let hasSqlite = false;
    try {
      const { DatabaseSync } = require('node:sqlite');
      hasSqlite = true;
      const db = new DatabaseSync(path.join(tempRoot, 'conversation_summaries.db'));
      db.exec(`
        CREATE TABLE conversation_summaries (
          conversation_id TEXT PRIMARY KEY,
          agent_name TEXT,
          parent_conversation_id TEXT,
          nesting_depth INTEGER
        );
      `);
      const ins = db.prepare('INSERT INTO conversation_summaries VALUES (?, ?, ?, ?)');
      ins.run(SUB_DB_TURN0, 'self', A, 1);
      ins.run(MAIN_DEFAULT, '', '', 0);
      ins.run(MAIN_ORCHESTRATOR, 'orchestrator', '', 0);
      db.close();
    } catch (_) {}

    const staged = mode.stagePendingNewChat('normal', 'tok-subagent-safe-transcript');

    // Payload has NO parentConversationId — subagent status must be detected from disk!
    assert.deepEqual(
      handleHook('PreInvocation', {
        common: { conversationId: SUB_TRANSCRIPT_DIRECT },
        preInvocationHookArgs: { invocationNum: 0, initialNumSteps: 1 }
      }),
      {}
    );
    assert.deepEqual(
      handleHook('PreInvocation', {
        common: { conversationId: SUB_TRANSCRIPT_EPHEMERAL },
        preInvocationHookArgs: { invocationNum: 1, initialNumSteps: 2 }
      }),
      {}
    );
    if (hasSqlite) {
      assert.deepEqual(
        handleHook('PreInvocation', {
          common: { conversationId: SUB_DB_TURN0 },
          preInvocationHookArgs: { invocationNum: 0, initialNumSteps: 0 }
        }),
        {}
      );
    }

    // None of the subagents stole the staged 'normal' ticket; MAIN_QUOTING_LOG claims it!
    const mainClaim = handleHook('PreInvocation', {
      common: { conversationId: MAIN_QUOTING_LOG },
      preInvocationHookArgs: { invocationNum: 0, initialNumSteps: 1 }
    });
    assert.equal(mainClaim.injectSteps.length, 1);
    assert.ok(mainClaim.injectSteps[0].ephemeralMessage.includes('正常助手模式'));
    assert.equal(mode.getMode(MAIN_QUOTING_LOG), 'normal');
    mode.commitPendingNewChat(MAIN_QUOTING_LOG, 'normal', staged.token);

    // Main conversation with no transcript file and depth=0 still gets default 'hakimi'
    const mainCat = handleHook('PreInvocation', { common: { conversationId: MAIN_DEFAULT } });
    assert.equal(mainCat.injectSteps.length, 1);
    assert.ok(mainCat.injectSteps[0].ephemeralMessage.includes('## 哈基米'));
    assert.ok(mainCat.injectSteps[0].ephemeralMessage.includes('sync_retain'));

    // Top-level custom agent chat (e.g. Orchestrator (Carbon): agent_name='orchestrator', parent='', depth=0) is NOT a subagent!
    const orchCat = handleHook('PreInvocation', {
      common: { conversationId: MAIN_ORCHESTRATOR, agentName: 'orchestrator' },
      preInvocationHookArgs: { invocationNum: 0, initialNumSteps: 1 }
    });
    assert.equal(orchCat.injectSteps.length, 1);
    assert.ok(orchCat.injectSteps[0].ephemeralMessage.includes('## 哈基米'));
  } finally {
    if (prevBrain === undefined) delete process.env.AGY_BRAIN_DIR;
    else process.env.AGY_BRAIN_DIR = prevBrain;
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('pruneOldTimingFiles cleans stale .tmp-<pid>-<uuid> files >60s old while preserving fresh .tmp and persona files', () => {
  const pruneDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hakimi-prune-test-'));
  try {
    const stalePersonaTmp = path.join(pruneDir, `persona_${A}.json.tmp-4321-a1b2c3d4-e5f6-4789-8012-3456789abcde`);
    const stalePendingTmp = path.join(pruneDir, 'pending_new_chats.json.tmp-9876-ABCDEF01-2345-4678-9ABC-DEF012345678');
    const staleTimingTmp = path.join(pruneDir, `timing_${A}.jsonl.tmp-4321`);
    const staleLock = path.join(pruneDir, 'pending_new_chats.lock');
    const freshPersonaTmp = path.join(pruneDir, `persona_${B}.json.tmp-5555-11111111-2222-4333-8444-555555555555`);
    const realPersonaFile = path.join(pruneDir, `persona_${A}.json`);

    for (const f of [stalePersonaTmp, stalePendingTmp, staleTimingTmp, staleLock, freshPersonaTmp, realPersonaFile]) {
      fs.writeFileSync(f, '{"mode":"normal"}\n', 'utf8');
    }

    const oldDate = new Date(Date.now() - 120 * 1000);
    for (const f of [stalePersonaTmp, stalePendingTmp, staleTimingTmp, staleLock]) {
      fs.utimesSync(f, oldDate, oldDate);
    }

    const removed = pruneOldTimingFiles(pruneDir);
    assert.equal(removed, 4);
    assert.equal(fs.existsSync(stalePersonaTmp), false);
    assert.equal(fs.existsSync(stalePendingTmp), false);
    assert.equal(fs.existsSync(staleTimingTmp), false);
    assert.equal(fs.existsSync(staleLock), false);
    assert.equal(fs.existsSync(freshPersonaTmp), true);
    assert.equal(fs.existsSync(realPersonaFile), true);
  } finally {
    fs.rmSync(pruneDir, { recursive: true, force: true });
  }
});

test('invalid IDs/tokens cannot corrupt state; multi-ticket queue claims distinctly', () => {
  assert.throws(() => mode.setMode('../other', 'normal'));
  assert.throws(() => mode.setMode(A, 'other'));
  assert.throws(() => mode.stagePendingNewChat('other', 'tok'));
  assert.throws(() => mode.stagePendingNewChat('normal', 12345));
  assert.throws(() => mode.stagePendingNewChat('normal', 'bad\ntoken'));
  assert.throws(() => mode.commitPendingNewChat(A, 'normal', { bad: true }));
  assert.equal(mode.cancelPendingNewChat(''), false);
  assert.equal(mode.cancelPendingNewChat('bad\0tok'), false);

  fs.writeFileSync(path.join(temp, 'persona_' + A + '.json'), 'broken');
  assert.throws(() => mode.getMode(A));
  mode.setMode(A, 'hakimi');

  // Two distinct queued tickets are claimed one-by-one without colliding
  const D1 = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
  const D2 = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
  const t1 = mode.stagePendingNewChat('normal', 'tok-q1');
  const t2 = mode.stagePendingNewChat('hakimi', 'tok-q2');
  const h1 = handleHook('PreInvocation', { common: { conversationId: D1 }, preInvocationHookArgs: { invocationNum: 0, initialNumSteps: 1 } });
  const h2 = handleHook('PreInvocation', { common: { conversationId: D2 }, preInvocationHookArgs: { invocationNum: 0, initialNumSteps: 1 } });
  assert.ok(h1.injectSteps[0].ephemeralMessage.includes('正常助手模式'));
  assert.ok(h2.injectSteps[0].ephemeralMessage.includes('## 哈基米'));
  mode.commitPendingNewChat(D1, 'normal', t1.token);
  mode.commitPendingNewChat(D2, 'hakimi', t2.token);
});

test('real HTTP endpoints require exact chat, reject OPTIONS/bad JSON, and require explicit JSON mutation', async () => {
  assert.equal((await fetch(base + '/api/persona')).status, 400);
  const optRes = await fetch(base + '/api/persona?conversationId=' + A, { method: 'OPTIONS' });
  assert.equal(optRes.status, 405);
  assert.equal(optRes.headers.get('access-control-allow-origin'), null);

  assert.equal((await fetch(base + '/api/persona?conversationId=' + A, { method: 'POST', body: 'mode=normal' })).status, 403);
  assert.equal(
    (await fetch(base + '/api/persona?conversationId=' + A, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-AGY-Persona': '1' },
      body: '{bad json'
    })).status,
    400
  );

  const response = await fetch(base + '/api/persona?conversationId=' + A, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-AGY-Persona': '1' },
    body: JSON.stringify({ mode: 'normal' })
  });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).mode, 'normal');
  assert.equal((await (await fetch(base + '/api/persona?conversationId=' + B)).json()).mode, 'hakimi');
  mode.setMode(A, 'hakimi');
});

test('real UI buttons switch only their chat and reload the saved mode', async () => {
  const JSDOM = loadJSDOM();
  const html = fs.readFileSync(path.join(plugin, 'sidecars/telemetry/ui.html'), 'utf8');
  const parsed = new JSDOM(html);
  const cardEl = parsed.window.document.getElementById('persona-card');
  assert.ok(cardEl, '#persona-card must exist in ui.html');
  const card = cardEl.outerHTML;
  parsed.window.close();

  const scriptStart = html.indexOf('const personaButtons');
  const loadCallIdx = html.indexOf('loadPersona();', scriptStart);
  assert.ok(scriptStart !== -1 && loadCallIdx !== -1, 'persona script block must exist in ui.html');
  const script = html.slice(scriptStart, loadCallIdx + 'loadPersona();'.length);

  const open = (id) => {
    const dom = new JSDOM(card, { runScripts: 'outside-only', url: base + '/ui.html?conversationId=' + id });
    dom.window.fetch = (url, opts) => fetch(base + url, opts);
    dom.window.eval('const convId=' + JSON.stringify(id) + ';\n' + script);
    return dom;
  };
  const wait = async (predicate) => {
    for (let n = 0; n < 100; n++) {
      if (predicate()) return;
      await new Promise((r) => setTimeout(r, 10));
    }
    assert.fail('UI update timed out');
  };
  mode.setMode(A, 'hakimi');
  const first = open(A);
  const second = open(B);
  try {
    await wait(() => first.window.document.getElementById('persona-hakimi').getAttribute('aria-pressed') === 'true');
    first.window.document.getElementById('persona-normal').click();
    await wait(() => first.window.document.getElementById('persona-normal').getAttribute('aria-pressed') === 'true');
    assert.equal(mode.getMode(A), 'normal');
    assert.equal(mode.getMode(B), 'hakimi');
    await wait(() => second.window.document.getElementById('persona-hakimi').getAttribute('aria-pressed') === 'true');
    const reload = open(A);
    try {
      await wait(() => reload.window.document.getElementById('persona-normal').getAttribute('aria-pressed') === 'true');
    } finally {
      reload.window.close();
    }
    const noId = open('');
    try {
      assert.equal(noId.window.document.getElementById('persona-normal').disabled, true);
    } finally {
      noId.window.close();
    }
  } finally {
    first.window.close();
    second.window.close();
    mode.setMode(A, 'hakimi');
  }
});
