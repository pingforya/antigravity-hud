'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');

// Isolate all test runs inside a single nested temp root BEFORE loading modules
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-verify-'));
const tempBrainDir = path.join(tempRoot, 'brain');
const tempDataDir = path.join(tempRoot, 'data');
const tempPluginDir = path.join(tempRoot, 'plugin');
for (const d of [tempBrainDir, tempDataDir, tempPluginDir]) {
  fs.mkdirSync(d, { recursive: true });
}
process.env.AGY_BRAIN_DIR = tempBrainDir;
process.env.AGY_HUD_DATA_DIR = tempDataDir;
process.env.AGY_HUD_PLUGIN_DIR = tempPluginDir;
process.env.AGY_HUD_MEMORY_FILE = path.join(__dirname, '..', 'plugins', 'agy-hud', 'assets', 'hakimi-memory.md');
delete process.env.AGY_HUD_DEFAULT_PERSONA;

const parser = require('../core/telemetry-parser.cjs');
const { handleHook, rotateIfNeeded, pruneOldTimingFiles } = require('../plugins/agy-hud/scripts/hud-hook.cjs');
const { installPlugin } = require('../cli.js');
const fp = require('../fast-patch.cjs');
const bgSync = require('../bg-sync-i18n.cjs');
const P = require('../paths.cjs');

const ROOT = path.join(__dirname, '..');
const readText = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(pred, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (pred()) return true;
    await delay(15);
  }
  return Boolean(pred());
}

function loadJSDOM() {
  try { return require('jsdom').JSDOM; } catch (_) {}
  const candidates = [
    path.join(__dirname, '..', 'node_modules', 'jsdom'),
    path.join(P.CHINESE_ROOT, 'node_modules', 'jsdom')
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return require(c).JSDOM;
  }
  return null;
}

let passed = 0;
let failed = 0;
let skipped = 0;

function assert(cond, msg) {
  if (cond) {
    console.log(`[PASS] ${msg}`);
    passed++;
  } else {
    console.error(`[FAIL] ${msg}`);
    failed++;
  }
}

function skip(msg) {
  console.log(`[SKIP] ${msg}`);
  skipped++;
}

function writeFixtureTranscript(convId, steps) {
  const logsDir = path.join(tempBrainDir, convId, '.system_generated', 'logs');
  fs.mkdirSync(logsDir, { recursive: true });
  const lines = steps.map((s) => JSON.stringify(s)).join('\n') + '\n';
  fs.writeFileSync(path.join(logsDir, 'transcript_full.jsonl'), lines, 'utf8');
}

async function main() {
  console.log('============================================================');
  console.log('[TEST] Antigravity HUD (位置A: 输入框底栏内嵌胶囊 + 切会话联动) 验证测试');
  console.log('============================================================\n');

  // 1. Test fixture transcript_full.jsonl parsing (exact tokens, compaction peak, and legacy estimation)
  console.log('--- 1. 验证多会话日志解析 (基于隔离 Fixture：精确 Token 与历史会话自动估算兜底) ---');
  const currentConvId = '11111111-1111-4111-8111-111111111111';
  const secondConvId = '22222222-2222-4222-8222-222222222222';
  const legacyConvId = '33333333-3333-4333-8333-333333333333';

  writeFixtureTranscript(currentConvId, [
    { step_index: 0, type: 'USER_INPUT', content: 'changed setting `Model Selection` from auto to Gemini 4 Argon (High)\n请检查代码', created_at: '2026-11-05T10:00:00.000Z' },
    { step_index: 1, type: 'PLANNER_RESPONSE', status: 'DONE', created_at: '2026-11-05T10:00:01.000Z', input_tokens: 16200, cache_read_tokens: 240000, output_tokens: 800, thinking: '思考过程A', content: '回复A', tool_calls: [{ name: 'read_file', args: { Path: 'F:/app/main.js' } }] },
    { step_index: 2, type: 'GENERIC', created_at: '2026-11-05T10:00:05.000Z', content: 'Created At: 2026-11-05T10:00:05.000Z\nCompleted At: 2026-11-05T10:00:06.500Z\nFile content' },
    { step_index: 3, type: 'PLANNER_RESPONSE', status: 'DONE', created_at: '2026-11-05T10:00:07.000Z', input_tokens: 5000, cache_read_tokens: 120000, output_tokens: 600, thinking: '思考过程B', content: '回复B', tool_calls: [] }
  ]);

  writeFixtureTranscript(secondConvId, [
    { step_index: 0, type: 'USER_INPUT', content: '开始第二会话', created_at: '2026-11-05T11:00:00.000Z' },
    { step_index: 1, type: 'PLANNER_RESPONSE', status: 'DONE', created_at: '2026-11-05T11:00:01.000Z', input_tokens: 10000, cache_read_tokens: 150000, output_tokens: 400, thinking: '思考2A', content: '回复2A', tool_calls: [{ name: 'call_mcp_tool', args: {} }] },
    { step_index: 2, type: 'GENERIC', created_at: '2026-11-05T11:00:04.000Z', content: 'Created At: 2026-11-05T11:00:04.000Z\nCompleted At: 2026-11-05T11:00:05.000Z\nMCP output' },
    { step_index: 3, type: 'PLANNER_RESPONSE', status: 'DONE', created_at: '2026-11-05T11:00:06.000Z', input_tokens: 12500, cache_read_tokens: 240000, output_tokens: 900, thinking: '思考2B', content: '回复2B', tool_calls: [] },
    { step_index: 4, type: 'PLANNER_RESPONSE', status: 'DONE', created_at: '2026-11-05T11:00:10.000Z', input_tokens: 10000, cache_read_tokens: 210000, output_tokens: 500, thinking: '思考2C', content: '回复2C', tool_calls: [] }
  ]);

  writeFixtureTranscript(legacyConvId, [
    { step_index: 0, type: 'USER_INPUT', content: '旧版无 token 字段会话', created_at: '2026-11-05T09:00:00.000Z' },
    { step_index: 1, type: 'PLANNER_RESPONSE', status: 'DONE', created_at: '2026-11-05T09:00:02.000Z', thinking: '旧版思考', content: '旧版回复', tool_calls: [{ name: 'read_file', args: { Path: 'legacy.txt' } }] },
    { step_index: 2, type: 'GENERIC', created_at: '2026-11-05T09:00:05.000Z', content: 'Created At: 2026-11-05T09:00:05.000Z\nCompleted At: 2026-11-05T09:00:06.000Z\n' + 'x'.repeat(160000) },
    { step_index: 3, type: 'PLANNER_RESPONSE', status: 'DONE', created_at: '2026-11-05T09:00:08.000Z', thinking: '旧版思考2', content: '旧版回复2', tool_calls: [] }
  ]);

  const telemetry1 = parser.parseConversationTelemetry(currentConvId);
  const telemetry2 = parser.parseConversationTelemetry(secondConvId);
  const telemetryLegacy = parser.parseConversationTelemetry(legacyConvId);

  assert(!!telemetry1, '成功解析 Fixture 会话1 transcript_full.jsonl');
  assert(telemetry1.currentContext === 125000 && telemetry1.peakContext === 256200, `会话1 上下文水位精确计算: 当前 ${telemetry1.currentContext.toLocaleString()} (峰值 ${telemetry1.peakContext.toLocaleString()})`);
  assert(!!telemetry2 && telemetry2.currentContext === 220000 && telemetry2.peakContext === 252500, `会话2 独立水位解析正确: ${telemetry2.currentContext.toLocaleString()} tokens (峰值 ${telemetry2.peakContext.toLocaleString()})`);
  assert(!!telemetryLegacy && telemetryLegacy.isEstimated && telemetryLegacy.currentContext > 50000, `旧版无 Token 字段的历史会话自动回退估算成功: ~${telemetryLegacy.currentContext.toLocaleString()} tokens`);
  {
    const sumIn = telemetry1.steps.reduce((a, s) => a + s.inputTokens, 0);
    const sumCache = telemetry1.steps.reduce((a, s) => a + s.cacheReadTokens, 0);
    const sumOut = telemetry1.steps.reduce((a, s) => a + s.outputTokens, 0);
    assert(telemetry1.totalInputTokens === sumIn && telemetry1.totalCacheReadTokens === sumCache &&
      telemetry1.totalOutputTokens === sumOut && telemetry1.totalTokens === sumIn + sumCache + sumOut && telemetry1.totalTokens > 0,
      `会话累计消耗 Token = 新增输入 + 缓存读 + 输出: ${telemetry1.totalTokens.toLocaleString()}`);
    assert(
      parser.getModelContextLimit('Claude Opus 5.5 (Medium)') === 840000 &&
      parser.getModelContextLimit('claude-opus-5-5-medium') === 840000 &&
      parser.getModelContextLimit('MODEL_PLACEHOLDER_M401') === 840000 &&
      parser.getModelContextLimit('claude-sonnet-5-5-medium') === 840000 &&
      parser.getModelContextLimit('claude-opus-4-6-thinking') === 160000 &&
      parser.getModelContextLimit('gemini-3.1-pro-low') === 128000 &&
      parser.getModelContextLimit('Gemini 3.1 Pro') === 128000 &&
      parser.getModelContextLimit('gemini-3.5-flash-lite') === 128000 &&
      parser.getModelContextLimit('MODEL_PLACEHOLDER_M198') === 128000 &&
      parser.getModelContextLimit('Gemini 3.1 Pro (High)') === 256000 &&
      parser.getModelContextLimit('Gemini 4 Argon (High)') === 256000 &&
      parser.normalizeModelName('claude-opus-5-5-medium') === 'Claude Opus 5.5 (Medium)' &&
      parser.normalizeModelName('MODEL_PLACEHOLDER_M318') === 'Gemini 3.8 Flash (High)' &&
      parser.normalizeModelName('MODEL_PLACEHOLDER_M320') === 'Gemini 3.8 Flash (Low)' &&
      telemetry1.contextLimit === 256000,
      '按模型动态匹配有效上下文上限与占位符映射: Opus/Sonnet 5.5 = 840k, Opus/Sonnet 4.6 = 160k, 3.1 Pro (Low) / 3.5 Flash Lite = 128k, Argon / 3.8 Flash (M318/M320) = 256k'
    );

    const compactConvId = '44444444-4444-4444-8444-444444444444';
    const compactSteps = [
      { step_index: 0, type: 'USER_INPUT', content: 'changed setting `Model Selection` from auto to Claude Opus 5.5 (Medium)\n开始任务', created_at: '2026-11-05T12:00:00.000Z' },
      { step_index: 1, type: 'PLANNER_RESPONSE', status: 'DONE', created_at: '2026-11-05T12:00:02.000Z', input_tokens: 1482, cache_read_tokens: 27400, output_tokens: 500, thinking: '初始思考', content: '初始回复', tool_calls: [{ name: 'read_file', args: { Path: 'F:/old.js' } }] },
      { step_index: 2, type: 'PLANNER_RESPONSE', status: 'DONE', created_at: '2026-11-05T12:05:00.000Z', input_tokens: 121343, cache_read_tokens: 400000, output_tokens: 1200, thinking: '高水位思考', content: '高水位回复', tool_calls: [{ name: 'write_file', args: { Path: 'F:/before_compact.js' } }] },
      { step_index: 3, type: 'USER_INPUT', content: '<USER_REQUEST>\n/compact \n</USER_REQUEST>', created_at: '2026-11-05T12:06:00.000Z' },
      { step_index: 4, type: 'CHECKPOINT', status: 'DONE', created_at: '2026-11-05T12:06:05.000Z', input_tokens: 524134, cache_read_tokens: 0, output_tokens: 2624, content: '# Resuming from a compaction\nSummary...' }
    ];
    writeFixtureTranscript(compactConvId, compactSteps);
    parser.clearCache();
    const afterCompact = parser.parseConversationTelemetry(compactConvId);
    assert(
      afterCompact &&
      afterCompact.contextLimit === 840000 &&
      afterCompact.peakContext === 521343 &&
      afterCompact.compactionCount === 1 &&
      afterCompact.currentContext > 25000 &&
      afterCompact.currentContext < 35000,
      `执行 /compact 生成 CHECKPOINT 后无需再对话一轮，立即显示压缩后上下文: ${afterCompact.currentContext.toLocaleString()} / ${afterCompact.contextLimit.toLocaleString()} (峰值 ${afterCompact.peakContext.toLocaleString()}, 已压缩 ${afterCompact.compactionCount} 次)`
    );

    // Append follow-up turn after CHECKPOINT and verify compactionCount, deltaContext, and sourceLabel
    writeFixtureTranscript(compactConvId, [
      ...compactSteps,
      { step_index: 5, type: 'USER_INPUT', content: '继续下一轮对话', created_at: '2026-11-05T12:07:00.000Z' },
      { step_index: 6, type: 'PLANNER_RESPONSE', status: 'DONE', created_at: '2026-11-05T12:07:05.000Z', input_tokens: 3333, cache_read_tokens: 26846, output_tokens: 600, thinking: '压缩后首轮思考', content: '压缩后首轮回复', tool_calls: [] }
    ]);
    parser.clearCache();
    const afterFollowUp = parser.parseConversationTelemetry(compactConvId);
    const lastStepAfterCompact = afterFollowUp && afterFollowUp.steps[afterFollowUp.steps.length - 1];
    assert(
      afterFollowUp &&
      afterFollowUp.currentContext === 30179 &&
      afterFollowUp.peakContext === 521343 &&
      afterFollowUp.compactionCount === 1 &&
      lastStepAfterCompact &&
      lastStepAfterCompact.deltaContext >= 0 &&
      lastStepAfterCompact.sourceLabel === '上下文压缩后首轮提问',
      `压缩后继续下一轮对话时，上下文平滑过渡为精确值 (${afterFollowUp.currentContext.toLocaleString()})、压缩次数不重复计数 (仍为 ${afterFollowUp.compactionCount} 次)、且不继承压缩前工具标签 (${lastStepAfterCompact.sourceLabel})`
    );
  }

  // 2. Hook: observation only, no PreToolUse or PostToolUse, PID-suffixed rotation & old timing cleanup
  console.log('\n--- 2. 验证 Hook 只记录时间戳、无 PreToolUse/PostToolUse、带 PID 截断与过期清理 ---');
  const hooksJson = JSON.parse(readText('plugins/agy-hud/hooks.json'));
  const hookSpec = hooksJson['agy-hud-telemetry-v1'];
  assert(!('PreToolUse' in hookSpec) && !('PostToolUse' in hookSpec), 'hooks.json 不再注册 PreToolUse 或 PostToolUse（不拦截权限、不拖慢每次工具调用）');

  let anyDecision = false;
  for (const ev of ['PreInvocation', 'PreToolUse', 'PostToolUse', 'PostInvocation', 'Stop']) {
    const r = handleHook(ev, { conversationId: currentConvId, modelName: 'Gemini 4 Argon (High)', invocationNum: 1, toolCall: { name: 'run_command' } });
    if (!r || 'decision' in r || (ev !== 'PreInvocation' && Object.keys(r).length > 0)) anyDecision = true;
  }
  assert(!anyDecision, 'handleHook 不改变权限；仅 PreInvocation 可附加当前聊天角色');
  const hookCli = spawnSync(process.execPath, [path.join(ROOT, 'plugins/agy-hud/scripts/hud-hook.cjs'), 'PreInvocation'], {
    input: 'not json', encoding: 'utf8', env: { ...process.env, AGY_HUD_DATA_DIR: tempDataDir }
  });
  assert(hookCli.stdout.trim() === '{}', `Hook 命令行在输入异常时也只输出 {} (实际: ${hookCli.stdout.trim()})`);
  assert(fs.existsSync(path.join(tempDataDir, `timing_${currentConvId}.jsonl`)), 'Hook 成功记录毫秒级时间戳');
  assert(!fs.existsSync(path.join(tempDataDir, 'live_telemetry.json')) && !fs.readdirSync(tempDataDir).some(n => n.startsWith('conv_')),
    'Hook 不再把含思考链的快照写到磁盘');

  // Verify PID temp file in rotateIfNeeded and pruneOldTimingFiles
  const hookSrc = readText('plugins/agy-hud/scripts/hud-hook.cjs');
  assert(hookSrc.includes('.tmp-${process.pid}'), 'hud-hook.cjs 截断临时文件名包含 process.pid');
  const staleTimingFile = path.join(tempDataDir, 'timing_99999999-9999-4999-8999-999999999999.jsonl');
  fs.writeFileSync(staleTimingFile, '{"event":"Stop","tsMs":1}\n', 'utf8');
  const oldDate = new Date(Date.now() - 10 * 24 * 3600 * 1000);
  fs.utimesSync(staleTimingFile, oldDate, oldDate);
  const prunedCount = pruneOldTimingFiles(tempDataDir, { activeConvId: currentConvId });
  assert(prunedCount >= 1 && !fs.existsSync(staleTimingFile) && fs.existsSync(path.join(tempDataDir, `timing_${currentConvId}.jsonl`)),
    'pruneOldTimingFiles 自动清理过期会话的 timing_*.jsonl 并保留当前活跃会话');

  // 2b. Parser cache + stepCount-only IPC summary (no steps array)
  console.log('\n--- 2b. 验证解析缓存与 IPC 精简载荷 (仅发 stepCount，不发 steps) ---');
  parser.clearCache();
  const firstRead = parser.parseConversationTelemetry(currentConvId);
  const again = parser.parseConversationTelemetry(currentConvId);
  assert(again === firstRead, '文件未变化时直接命中缓存（返回同一对象，不重复解析）');
  const summary = parser.summarizeTelemetry(firstRead);
  assert(!('steps' in summary) && summary.stepCount === firstRead.stepCount && summary.currentContext === firstRead.currentContext && summary.topConsumers.length === firstRead.topConsumers.length,
    `summarizeTelemetry 移除 steps 数组并保留 stepCount=${summary.stepCount} (载荷 ${(JSON.stringify(firstRead).length / 1024).toFixed(1)} KB → ${(JSON.stringify(summary).length / 1024).toFixed(1)} KB)`);
  assert(summary.totalTokens === firstRead.totalTokens && summary.totalInputTokens === firstRead.totalInputTokens && summary.totalCacheReadTokens === firstRead.totalCacheReadTokens,
    'IPC 精简载荷保留会话累计 Token 字段');
  {
    const dailyUsage = parser.getDailyModelUsage({ todayKey: '2026-11-05' });
    const day05 = dailyUsage && dailyUsage.days && dailyUsage.days['2026-11-05'];
    const argonModel = day05 && day05.models.find(m => m.modelName === 'Gemini 4 Argon (High)');
    const opusModel = day05 && day05.models.find(m => m.modelName === 'Claude Opus 5.5 (Medium)');
    assert(
      day05 &&
      day05.sessionCount === 4 &&
      argonModel &&
      argonModel.totalTokens === 382600 &&
      argonModel.turnCount === 2 &&
      argonModel.shortLabel === 'Argon' &&
      argonModel.sharePct > 0 &&
      opusModel &&
      opusModel.totalTokens === 1109462 &&
      opusModel.turnCount === 4 &&
      opusModel.shortLabel === 'Opus 5.5' &&
      opusModel.sharePct > 0 &&
      summary.dailyUsage &&
      summary.dailyUsage.days['2026-11-05'].totalTokens === day05.totalTokens,
      `getDailyModelUsage 跨 4 个会话准确聚合 2026-11-05 各模型消耗 (含 CHECKPOINT 压缩步): Opus 5.5=${opusModel ? opusModel.totalTokens.toLocaleString() : 0} (${opusModel ? opusModel.sharePct : 0}%), Argon=${argonModel ? argonModel.totalTokens.toLocaleString() : 0} (${argonModel ? argonModel.sharePct : 0}%)`
    );
  }
  assert(parser.parseConversationTelemetry('../../etc') === null, '非法会话 ID 被拒绝（防路径穿越）');

  // 2c. Static security & code hygiene checks
  console.log('\n--- 2c. 静态安全与配置卫生检查 ---');
  const serverSrc = readText('plugins/agy-hud/sidecars/telemetry/server.mjs');
  assert(!/Access-Control-Allow-Origin/i.test(serverSrc), 'server.mjs 不再发送 CORS 头（网页无法跨域读取）');
  assert(!/HUD_BRIDGE_PORT|listen\(53991/.test(serverSrc) && !/bg-sync/.test(serverSrc), 'server.mjs 不再监听固定端口 53991，也不再触发后台同步');
  assert(/isAllowedHost/.test(serverSrc), 'server.mjs 校验 Host 头（防 DNS 重绑定）');
  assert(
    !/process\.stdin\.(on|resume)/.test(serverSrc) && !/process\.ppid/.test(serverSrc) && serverSrc.includes('/healthz'),
    'server.mjs 通过 /healthz 探针监控宿主 language_server（绝不监听 Windows 下指向 NUL 的 process.stdin，防无限重启风暴）'
  );
  {
    const http = require('http');
    const { pathToFileURL } = require('url');
    const serverMod = await import(pathToFileURL(path.join(ROOT, 'plugins/agy-hud/sidecars/telemetry/server.mjs')).href);
    let currentInstId = 'inst-alpha';
    let exitCount = 0;
    const mockLsServer = http.createServer((req, res) => {
      if (req.url === '/healthz') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ instanceId: currentInstId, status: 'ok' }));
      } else {
        res.writeHead(404);
        res.end();
      }
    });
    await new Promise(resolve => mockLsServer.listen(0, '127.0.0.1', resolve));
    const lsPort = mockLsServer.address().port;
    const wd = serverMod.startParentWatchdog(`127.0.0.1:${lsPort}`, {
      intervalMs: 40,
      retryMs: 20,
      onExit: () => { exitCount++; }
    });
    await delay(100);
    assert(exitCount === 0, 'startParentWatchdog 在宿主 /healthz 正常响应时不触发退出');
    currentInstId = 'inst-beta';
    await waitFor(() => exitCount === 1, 2000);
    assert(exitCount === 1, 'startParentWatchdog 在宿主 instanceId 变化或重启失联时自动触发退出');
    wd.stop();
    await new Promise(resolve => mockLsServer.close(resolve));

    // Verify /api/hud/live 304 ETag/since fast-path and /api/hud/stream MAX_SSE_CLIENTS=2 eviction guard
    const testSidecar = http.createServer(serverMod.handleHttpRequest);
    await new Promise(resolve => testSidecar.listen(0, '127.0.0.1', resolve));
    const scPort = testSidecar.address().port;
    try {
      const rLive1 = await fetch(`http://127.0.0.1:${scPort}/api/hud/live?conversationId=11111111-1111-4111-8111-111111111111`);
      const bodyLive1 = await rLive1.json();
      assert(rLive1.status === 200 && Boolean(bodyLive1.sig), '/api/hud/live 返回 200 且附带快照签名 sig');

      const rLive304 = await fetch(`http://127.0.0.1:${scPort}/api/hud/live?conversationId=11111111-1111-4111-8111-111111111111&since=${encodeURIComponent(bodyLive1.sig)}`);
      assert(rLive304.status === 304, '/api/hud/live 在快照未变化 (?since=sig) 时立即返回 304 零字节响应');

      // Open 3 SSE streams concurrently: the 1st stream MUST be evicted & closed immediately so Chromium's 6-socket pool never deadlocks
      let firstClosed = false;
      const openSse = () => new Promise((resolve, reject) => {
        const req = http.get(`http://127.0.0.1:${scPort}/api/hud/stream?conversationId=11111111-1111-4111-8111-111111111111`, (res) => {
          res.resume();
          resolve({ req, res });
        });
        req.on('error', reject);
      });
      const sse1 = await openSse();
      sse1.res.on('end', () => { firstClosed = true; });
      const sse2 = await openSse();
      const sse3 = await openSse();
      await waitFor(() => firstClosed === true, 2000);
      assert(firstClosed === true, '/api/hud/stream 严格限制最大并发流数量 (<=2)，自动回收旧连接防止占满 Chromium 6 连接池');
      sse1.req.destroy();
      sse2.req.destroy();
      sse3.req.destroy();
    } finally {
      await new Promise(resolve => testSidecar.close(resolve));
    }
  }
  const sidecarUiSrc = readText('plugins/agy-hud/sidecars/telemetry/ui.html');
  assert(
    !/new\s+EventSource\s*\(/.test(sidecarUiSrc) &&
    sidecarUiSrc.includes('/api/hud/live') &&
    sidecarUiSrc.includes('X-Sidecar-Token'),
    'ui.html 采用短连接轮询 (/api/hud/live + 304 + 隐藏暂停) 替代长连接 EventSource，避免多会话预热 iframe 锁死 6 连接池'
  );
  const runtimeSrc = readText('core/hud-runtime.js');
  assert(!/EventSource\(|root\.fetch\(/.test(runtimeSrc), 'hud-runtime.js 不再访问本地 HTTP 端口');
  const cliSrc = readText('cli.js');
  assert(cliSrc.includes('summarizeTelemetry') && !cliSrc.includes('findLatestConversationId()\n') && !cliSrc.includes('npx -y @electron/asar'),
    'cli.js 主进程 IPC 返回精简数据、缺 convId 时直接返回 error 不回退最新会话，且移除了 npx 打包路径');
  const mainIpcCode = require('../cli.js').getMainIpcScript();
  assert(!mainIpcCode.includes('findLatestConversationId') && mainIpcCode.includes("return { error: 'no_conversation' }"),
    'getMainIpcScript 严格校验 convId，缺失或格式不合法时直接返回 error');
  {
    const callOrder = [];
    let currentLsPid = 42424;
    const mockLsMod = {
      getLanguageServerPid: () => currentLsPid,
      killLanguageServer: async () => {
        callOrder.push(`origKillLs(pid=${currentLsPid})`);
        currentLsPid = null;
      }
    };
    const mockExecCalls = [];
    const vm = require('vm');
    const sandbox = {
      process: { platform: 'win32' },
      console,
      electron_1: { ipcMain: { removeHandler: () => {}, handle: () => {} } },
      require: (id) => {
        if (id === './languageServer') return mockLsMod;
        if (id === 'child_process') {
          return {
            execFileSync: (cmd, args) => {
              callOrder.push(`taskkill(pid=${ currentLsPid })`);
              mockExecCalls.push({ cmd, args });
            }
          };
        }
        if (id === './agyHudTelemetryParser.cjs') return parser;
        return require(id);
      }
    };
    vm.runInNewContext(mainIpcCode, sandbox);
    await mockLsMod.killLanguageServer();
    assert(
      mockLsMod.killLanguageServer.__agyTreeCleanupWrapped === true &&
      mockExecCalls.length === 1 &&
      path.basename(mockExecCalls[0].cmd).toLowerCase().startsWith('taskkill') &&
      mockExecCalls[0].args.join(' ') === '/PID 42424 /T /F' &&
      callOrder.join(' -> ') === 'taskkill(pid=42424) -> origKillLs(pid=42424)',
      'getMainIpcScript 在 origKillLs 杀死 language_server 之前对其活 PID 执行 taskkill /PID <pid> /T /F 清理整棵 Sidecar 进程树'
    );
  }
  const bgSrc = readText('bg-sync-i18n.cjs');
  const runFnSrc = bgSrc.slice(bgSrc.indexOf('async function runBackgroundSync'), bgSrc.indexOf('function applyPendingUpdate'));
  assert(!/merge|checkout/.test(runFnSrc) && !/fastPatchAsar/.test(bgSrc), '后台同步只 fetch，不会自动合并或重建');
  const fpSrc = readText('fast-patch.cjs');
  assert(!/[A-Z]:\\{1,2}gemini/i.test(fpSrc + bgSrc + readText('patch.ps1')), 'fast-patch / bg-sync / patch.ps1 不再写死绝对路径');
  assert(!fpSrc.includes('--prebuild') && !readText('unified-patch.cjs').includes('--prebuild'), '已移除未使用的 --prebuild 选项');
  const batSrc = readText('patch.bat');
  assert(batSrc.includes('exit /b %EXIT_CODE%') && batSrc.includes('if "%~1"==""'), 'patch.bat 正确传出退出码且仅在无参数时 pause');

  // 3. Test Position A DOM Mounting, Home -> Chat Transition, Left Sidebar Switching & Body Popover
  console.log('\n--- 3. 验证位置A (.agy-composer-footer 内嵌) + 新建会话切换 + 左侧栏切会话 + 浮层 ---');
  const JSDOM = loadJSDOM();
  assert(!!JSDOM, 'JSDOM 测试环境可用');
  if (JSDOM) {
    const mockClientHtml = `
      <!DOCTYPE html>
      <html>
      <head></head>
      <body>
        <div id="app-root">
          <div class="agy-home" data-testid="home-greeting">
            <div data-testid="agent-input-box">
              <div id="antigravity.agentSidePanelInputBox" class="surface-composer">
                <div class="surface-composer-card">
                  <div role="textbox" contenteditable="true" aria-placeholder="输入任何问题，输入 @ 提及，输入 / 执行操作"></div>
                  <div class="agy-composer-footer flex w-full items-center justify-between gap-1 p-0.5">
                    <div class="left-cluster flex min-w-0 flex-1 items-center gap-0">
                      <button type="button">+</button>
                      <button type="button">Gemini 4 Argon High</button>
                    </div>
                    <div class="right-cluster shrink-0 flex items-center gap-0.5">
                      <button type="button" id="turbo-btn">Turbo</button>
                      <button type="button" id="send-btn">↑</button>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </body>
      </html>
    `;

    const dom = new JSDOM(mockClientHtml, { runScripts: 'dangerously', pretendToBeVisual: true });
    const win = dom.window;
    win.__AGY_HUD_DISABLE_POLL__ = true;

    // Mock the Electron IPC bridge (__AGY_HUD_FETCH__) returning summarizeTelemetry (stepCount only, no steps)
    const mapByConv = {
      [currentConvId]: parser.summarizeTelemetry(telemetry1),
      [secondConvId]: parser.summarizeTelemetry(telemetry2),
      [legacyConvId]: parser.summarizeTelemetry(telemetryLegacy)
    };
    win.__AGY_HUD_FETCH__ = (convId) => Promise.resolve(mapByConv[convId] || null);

    const runtimeCode = fs.readFileSync(path.join(__dirname, '..', 'core', 'hud-runtime.js'), 'utf8');
    win.eval(runtimeCode);

    // A. Check Home Screen ("新建会话") mounting
    let cluster = win.document.getElementById('agy-hud-footer-cluster');
    let footer = win.document.querySelector('.agy-composer-footer');
    assert(!!cluster && cluster.parentElement === footer, '在“新建会话”首页时，HUD 精确挂载于 .agy-composer-footer 内部');
    assert(cluster.nextElementSibling === footer.lastElementChild, 'HUD 紧挨在右侧 Turbo 按钮组 (lastElementChild) 的正左侧 (位置A)');
    assert(win.document.getElementById('agy-hud-ctx-text').textContent === '0 / 256k', '“新建会话”首页显示 0 / 256k 初始状态');

    // B. Simulate switching from "新建会话" to Conversation 1
    const appRoot = win.document.getElementById('app-root');
    appRoot.innerHTML = `
      <div data-testid="conversation-view" data-cascade-id="${currentConvId}">
        <div class="chat-header">antigravity / Developing Anti-Gravity Client Plugin</div>
        <div class="chat-messages">AI 回复内容</div>
        <div data-testid="agent-input-box">
          <div id="antigravity.agentSidePanelInputBox" class="surface-composer">
            <div class="surface-composer-card">
              <div role="textbox" contenteditable="true"></div>
              <div class="agy-composer-footer flex w-full items-center justify-between gap-1 p-0.5">
                <div class="left-cluster flex min-w-0 flex-1 items-center gap-0">
                  <button type="button">+</button>
                  <button type="button">Gemini 4 Argon High</button>
                </div>
                <div class="right-cluster shrink-0 flex items-center gap-0.5">
                  <button type="button" id="turbo-btn">Turbo</button>
                  <button type="button" id="send-btn">↑</button>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    `;

    win.__AGY_HUD__.sync();
    await delay(30);

    cluster = win.document.getElementById('agy-hud-footer-cluster');
    footer = win.document.querySelector('[data-testid="conversation-view"] .agy-composer-footer');
    assert(!!cluster && cluster.parentElement === footer, '从“新建会话”切换到聊天后，HUD 自动重挂载到新聊天的 .agy-composer-footer 内部（绝不跑到窗口顶部）');
    assert(cluster.nextElementSibling === footer.lastElementChild, '切换聊天后，HUD 依然精确位于右侧 Turbo 按钮正左方');

    const ctxText1 = win.document.getElementById('agy-hud-ctx-text').textContent;
    assert(ctxText1.includes('峰256.2k'), `切换到会话1后立即显示会话1水位: ${ctxText1}`);

    // C. Simulate clicking Conversation 2 in the left sidebar
    const convView = win.document.querySelector('[data-testid="conversation-view"]');
    convView.setAttribute('data-cascade-id', secondConvId);
    win.__AGY_HUD__.sync();
    await delay(30);

    const ctxText2 = win.document.getElementById('agy-hud-ctx-text').textContent;
    const speedText2 = win.document.getElementById('agy-hud-speed-text').textContent;
    assert(ctxText2.includes('峰252.5k') && ctxText2 !== ctxText1, `左侧栏点击切换到会话2后，状态栏数值立即同步变为: ${ctxText2} | ${speedText2}`);

    // D. Test clicking the HUD pill button to open the body-mounted fixed popover
    const toggleBtn = win.document.getElementById('agy-hud-toggle-btn');
    const popover = win.document.getElementById('agy-hud-popover');
    assert(popover.parentElement === win.document.body, '上下文构成浮层 (#agy-hud-popover) 直接挂载在 document.body 上，避免被父容器裁剪');
    assert(popover.style.display === 'none', '上下文构成浮层默认收起');

    toggleBtn.click();
    assert(popover.style.display === 'block', '点击 HUD 胶囊按钮后成功展开上下文构成浮层');
    assert(popover.textContent.includes('call_mcp_tool') && popover.textContent.includes('#' + secondConvId.slice(0, 8)), '浮层准确展示当前所选会话的吃上下文排行与耗时拆分');
    {
      const k = n => n >= 1000000 ? (n / 1000000).toFixed(2) + 'M' : (n >= 1000 ? (n / 1000).toFixed(1) + 'k' : String(n));
      assert(popover.textContent.includes('会话累计消耗 Token') && popover.textContent.includes('Σ ' + k(telemetry2.totalTokens)),
        `浮层显示会话累计消耗 Token: Σ ${k(telemetry2.totalTokens)}`);
    }

    // Click outside to close
    win.document.body.click();
    assert(popover.style.display === 'none', '点击外部区域后浮层自动关闭');

    // D2. Verify Popover renders 840k limit and compaction badge cleanly
    const compactSnapId = '44444444-4444-4444-8444-444444444444';
    mapByConv[compactSnapId] = parser.summarizeTelemetry(parser.parseConversationTelemetry(compactSnapId));
    convView.setAttribute('data-cascade-id', compactSnapId);
    win.__AGY_HUD__.sync();
    await delay(30);
    toggleBtn.click();
    assert(
      popover.textContent.includes('峰值 521.3k / 840k · 已压缩 1 次'),
      '浮层针对 Opus 5.5 压缩后会话准确渲染“峰值 521.3k / 840k · 已压缩 1 次”'
    );
    win.document.body.click();

    // E. Simulate clicking "+ 新建会话" (switching from active conversation back to Home / New Conversation)
    convView.removeAttribute('data-cascade-id');
    win.__AGY_HUD__.sync();
    assert(win.document.getElementById('agy-hud-ctx-text').textContent === '0 / 256k', '点击“+ 新建会话”后，HUD 立即归零为 0 / 256k（绝不残留前一个会话的状态）');

    // Simulate a late async IPC telemetry callback arriving from the previous conversation while on "新建会话"
    win.__AGY_HUD__.update(mapByConv[secondConvId]);
    assert(win.document.getElementById('agy-hud-ctx-text').textContent === '0 / 256k', '在“新建会话”界面收到前一个会话的延迟 IPC 遥测数据时，严格拦截不污染当前空会话');

    // E2. When backend is patched to 512k, Home / New Conversation screen dynamically displays "0 / 512k"
    win.__AGY_HUD__.update({
      conversationId: '__HOME__',
      contextLimit: 512000,
      backendPatch: { patched: true, contextLimit: 512000 },
      stepCount: 0,
      plannerStepCount: 0,
      topConsumers: []
    });
    assert(
      win.document.getElementById('agy-hud-ctx-text').textContent === '0 / 512k',
      '后端打完 512K 补丁后，“新建会话”初始状态自动同步显示为 0 / 512k（不再写死 0 / 256k）'
    );

    // F. Verify Top Status Bar (#agy-hud-topbar) & Daily Model Breakdown Popover (#agy-hud-top-popover)
    const topBar = win.document.getElementById('agy-hud-topbar');
    const topBarBtn = win.document.getElementById('agy-hud-topbar-btn');
    const topPopover = win.document.getElementById('agy-hud-top-popover');
    assert(
      topBar &&
      topPopover &&
      topBar.parentElement === win.document.body &&
      topPopover.parentElement === win.document.body &&
      topBar.getAttribute('data-ag-localization-skip') === 'true' &&
      topPopover.getAttribute('data-ag-localization-skip') === 'true',
      '顶部每日统计胶囊 (#agy-hud-topbar) 与浮层 (#agy-hud-top-popover) 挂载于 document.body 且均带 data-ag-localization-skip="true"'
    );

    const baseDaily = parser.getDailyModelUsage({ todayKey: '2026-11-06' });
    baseDaily.days['2026-11-06'] = {
      date: '2026-11-06',
      totalTokens: 1490000,
      inputTokens: 190000,
      cacheReadTokens: 1280000,
      outputTokens: 20000,
      thinkingTokens: 6000,
      mainTokens: 1200000,
      subagentTokens: 290000,
      turnCount: 12,
      sessionCount: 3,
      cacheHitRate: 87.1,
      models: [
        {
          modelName: 'Gemini 4 Argon (High)',
          shortLabel: 'Argon',
          family: 'gemini-argon',
          color: '#a855f7',
          totalTokens: 890000,
          inputTokens: 110000,
          cacheReadTokens: 768000,
          outputTokens: 12000,
          thinkingTokens: 3500,
          turnCount: 7,
          sessionCount: 2,
          sharePct: 59.7,
          cacheHitRate: 87.5
        },
        {
          modelName: 'Claude Opus 5.5 (Medium)',
          shortLabel: 'Opus 5.5',
          family: 'claude-opus',
          color: '#f59e0b',
          totalTokens: 600000,
          inputTokens: 80000,
          cacheReadTokens: 512000,
          outputTokens: 8000,
          thinkingTokens: 2500,
          turnCount: 5,
          sessionCount: 2,
          sharePct: 40.3,
          cacheHitRate: 86.5
        }
      ]
    };
    baseDaily.today = baseDaily.days['2026-11-06'];
    baseDaily.recentDays = baseDaily.recentDays.map(r => r.date === '2026-11-06' ? {
      ...r,
      totalTokens: 1490000,
      topModelColor: '#a855f7',
      models: baseDaily.days['2026-11-06'].models
    } : r);

    win.__AGY_HUD__.updateDaily(baseDaily);
    const topTotalEl = win.document.getElementById('agy-hud-top-total');
    const topModelsEl = win.document.getElementById('agy-hud-top-models');
    assert(
      topTotalEl &&
      topTotalEl.textContent === '1.49M' &&
      topModelsEl &&
      topModelsEl.textContent.includes('Argon') &&
      topModelsEl.textContent.includes('890.0k') &&
      topModelsEl.textContent.includes('Opus 5.5') &&
      topModelsEl.textContent.includes('600.0k'),
      `顶部每日统计栏准确渲染今日总消耗 (${topTotalEl.textContent}) 与多模型彩色胶囊 (Argon / Opus 5.5)`
    );

    // Open bottom popover first, then click topbar button -> verifies mutual exclusion
    toggleBtn.click();
    assert(popover.style.display === 'block', '底部上下文浮层先打开');
    topBarBtn.click();
    assert(
      topPopover.style.display === 'block' && popover.style.display === 'none',
      '点击顶部每日统计按钮 (#agy-hud-topbar-btn) 展开顶部浮层并自动收起底部浮层（互斥展示）'
    );

    const modelListEl = win.document.getElementById('agy-hud-model-list');
    assert(
      win.__AGY_HUD__.getSelectedDate() === '2026-11-06' &&
      modelListEl &&
      modelListEl.textContent.includes('Gemini 4 Argon (High)') &&
      modelListEl.textContent.includes('Claude Opus 5.5 (Medium)'),
      '顶部浮层默认展示今日 (2026-11-06) 的分模型消耗明细'
    );

    const prevDateBtn = topPopover.querySelector('[data-agy-date-nav="prev"]');
    prevDateBtn.click();
    const modelListAfterPrev = win.document.getElementById('agy-hud-model-list');
    assert(
      win.__AGY_HUD__.getSelectedDate() === '2026-11-05' &&
      modelListAfterPrev &&
      modelListAfterPrev.textContent.includes('Claude Opus 5.5 (Medium)') &&
      modelListAfterPrev.textContent.includes('1.11M') &&
      modelListAfterPrev.textContent.includes('Gemini 4 Argon (High)') &&
      modelListAfterPrev.textContent.includes('382.6k'),
      '点击前一天导航或 7 日柱状图切换日期至 2026-11-05 后，getSelectedDate() 与 #agy-hud-model-list 同步更新为该日明细'
    );

    const todayColBtn = topPopover.querySelector('.agy-7d-col[data-agy-date-select="2026-11-06"]');
    todayColBtn.click();
    assert(
      win.__AGY_HUD__.getSelectedDate() === '2026-11-06' &&
      win.__AGY_HUD__.getSelectedScope() === 'day',
      '点击 7 日趋势柱 (.agy-7d-col[data-agy-date-select]) 可直接切回目标日期并激活单日视图'
    );

    const EMOJI_RE = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\uFE0F]/u;
    const newChatPersonaCode = readText('core/new-chat-persona.js');
    const topSummaryEl = win.document.getElementById('agy-hud-top-summary');
    assert(
      topSummaryEl &&
      topSummaryEl.textContent.includes('7D 3.70M') &&
      topSummaryEl.textContent.includes('总 3.70M') &&
      !EMOJI_RE.test(topBar.textContent + topPopover.textContent + cluster.textContent + popover.textContent),
      `顶栏胶囊、看板、底栏胶囊与上下文浮层同步展示 7D 与总计读数 (${topSummaryEl ? topSummaryEl.textContent : ''}) 且彻底去除 Emoji`
    );

    const weekScopeBtn = topPopover.querySelector('.agy-scope-tab[data-agy-scope="week"]');
    weekScopeBtn.click();
    const modelListWeek = win.document.getElementById('agy-hud-model-list');
    assert(
      win.__AGY_HUD__.getSelectedScope() === 'week' &&
      win.__AGY_HUD__.getSelectedWeekOffset() === 0 &&
      win.document.getElementById('agy-hud-week-label') &&
      modelListWeek &&
      modelListWeek.textContent.includes('Claude Opus 5.5 (Medium)') &&
      modelListWeek.textContent.includes('1.71M') &&
      modelListWeek.textContent.includes('Gemini 4 Argon (High)') &&
      modelListWeek.textContent.includes('1.27M'),
      '点击「7 日」Tab 进入独立七日区间页，展示本七日跨日汇总排行 (Opus 5.5: 1.71M, Argon: 1.27M)'
    );

    topPopover.querySelector('[data-agy-week-nav="prev"]').click();
    const movedToPrevWeek = win.__AGY_HUD__.getSelectedWeekOffset() === -1 && topPopover.textContent.includes('上一七日');
    topPopover.querySelector('[data-agy-week-reset="true"]').click();
    const resetToCurrentWeek = win.__AGY_HUD__.getSelectedWeekOffset() === 0 && topPopover.textContent.includes('本七日');
    assert(
      movedToPrevWeek && resetToCurrentWeek,
      '7 日区间页支持「‹ 上七日 / 下七日 › / 回本七日」区间翻页'
    );

    const totalScopeTab = topPopover.querySelector('.agy-scope-tab[data-agy-scope="total"]');
    totalScopeTab.click();
    const modelListTotal = win.document.getElementById('agy-hud-model-list');
    const heatmapEl = win.document.getElementById('agy-hud-total-heatmap');
    assert(
      win.__AGY_HUD__.getSelectedScope() === 'total' &&
      topPopover.querySelectorAll('[data-agy-scope]').length === 3 &&
      heatmapEl &&
      heatmapEl.querySelectorAll('.agy-hm-cell').length === 28 &&
      modelListTotal &&
      modelListTotal.textContent.includes('Claude Opus 5.5 (Medium)') &&
      modelListTotal.textContent.includes('1.71M'),
      '点击「总计」Tab 进入独立全周期总览看板（含 4 维核心 KPI、28 天热力矩阵与历史模型总榜，且无重复导航卡片按钮）'
    );

    const hudStyleText = win.document.getElementById('agy-hud-styles').textContent;
    const sidecarHtmlText = fs.readFileSync(path.join(ROOT, 'plugins', 'agy-hud', 'sidecars', 'telemetry', 'ui.html'), 'utf8');
    const monoMatch = sidecarHtmlText.match(/--agy-mono\s*:\s*([^;]+);/);
    const monoVal = monoMatch ? monoMatch[1] : '';
    const cascadiaIdx = monoVal.indexOf('"Cascadia Code"');
    const segoeInMonoIdx = monoVal.indexOf('"Segoe UI"');
    const monoPrioritizesCascadia = cascadiaIdx !== -1 && (segoeInMonoIdx === -1 || cascadiaIdx < segoeInMonoIdx);
    assert(
      win.__AGY_HUD__.getTheme() === 'dark' &&
      !topBar.classList.contains('agy-theme-light') &&
      !hudStyleText.includes('html[style*="light"]') &&
      hudStyleText.includes('MiSans') &&
      hudStyleText.includes('Noto Sans SC') &&
      hudStyleText.includes('Segoe UI Variable Display') &&
      !hudStyleText.includes('Microsoft YaHei') &&
      sidecarHtmlText.includes('data-theme="dark"') &&
      sidecarHtmlText.includes('MiSans') &&
      !sidecarHtmlText.includes('Microsoft YaHei') &&
      monoPrioritizesCascadia,
      '默认锁定深色黑曜石风格 (移除导致误变白色的 html[style*="light"])，启用 MiSans / Noto Sans SC / Segoe UI Variable 现代字体栈，且 ui.html --agy-mono 优先使用 Cascadia Code'
    );
    assert(
      !EMOJI_RE.test(sidecarHtmlText) &&
      !EMOJI_RE.test(runtimeCode) &&
      !EMOJI_RE.test(newChatPersonaCode),
      'ui.html / core/hud-runtime.js / core/new-chat-persona.js 源码实现零 Emoji（全部使用 SVG 图标）'
    );

    topPopover.querySelector('[data-agy-theme-toggle="true"]').click();
    const switchedToLight = win.__AGY_HUD__.getTheme() === 'light' && topBar.classList.contains('agy-theme-light');
    topPopover.querySelector('[data-agy-theme-toggle="true"]').click();
    const switchedBackToDark = win.__AGY_HUD__.getTheme() === 'dark' && !topBar.classList.contains('agy-theme-light');
    assert(
      switchedToLight && switchedBackToDark,
      '看板头部支持一键手动切换深色 / 浅色模式并同步更新顶栏与浮层样式类'
    );

    // G. Verify Scroll Preservation across Sync / Polling / Live Streaming Updates (12-Model Leaderboard)
    const manyModelsList = Array.from({ length: 12 }, (_, idx) => ({
      modelName: `Model Rank #${idx + 1}`,
      shortLabel: `M${idx + 1}`,
      family: 'gemini-argon',
      color: '#38bdf8',
      totalTokens: (12 - idx) * 100000,
      inputTokens: (12 - idx) * 10000,
      cacheReadTokens: (12 - idx) * 85000,
      outputTokens: (12 - idx) * 5000,
      thinkingTokens: (12 - idx) * 2000,
      turnCount: 10 + idx,
      sessionCount: 2,
      sharePct: Number((((12 - idx) / 78) * 100).toFixed(1)),
      cacheHitRate: 89.5
    }));
    const daily12 = {
      todayKey: '2026-11-06',
      today: {
        date: '2026-11-06',
        totalTokens: 7800000,
        inputTokens: 780000,
        cacheReadTokens: 6630000,
        outputTokens: 390000,
        thinkingTokens: 156000,
        turnCount: 186,
        sessionCount: 12,
        cacheHitRate: 89.5,
        models: manyModelsList
      },
      days: {
        '2026-11-06': {
          date: '2026-11-06',
          totalTokens: 7800000,
          inputTokens: 780000,
          cacheReadTokens: 6630000,
          outputTokens: 390000,
          thinkingTokens: 156000,
          turnCount: 186,
          sessionCount: 12,
          cacheHitRate: 89.5,
          models: manyModelsList
        }
      }
    };

    win.__AGY_HUD__.selectDailyScope('total');
    win.__AGY_HUD__.updateDaily(daily12);
    const listBeforeSync = win.document.getElementById('agy-hud-model-list');
    const firstRowBefore = listBeforeSync.children[0];
    listBeforeSync.scrollTop = 185;

    // 1) Repeated sync() / identical updateDaily() must NOT replace #agy-hud-model-list or reset scrollTop
    win.__AGY_HUD__.sync();
    win.__AGY_HUD__.sync();
    win.__AGY_HUD__.updateDaily(daily12);
    const listAfterSync = win.document.getElementById('agy-hud-model-list');
    assert(
      listAfterSync === listBeforeSync &&
      listAfterSync.children[0] === firstRowBefore &&
      listAfterSync.scrollTop === 185,
      '滚动模型榜单后触发周期 sync() 或相同数据刷新时，零 DOM 重建且 scrollTop (185px) 纹丝不动、绝不弹回顶部'
    );

    // 2) Live streaming token increment on same 12 models patches rows in-place without detaching rows or losing scrollTop
    const daily12Streaming = JSON.parse(JSON.stringify(daily12));
    daily12Streaming.days['2026-11-06'].models[2].totalTokens += 50000;
    daily12Streaming.days['2026-11-06'].totalTokens += 50000;
    daily12Streaming.today = daily12Streaming.days['2026-11-06'];
    win.__AGY_HUD__.updateDaily(daily12Streaming);
    const listAfterLivePatch = win.document.getElementById('agy-hud-model-list');
    assert(
      listAfterLivePatch === listBeforeSync &&
      listAfterLivePatch.children[0] === firstRowBefore &&
      listAfterLivePatch.scrollTop === 185 &&
      listAfterLivePatch.children[2].textContent.includes('1.05M'),
      '后台流式新增 Token 时原地差量更新变化行 (1.05M)，不销毁滚动容器与行节点，scrollTop 保持 185px'
    );

    // 3) Active wheel scroll lock defers background DOM mutation until scrolling settles, then flushes while keeping scrollTop
    const daily12Deferred = JSON.parse(JSON.stringify(daily12Streaming));
    daily12Deferred.days['2026-11-06'].models[0].totalTokens = 1550000;
    daily12Deferred.days['2026-11-06'].totalTokens += 350000;
    daily12Deferred.today = daily12Deferred.days['2026-11-06'];
    topPopover.dispatchEvent(new win.Event('wheel', { bubbles: true }));
    win.__AGY_HUD__.updateDaily(daily12Deferred);
    const deferredDuringWheel = !listAfterLivePatch.children[0].textContent.includes('1.55M') && listAfterLivePatch.scrollTop === 185;
    await delay(520);
    const flushedAfterWheel = listAfterLivePatch.children[0].textContent.includes('1.55M') && listAfterLivePatch.scrollTop === 185;
    assert(
      deferredDuringWheel && flushedAfterWheel,
      '用户正在滚轮滑动期间自动延后后台刷新，停止滑动后平滑补齐最新数值 (1.55M) 且 scrollTop 依然锁定 185px'
    );

    // 4) Explicit scope switch resets scrollTop cleanly to 0 for the new page
    win.__AGY_HUD__.selectDailyScope('day');
    assert(
      win.document.getElementById('agy-hud-model-list').scrollTop === 0,
      '主动切换「单日 / 7 日 / 总计」页面时，新页面模型列表自动回到顶部 (scrollTop = 0)'
    );

    dom.window.close();

    // 3b. Verify in-memory i18n runtime performance hotfix (KaTeX skip, O(1) child descent, scanId batch dedup, hover throttle preservation)
    if (fs.existsSync(P.I18N_RUNTIME_PATH)) {
      const rawI18nRuntime = fs.readFileSync(P.I18N_RUNTIME_PATH, 'utf8');
      const hotfixedI18nRuntime = fp.applyRuntimePerformanceHotfix(rawI18nRuntime);
      assert(
        hotfixedI18nRuntime.includes("'katex'") &&
        hotfixedI18nRuntime.includes("'math': 1") &&
        hotfixedI18nRuntime.includes('function shouldIgnoreSelf(el)') &&
        fp.applyRuntimePerformanceHotfix(hotfixedI18nRuntime) === hotfixedI18nRuntime,
        'applyRuntimePerformanceHotfix 内存热修复注入成功且具备幂等性（不污染上游仓库工作区）'
      );

      const i18nDom = new JSDOM(`
        <!DOCTYPE html>
        <html>
        <body>
          <div id="app-root">
            <div data-testid="conversation-view">
              <div class="prose">
                <p>设函数满足：<span class="katex"><span class="katex-mathml"><math><semantics><mrow><mi>Copy</mi></mrow><annotation encoding="application/x-tex">Copy</annotation></semantics></math></span><span class="katex-html"><span class="base"><span class="mord">.</span><span class="mord">Copy</span></span></span></span></p>
              </div>
              <textarea id="chat-ta">Copy</textarea>
              <pre id="chat-pre"><span>Copy</span></pre>
              <div class="btn-wrap"><button id="copy-btn" title="Copy">Copy</button></div>
            </div>
          </div>
        </body>
        </html>
      `, { runScripts: 'dangerously', pretendToBeVisual: true });
      const iWin = i18nDom.window;
      iWin.__AGY_I18N_DATA__ = { exact: { Copy: '复制', Settings: '设置' }, patterns: [] };
      iWin.eval(hotfixedI18nRuntime);
      iWin.__AGY_RUN_FULL_SCAN__();

      const katexEl = iWin.document.querySelector('.katex');
      const taEl = iWin.document.getElementById('chat-ta');
      const preEl = iWin.document.getElementById('chat-pre');
      const copyBtn = iWin.document.getElementById('copy-btn');
      assert(
        katexEl.textContent.includes('.Copy') && !katexEl.textContent.includes('。') && !katexEl.textContent.includes('复制'),
        'KaTeX 数学公式子树被 O(1) 跳过（内部英文符号与小数点 "." 不被误翻译为“。”或中文）'
      );
      assert(
        taEl.value === 'Copy' && preEl.textContent === 'Copy' && copyBtn.textContent === '复制' && copyBtn.getAttribute('title') === '复制',
        '拆分 shouldIgnoreSelf 后，<textarea> 与 <pre> 保护边界完好，普通按钮正常汉化'
      );

      // Simulate dynamic attribute change before capture-phase pointerenter cascade (conversation-view -> prose -> button)
      copyBtn.setAttribute('title', 'Settings');
      const convContainer = iWin.document.querySelector('[data-testid="conversation-view"]');
      const proseContainer = iWin.document.querySelector('.prose');
      for (const targetEl of [convContainer, proseContainer, copyBtn]) {
        targetEl.dispatchEvent(new iWin.Event('pointerenter', { bubbles: false }));
      }
      assert(
        copyBtn.getAttribute('title') === '设置',
        '捕获阶段 pointerenter 经过外层大容器时不消耗 120ms 节流额度，内部按钮悬浮属性即时完成汉化'
      );
      i18nDom.window.close();
    } else {
      skip(`未检测到 antigravity-chinese 运行时 (${P.I18N_RUNTIME_PATH})，跳过 Section 3b 内存热修复测试`);
    }
  }

  // 4. Isolated plugin deployment & unified in-memory ASAR patcher verification
  console.log('\n--- 4. 验证隔离插件部署 (AGY_HUD_PLUGIN_DIR) & 一体化注入器 (fast-patch.cjs) ---');
  const staleMarkerFile = path.join(tempPluginDir, 'stale_leftover.txt');
  fs.writeFileSync(staleMarkerFile, 'stale', 'utf8');
  const installedDir = installPlugin();
  assert(installedDir === tempPluginDir && fs.existsSync(path.join(installedDir, 'plugin.json')) && !fs.existsSync(staleMarkerFile),
    'installPlugin 在隔离临时目录中先清空旧残留文件再部署最新插件（不触碰真实插件目录）');

  const asarLib = (() => {
    for (const c of [
      path.join(ROOT, 'node_modules', '@electron', 'asar'),
      path.join(P.CHINESE_ROOT, 'node_modules', '@electron', 'asar')
    ]) {
      try { if (fs.existsSync(c)) return require(c); } catch (_) {}
    }
    return null;
  })();
  const countUnpacked = (buf) => {
    const root = JSON.parse(buf.subarray(16, 16 + buf.readUInt32LE(12)).toString('utf8'));
    let n = 0;
    (function walk(node) { for (const v of Object.values(node.files || {})) { if (v.files) walk(v); else if (v.unpacked) n++; } })(root);
    return n;
  };

  const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  const realResDir = path.join(localAppData, 'Programs', 'antigravity', 'resources');
  const realBak = path.join(realResDir, 'app.asar.bak');
  const realUnpacked = path.join(realResDir, 'app.asar.unpacked');
  const PATCH_PS1 = path.join(ROOT, 'patch.ps1');
  const hasRealAsar = fs.existsSync(realBak) && fs.existsSync(realUnpacked);
  const hasI18nRepo = fs.existsSync(P.DICT_PATH) && fs.existsSync(P.I18N_RUNTIME_PATH);

  if (hasRealAsar) {
    console.log(`[INFO] 检测到真实纯净备份 (${realBak}) 与 unpacked 目录`);
  } else {
    skip(`未检测到本地真实纯净备份 (${realBak}) 与 unpacked 目录，将跳过依赖真实 ASAR 的测试`);
  }

  // 4a. patch.ps1 static checks
  const astRes = spawnSync('pwsh', ['-NoProfile', '-Command',
    "$e=$null; $null=[System.Management.Automation.Language.Parser]::ParseFile('" + PATCH_PS1.replace(/'/g, "''") + "',[ref]$null,[ref]$e); if ($e.Count -eq 0) {'AST_OK'} else {$e}"], { encoding: 'utf8' });
  const hasPwsh = !astRes.error;
  if (hasPwsh) {
    assert(astRes.status === 0 && (astRes.stdout || '').includes('AST_OK'), 'patch.ps1 PowerShell AST 语法检查通过');
  } else {
    skip('当前环境未安装 pwsh，跳过 patch.ps1 PowerShell AST 语法检查');
  }
  const ps1Bytes = fs.readFileSync(PATCH_PS1);
  assert(ps1Bytes[0] === 0xEF && ps1Bytes[1] === 0xBB && ps1Bytes[2] === 0xBF, 'patch.ps1 带 UTF-8 BOM（Windows PowerShell 5.1 不会乱码）');
  const ps1Text = ps1Bytes.toString('utf8');
  const leaked = ['start-antigravity-proxy', 'HTTP_PROXY', 'HTTPS_PROXY', '--proxy-server', '7897', 'Antigravity.lnk'].filter(k => ps1Text.includes(k));
  assert(leaked.length === 0, 'patch.ps1 不涉及代理/启动器配置' + (leaked.length ? ' 泄露: ' + leaked.join(',') : ''));
  assert(!/Write-Error/.test(ps1Text) && !/app\.asar\.patched/.test(ps1Text), 'patch.ps1 不再使用会吞掉退出码的 Write-Error，也不再拷贝预编译缓存');
  assert(ps1Text.includes('$_.Path -like "$installDir\\*"') && ps1Text.includes('Join-Path $resolvedCustom "resources\\app.asar"'),
    'patch.ps1 按安装路径过滤进程（含尾随反斜杠防止前缀碰撞），并支持将目录参数解析为 <目录>\\resources\\app.asar');
  assert(ps1Text.includes('Stop-OrphanedSidecars') && ps1Text.includes('Get-CimInstance Win32_Process'),
    'patch.ps1 使用 Get-CimInstance Win32_Process 兼容 PS 5.1/7 自动识别并清理孤儿 Sidecar 进程');
  assert(
    ps1Text.includes('Get-UpdaterProcesses') &&
    ps1Text.includes('Wait-UpdaterComplete') &&
    ps1Text.indexOf('后端 1M 上下文自动压缩阈值选择') < ps1Text.indexOf('[2/4] 检查客户端运行状态与文件锁') &&
    ps1Text.includes('Get-Item -LiteralPath $asarPath'),
    'patch.ps1 提前完成交互阈值选择（避免补丁中途停顿），并检测/等待官方 NSIS 自动更新器与防御更新覆盖后自动重打补丁'
  );
  {
    const mainIpcCode = require('../cli.js').getMainIpcScript();
    assert(
      mainIpcCode.includes('lsMod.getLsProcess') &&
      mainIpcCode.includes('lsProc.pid') &&
      mainIpcCode.includes('setIntentionalTermination(true)'),
      'getMainIpcScript 通过 lsMod.getLsProcess().pid 准确获取 language_server PID 并标记 setIntentionalTermination(true)，确保退出时清理整棵 Sidecar 进程树'
    );
    const cmdMap = new Map([
      [1001, 'C:\\WINDOWS\\system32\\cmd.exe /d /s /c ""C:\\Users\\test\\.gemini\\antigravity\\agy-node.cmd" --import ... server.mjs"'],
      [1002, 'C:\\WINDOWS\\system32\\cmd.exe /d /s /c ""C:\\Users\\test\\.gemini\\antigravity\\agy-node.cmd" --import ... server.mjs"']
    ]);
    const orphanPair = [
      { pid: 29164, parentPid: 1001, hasWindow: false, commandLine: '"C:\\App\\Antigravity.exe" --import file:///C:/App/resources/app/extensions/sidecar_sdk/register_loader.js C:\\plugins\\science\\sidecars\\biomolecular_structure_viewer\\server.mjs' },
      { pid: 34836, parentPid: 1002, hasWindow: false, commandLine: '"C:\\App\\Antigravity.exe" --import file:///C:/App/resources/app/extensions/sidecar_sdk/register_loader.js C:\\plugins\\agy-hud\\sidecars\\telemetry\\server.mjs' }
    ];
    const cOrphan = fp.classifyInstallProcesses(orphanPair, 0, cmdMap);
    assert(
      cOrphan.activeCount === 0 &&
      cOrphan.orphanSidecarPids.join(',') === '29164,34836' &&
      cOrphan.orphanParentCmdPids.join(',') === '1001,1002',
      'classifyInstallProcesses 准确识别主程序与 language_server 已退出后的 2 个孤儿 Sidecar 及其父 cmd.exe (agy-node.cmd)'
    );

    const cTrayLsAlive = fp.classifyInstallProcesses(orphanPair, 1, cmdMap);
    const cTrayGpuAlive = fp.classifyInstallProcesses([
      ...orphanPair,
      { pid: 40000, parentPid: 39999, hasWindow: false, commandLine: '"C:\\App\\Antigravity.exe" --type=gpu-process' }
    ], 0, cmdMap);
    const cEmptyCmd = fp.classifyInstallProcesses([
      { pid: 29164, parentPid: 1001, hasWindow: false, commandLine: '' }
    ], 0, cmdMap);
    assert(
      cTrayLsAlive.activeCount === 2 && cTrayLsAlive.orphanSidecarPids.length === 0 &&
      cTrayGpuAlive.activeCount === 3 && cTrayGpuAlive.orphanSidecarPids.length === 0 &&
      cEmptyCmd.activeCount === 1 && cEmptyCmd.orphanSidecarPids.length === 0,
      'classifyInstallProcesses 严格保护后台最小化到系统托盘的客户端（language_server 存活、含 --type= 进程或命令行不可读时绝不误判为孤儿）'
    );
  }

  // 4b-synthetic. CI-portable Synthetic Dual-Mode ASAR Test (runs unconditionally without real Antigravity install)
  console.log('\n--- 4b-synthetic. 验证合成最小 ASAR 双模式注入 (HUD-Only 模式 & 中文+HUD 模式) ---');
  {
    const buildSyntheticAsar = () => {
      const pkgBuf = Buffer.from('{"name":"antigravity","version":"2.32.1"}\n', 'utf8');
      const preloadBuf = Buffer.from('const electron_1 = require("electron");\n', 'utf8');
      const ipcBuf = Buffer.from(
        'const electron_1 = require("electron");\nfunction buildContextMenuTemplate(items, onSelect) {\n  const item = {};\n  const menu = { label: item.label ?? \'\' };\n  return menu;\n}\n',
        'utf8'
      );
      const menuBuf = Buffer.from('module.exports = { label: "New Window" };\n', 'utf8');
      const mainBuf = Buffer.from('module.exports = { label: "Quit" };\n', 'utf8');

      const chunks = [];
      const addNode = (buf) => {
        const offset = chunks.reduce((sum, b) => sum + b.length, 0);
        chunks.push(buf);
        return { size: buf.length, offset: String(offset) };
      };

      const root = {
        files: {
          'package.json': addNode(pkgBuf),
          dist: {
            files: {
              'preload.js': addNode(preloadBuf),
              'ipcHandlers.js': addNode(ipcBuf),
              'menu.js': addNode(menuBuf),
              'main.js': addNode(mainBuf)
            }
          },
          node_modules: {
            files: {
              native: {
                files: {
                  'binding.node': { size: 16, unpacked: true }
                }
              }
            }
          }
        }
      };

      const jsonBuf = Buffer.from(JSON.stringify(root), 'utf8');
      const jsonLen = jsonBuf.length;
      const paddedJsonLen = Math.ceil(jsonLen / 4) * 4;
      const headerPayloadLen = 4 + paddedJsonLen;
      const headerPickleLen = 4 + headerPayloadLen;
      const headerBuf = Buffer.alloc(8 + headerPickleLen, 0);
      headerBuf.writeUInt32LE(4, 0);
      headerBuf.writeUInt32LE(headerPickleLen, 4);
      headerBuf.writeUInt32LE(headerPayloadLen, 8);
      headerBuf.writeUInt32LE(jsonLen, 12);
      jsonBuf.copy(headerBuf, 16);
      return Buffer.concat([headerBuf, ...chunks]);
    };

    const synthBuf = buildSyntheticAsar();
    assert(fp.isValidAsarBuffer(synthBuf) && countUnpacked(synthBuf) === 1 && fp.readAsarAppVersion(synthBuf) === '2.32.1',
      '成功在内存中构造带 Chromium Pickle 头与 unpacked 节点的最小合成 ASAR');

    // Mode 1: HUD-Only in-memory + disk swap via fastPatchAsar
    const hudOnlyBuf = fp.patchAsarBufferInMemory(synthBuf, { hudOnly: true });
    assert(
      fp.isValidAsarBuffer(hudOnlyBuf) &&
      fp.isBufferHudPatched(hudOnlyBuf) &&
      !fp.isBufferPatched(hudOnlyBuf) &&
      fp.verifyPatchedAsarIntegrity(hudOnlyBuf, { expectChinese: false }) &&
      countUnpacked(hudOnlyBuf) === 1,
      '合成 ASAR HUD-Only 模式内存注入通过：HUD 标记齐备、不含中文标记、unpacked 节点保留'
    );

    const synthDir = fs.mkdtempSync(path.join(tempRoot, 'synth-asar-'));
    try {
      const synthAsarPath = path.join(synthDir, 'app.asar');
      fs.writeFileSync(synthAsarPath, synthBuf);
      const fastHudRes = fp.fastPatchAsar({
        customPath: synthAsarPath,
        hudOnly: true,
        skipPlugins: true,
        skipBgSync: true,
        skipProcessCheck: true
      });
      const diskHudBuf = fs.readFileSync(synthAsarPath);
      assert(
        fastHudRes &&
        fastHudRes.enableChinese === false &&
        fs.existsSync(path.join(synthDir, 'app.asar.bak')) &&
        fs.readFileSync(path.join(synthDir, 'app.asar.bak')).equals(synthBuf) &&
        fp.isBufferHudPatched(diskHudBuf) &&
        !fp.isBufferPatched(diskHudBuf),
        'fastPatchAsar 在合成 ASAR 上以 HUD-Only 模式完成备份、原子替换与写入终检'
      );

      // Mode 2: Chinese + HUD mode using temporary dictionary & runtime
      const tmpDict = path.join(synthDir, 'zh-CN.json');
      const tmpRuntime = path.join(synthDir, 'i18n-runtime.js');
      fs.writeFileSync(tmpDict, '{"exact":{"Settings":"设置"},"regexp":[]}\n', 'utf8');
      fs.writeFileSync(tmpRuntime, 'window.__i18nReady = true;\n', 'utf8');
      const bothBuf = fp.patchAsarBufferInMemory(synthBuf, { dictPath: tmpDict, runtimePath: tmpRuntime });
      assert(
        fp.isBufferPatched(bothBuf) &&
        fp.isBufferHudPatched(bothBuf) &&
        fp.verifyPatchedAsarIntegrity(bothBuf, { expectChinese: true }) &&
        countUnpacked(bothBuf) === 1,
        '合成 ASAR 中文+HUD 双模式内存注入通过：词库/运行时/右键菜单映射与 HUD 标记全部校验通过'
      );
    } finally {
      fs.rmSync(synthDir, { recursive: true, force: true });
    }
  }

  // 4b. End-to-end on a sandbox copy of the pristine backup (with safe junction unlink in finally)
  const bakBuf = hasRealAsar ? fs.readFileSync(realBak) : null;
  let patched1 = null;

  if (hasRealAsar && hasI18nRepo && hasPwsh) {
    const tmpDir = fs.mkdtempSync(path.join(tempRoot, 'agy-unified-test-'));
    const testAsar = path.join(tmpDir, 'app.asar');
    const testUnpacked = path.join(tmpDir, 'app.asar.unpacked');
    const testBak = path.join(tmpDir, 'app.asar.bak');

    try {
      fs.copyFileSync(realBak, testAsar);
      fs.symlinkSync(realUnpacked, testUnpacked, 'junction');
      const runPatch = () => spawnSync('pwsh', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', PATCH_PS1,
        '-CustomAsarPath', testAsar, '-SkipProcessCheck', '-NoUpdateCheck'], { encoding: 'utf8' });

      const t0 = Date.now();
      const run1 = runPatch();
      const wallMs = Date.now() - t0;
      assert(run1.status === 0, 'patch.ps1 首次执行成功 (退出码 ' + run1.status + ', 耗时 ' + wallMs + ' ms)' + (run1.status ? '\n' + run1.stdout + run1.stderr : ''));
      assert(fs.existsSync(testBak) && fs.readFileSync(testBak).equals(bakBuf), '首次执行创建了与原版逐字节一致的纯净备份');

      patched1 = fs.readFileSync(testAsar);
      assert(fp.isValidAsarBuffer(patched1) && fp.isBufferPatched(patched1) && fp.isBufferHudPatched(patched1) && fp.verifyPatchedAsarIntegrity(patched1),
        '补丁结果头部合法且逐文件通过中文 + HUD 注入标记校验');
      assert(countUnpacked(patched1) === countUnpacked(bakBuf) && countUnpacked(bakBuf) > 0,
        'app.asar.unpacked 外置布局完整保留 (' + countUnpacked(patched1) + '/' + countUnpacked(bakBuf) + ')');
      assert(fp.readAsarAppVersion(patched1) === fp.readAsarAppVersion(bakBuf), '补丁前后应用版本一致 (' + fp.readAsarAppVersion(patched1) + ')');
      assert(!fs.existsSync(path.join(tmpDir, 'app.asar.patched')) && !fs.existsSync(path.join(tmpDir, 'app.asar.swap-old')) && !fs.existsSync(path.join(tmpDir, 'app.asar.new')),
        '不残留 app.asar.patched / swap-old / new');
      const meta = JSON.parse(fs.readFileSync(path.join(tmpDir, '.antigravity_chinese_meta.json'), 'utf8'));
      assert(meta.patchedFingerprint === fp.getAsarFingerprintFromBuffer(patched1) && meta.sourceFingerprint === fp.getAsarFingerprintFromBuffer(bakBuf),
        '元数据记录了补丁指纹与源指纹');

      const run2 = runPatch();
      const patched2 = fs.readFileSync(testAsar);
      assert(run2.status === 0 && patched2.equals(patched1) && fs.readFileSync(testBak).equals(bakBuf),
        '二次执行幂等（基于纯净备份重建，结果逐字节一致，备份未被污染）');

      // Verify live process & updater check path (skipProcessCheck: false) does not self-match powershell/pwsh/node
      let liveProcCheckOk = false;
      try {
        const liveRes = fp.fastPatchAsar({ customPath: testAsar, skipPlugins: true, skipBgSync: true, skipProcessCheck: false });
        liveProcCheckOk = Boolean(liveRes && liveRes.mode === 'applied');
      } catch (_) {}
      assert(liveProcCheckOk, 'ensureTargetNotRunning 实机进程与更新器检测路径通过（排除自身 PowerShell 与脚本宿主进程，无自匹配假阳性）');

      if (asarLib) {
        const preload = asarLib.extractFile(testAsar, 'dist/preload.js').toString();
        const ipc = asarLib.extractFile(testAsar, 'dist/ipcHandlers.js').toString();
        const parserSrc = asarLib.extractFile(testAsar, 'dist/agyHudTelemetryParser.cjs').toString();
        let syntaxOk = true;
        try { new Function(preload); new Function('require', 'exports', 'module', ipc); } catch (_) { syntaxOk = false; }
        assert(syntaxOk && preload.includes('__AGY_HUD_FETCH__') && !preload.includes('BRIDGE_BASE') &&
          ipc.includes('__AGY_CONTEXT_MENU_MAP__') && ipc.includes('summarizeTelemetry') && parserSrc.includes('summarizeTelemetry'),
          '@electron/asar 读取验证：preload/ipcHandlers 语法正确，含汉化右键菜单映射、精简 IPC，且无 53991 端口');
      }
    } finally {
      // Always unlink directory junction BEFORE recursive rmSync so real unpacked files are never traversed
      try { if (fs.existsSync(testUnpacked)) fs.unlinkSync(testUnpacked); } catch (_) {}
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  } else {
    skip('缺少本地真实 ASAR / antigravity-chinese 词库或 pwsh，跳过 Section 4b 端到端沙盒补丁测试');
  }

  // 4c. Corrupted target + backup recovery hint & new defensive checks (Items 1-5)
  console.log('\n--- 4c. 验证新增安全与健壮性护栏 (坏 JSON / 坏 JS / 缺 electron_1 / Fuse 位 / HEAD 校验 / 备份恢复提示) ---');
  const junkDir = fs.mkdtempSync(path.join(tempRoot, 'agy-junk-test-'));
  try {
    const junkAsar = path.join(junkDir, 'app.asar');
    fs.writeFileSync(junkAsar, 'not an asar');

    if (hasRealAsar && hasI18nRepo && bakBuf) {
      if (patched1) fs.writeFileSync(path.join(junkDir, 'app.asar.patched'), patched1);
      fs.copyFileSync(realBak, path.join(junkDir, 'app.asar.bak'));
      fs.writeFileSync(path.join(junkDir, '.antigravity_chinese_meta.json'), JSON.stringify({
        sourceFingerprint: fp.getAsarFingerprintFromBuffer(bakBuf)
      }), 'utf8');

      let corruptErr = '';
      try {
        fp.fastPatchAsar({ customPath: junkAsar, skipPlugins: true, skipBgSync: true, skipProcessCheck: true });
      } catch (err) {
        corruptErr = err.message;
      }
      assert(corruptErr.includes('不是有效的 ASAR 归档') && corruptErr.includes('app.asar.bak') && fs.readFileSync(junkAsar, 'utf8') === 'not an asar',
        '非 ASAR 目标被拒绝（不拷贝预编译缓存），且检测到有效匹配备份时提示从 app.asar.bak 恢复');

      // Test 1: Bad JSON dictionary rejected before splicing
      const badDictFile = path.join(junkDir, 'bad-dict.json');
      fs.writeFileSync(badDictFile, '{ "exact": { "broken": } }', 'utf8');
      let badJsonErr = '';
      try {
        fp.patchAsarBufferInMemory(bakBuf, { dictPath: badDictFile });
      } catch (err) {
        badJsonErr = err.message;
      }
      assert(badJsonErr.includes('汉化词库 JSON 校验失败'), '注入前校验：损坏的词库 JSON 被拦截并中止补丁');

      // Test 2: Bad JS syntax in runtime rejected by vm.Script
      const badRuntimeFile = path.join(junkDir, 'bad-runtime.js');
      fs.writeFileSync(badRuntimeFile, 'function brokenSyntax( {', 'utf8');
      let badJsErr = '';
      try {
        fp.patchAsarBufferInMemory(bakBuf, { runtimePath: badRuntimeFile });
      } catch (err) {
        badJsErr = err.message;
      }
      assert(badJsErr.includes('JS 语法校验失败 (dist/preload.js)'), '注入前校验：语法错误的注入 JS 被 vm.Script 拦截并中止补丁');

      // Test 3: Missing electron_1 binding in preload.js rejected
      const noElectronBuf = Buffer.from(bakBuf);
      const needle = Buffer.from('electron_1');
      const replacement = Buffer.from('el_missing');
      let searchFrom = 0;
      while (true) {
        const eIdx = noElectronBuf.indexOf(needle, searchFrom);
        if (eIdx === -1) break;
        replacement.copy(noElectronBuf, eIdx);
        searchFrom = eIdx + replacement.length;
      }
      let noElectronErr = '';
      try {
        fp.patchAsarBufferInMemory(noElectronBuf);
      } catch (err) {
        noElectronErr = err.message;
      }
      assert(noElectronErr.includes('缺少预期的 electron_1 绑定'), '注入点断言：缺少 electron_1 绑定时拒绝注入并中止补丁');

      // Test 3b: Per-file marker verification rejects archive where ipcHandlers.js lost HUD marker
      if (patched1) {
        const halfPatchedBuf = Buffer.from(patched1);
        const hudMarkerBuf = Buffer.from('Antigravity HUD Telemetry Injection');
        for (let k = 0; k < 2; k++) {
          const firstIdx = halfPatchedBuf.indexOf(hudMarkerBuf);
          if (firstIdx !== -1) Buffer.from('Antigravity XXX Telemetry Injection').copy(halfPatchedBuf, firstIdx);
        }
        let perFileErr = '';
        try {
          fp.verifyPatchedAsarIntegrity(halfPatchedBuf);
        } catch (err) {
          perFileErr = err.message;
        }
        assert(!fp.isBufferHudPatched(halfPatchedBuf) && perFileErr.includes('dist/ipcHandlers.js 缺少 HUD 注入标记'),
          '逐文件标记校验：preload.js 含标记但 ipcHandlers.js 缺失标记时精准报错拦截');
      }

      // Test 3c: Rollback failure reports honest error & manual recovery path (never falsely claims rolled back)
      const rbTestDir = path.join(junkDir, 'rb-fail');
      fs.mkdirSync(rbTestDir, { recursive: true });
      const rbAsar = path.join(rbTestDir, 'app.asar');
      fs.copyFileSync(realBak, rbAsar);
      let rbFailErr = '';
      try {
        fp.fastPatchAsar({
          customPath: rbAsar,
          skipPlugins: true,
          skipBgSync: true,
          skipProcessCheck: true,
          afterSwapHook: (targetAsar, swapOld) => {
            fs.writeFileSync(targetAsar, 'corrupted after swap');
            fs.rmSync(swapOld, { force: true });
          }
        });
      } catch (err) {
        rbFailErr = err.message;
      }
      assert(rbFailErr.includes('自动回滚失败') && rbFailErr.includes('请手动将') && !rbFailErr.includes('已回滚到补丁前状态'),
        '回滚诚实报错：终检失败且自动回滚失败时如实报告并给出手动恢复路径');

      // Test 4a: Fuse check on real Antigravity.exe (bit 4 == '0')
      const realFuse = fp.checkElectronAsarFuse(path.join(realResDir, 'app.asar'));
      assert(realFuse.checked && realFuse.integrityBit === '0', `真实 Antigravity.exe Fuse 检查通过 (wire=${realFuse.wire}, 第4位=${realFuse.integrityBit})`);
    } else {
      skip('缺少本地真实 ASAR 备份或汉化词库，跳过 Section 4c 真实 ASAR 坏包/回滚/实机 Fuse 测试');
    }

    // Test 4b: Mock exe with bit 4 == '1' (CI-portable)
    const mockExe = path.join(junkDir, 'Antigravity.exe');
    const fusePayload = Buffer.concat([
      Buffer.from('MZ-mock-header-'),
      Buffer.from(fp.FUSE_SENTINEL, 'ascii'),
      Buffer.from([0x01, 0x09]),
      Buffer.from('101110011', 'ascii') // index 4 is '1' (EnableEmbeddedAsarIntegrityValidation enabled)
    ]);
    fs.writeFileSync(mockExe, fusePayload);
    let fuseErr = '';
    try {
      fp.checkElectronAsarFuse(junkAsar, { exePath: mockExe });
    } catch (err) {
      fuseErr = err.message;
    }
    assert(fuseErr.includes('EnableEmbeddedAsarIntegrityValidation'), 'Fuse 检查：当 EnableEmbeddedAsarIntegrityValidation 位为 1 时拒绝补丁并说明原因');

    // Test 5: Upstream HEAD mismatch & --apply requires concrete SHA (CI-portable with temporary git repo)
    const tmpGitRepo = path.join(junkDir, 'mock-chinese-repo');
    fs.mkdirSync(tmpGitRepo, { recursive: true });
    let hasGitRepo = false;
    const gitProbe = spawnSync('git', ['--version'], { encoding: 'utf8' });
    if (!gitProbe.error && gitProbe.status === 0) {
      const r1 = spawnSync('git', ['init'], { cwd: tmpGitRepo, encoding: 'utf8' });
      const r2 = spawnSync('git', ['config', 'user.email', 'test@example.com'], { cwd: tmpGitRepo, encoding: 'utf8' });
      const r3 = spawnSync('git', ['config', 'user.name', 'test'], { cwd: tmpGitRepo, encoding: 'utf8' });
      const r4 = spawnSync('git', ['-c', 'commit.gpgsign=false', 'commit', '--allow-empty', '-m', 'init'], { cwd: tmpGitRepo, encoding: 'utf8' });
      hasGitRepo = r1.status === 0 && r2.status === 0 && r3.status === 0 && r4.status === 0;
    }
    const mismatchStatusFile = path.join(junkDir, 'mismatch-sync.json');
    fs.writeFileSync(mismatchStatusFile, JSON.stringify({
      head: '0000000000000000000000000000000000000000',
      approvedHead: '0000000000000000000000000000000000000000'
    }), 'utf8');
    const trustRes = fp.verifyUpstreamHeadTrusted({
      chineseRoot: hasGitRepo ? tmpGitRepo : undefined,
      syncStatusFile: mismatchStatusFile
    });
    const headCheckedOk = !trustRes.trusted && (!hasGitRepo || (/^[0-9a-f]{40}$/i.test(trustRes.actualHead) && trustRes.actualHead !== trustRes.approvedHead));
    if (hasRealAsar && hasI18nRepo && bakBuf) {
      const fallbackPatched = fp.patchAsarBufferInMemory(bakBuf, { syncStatusFile: mismatchStatusFile, forceRecheckUpstream: true });
      assert(headCheckedOk && fp.verifyPatchedAsarIntegrity(fallbackPatched),
        '上游信任检查：git HEAD 与已确认 SHA 不一致时拒绝加载上游 cli.js，安全回退到内置本地规则');
    } else {
      assert(headCheckedOk, '上游信任检查：git HEAD 与已确认 SHA 不一致时返回 trusted=false');
    }

    process.env.AGY_SYNC_STATUS_FILE = mismatchStatusFile;
    const badApplyRes = bgSync.applyPendingUpdate('origin/main');
    delete process.env.AGY_SYNC_STATUS_FILE;
    assert(!badApplyRes.ok && badApplyRes.error.includes('--apply <sha>'),
      'bg-sync --apply 拒绝直接合并 origin/main 分支引用，强制要求具体提交 SHA');
  } finally {
    fs.rmSync(junkDir, { recursive: true, force: true });
  }

  // 5. Backend Go 1M Context & Rules Patcher (backend-patcher.cjs) + Python Reference Parity + SQLite Session Linkage
  console.log('\n--- 5. 验证后端 Go 1M 上下文补丁引擎 (backend-patcher.cjs) + Python 参考逐字节一致性 + SQLite 会话窗口联动 ---');
  const bp = require('../core/backend-patcher.cjs');
  const refPyScript = path.join(ROOT, 'reference', 'fix_antigravity_context.py');
  assert(fs.existsSync(refPyScript) && fs.existsSync(path.join(ROOT, 'reference', 'verify_session.py')),
    '保留了 Python 参考实现 (reference/fix_antigravity_context.py & reference/verify_session.py)');

  const realLsExe = path.join(realResDir, 'bin', 'language_server.exe');
  if (fs.existsSync(realLsExe)) {
    console.log(`[INFO] 检测到真实 Windows PE 后端二进制 (${realLsExe})`);

    // 5a. Locate Go pclntab functions, select trampoline host, and verify 100% parity with reference/fix_antigravity_context.py
    const nodePlan512 = bp.analyzeBinary(realLsExe, { backupDir: false, contextLimit: 512000 });
    assert(
      nodePlan512.format === 'PE' &&
      nodePlan512.arch === 'x86_64' &&
      nodePlan512.changes.length === 9 &&
      nodePlan512.functions.trampolineHost.symbol.endsWith('(*CheckpointConfig).SetSessionSummaryPromptOverride'),
      `Windows PE pclntab 定位全部 9 个目标函数与跳板宿主成功 (host=${nodePlan512.functions.trampolineHost.symbol.split('.').pop()}, sites=${nodePlan512.changes.length})`
    );

    let pyCmd = null;
    for (const candidate of ['python', 'python3']) {
      const probe = spawnSync(candidate, ['--version'], { encoding: 'utf8' });
      if (!probe.error && probe.status === 0) {
        pyCmd = candidate;
        break;
      }
    }
    if (pyCmd) {
      const pyCheck = spawnSync(pyCmd, [
        '-c',
        `import json, sys; from pathlib import Path; sys.path.insert(0, ${JSON.stringify(path.join(ROOT, 'reference'))}); import fix_antigravity_context as f; print(json.dumps(f.analyze_binary(Path(${JSON.stringify(realLsExe)}), backup_dir=False, context_limit=512000)))`
      ], { encoding: 'utf8' });
      assert(pyCheck.status === 0, `Python 参考实现 (${pyCmd}: reference/fix_antigravity_context.py) 在 Windows PE 上成功生成补丁计划`);
      if (pyCheck.status === 0) {
        const pyPlan512 = JSON.parse(pyCheck.stdout);
        assert(
          nodePlan512.sha256 === pyPlan512.sha256 &&
          nodePlan512.pclntab_offset === pyPlan512.pclntab_offset &&
          nodePlan512.go_text_va === pyPlan512.go_text_va &&
          JSON.stringify(nodePlan512.field_offsets) === JSON.stringify(pyPlan512.field_offsets) &&
          JSON.stringify(nodePlan512.functions) === JSON.stringify(pyPlan512.functions) &&
          JSON.stringify(nodePlan512.changes) === JSON.stringify(pyPlan512.changes),
          'Node.js backend-patcher.cjs 与 Python 参考实现的 pclntab 偏移、结构体字段偏移、9 处补丁机器码逐字节 100% 一致'
        );
      }
    } else {
      skip('未检测到 Python (python/python3)，跳过 Python 参考实现一致性校验');
    }

    // 5b. Sandbox binary patching (512K), idempotency, threshold switching (734K -> 600K), and exact backup restore
    const lsSandboxDir = fs.mkdtempSync(path.join(tempRoot, 'agy-ls-sandbox-'));
    try {
      const sandboxExe = path.join(lsSandboxDir, 'language_server.exe');
      const sandboxBackupDir = path.join(lsSandboxDir, 'backups');
      let sourceUnpatchedExe = realLsExe;
      try {
        const checkReal = bp.analyzeBinary(realLsExe, { backupDir: false });
        if (checkReal.status === 'ALREADY_PATCHED') {
          const { backupPath } = bp.selectRestoreBackup(realLsExe, bp.DEFAULT_BACKUP_DIR);
          if (backupPath && fs.existsSync(backupPath)) sourceUnpatchedExe = backupPath;
        }
      } catch (_) {}
      fs.copyFileSync(sourceUnpatchedExe, sandboxExe);
      const origAnalysis = bp.analyzeBinary(sandboxExe, { backupDir: sandboxBackupDir });
      const origSha256 = origAnalysis.sha256;

      // Test full lifecycle from unpatched original binary
      if (origAnalysis.status === 'UNPATCHED') {
        const p512 = bp.patchTarget(sandboxExe, { backupDir: sandboxBackupDir, contextLimit: 512000 });
        const check512 = bp.analyzeBinary(sandboxExe, { backupDir: sandboxBackupDir });
        assert(
          p512.status === 'PATCHED' &&
          check512.status === 'ALREADY_PATCHED' &&
          check512.context_limit === 512000 &&
          fs.existsSync(p512.backup_path) &&
          fs.existsSync(p512.manifest_path),
          `实际二进制沙盒打补丁 (512K) 成功并生成原版备份与清单 (patched_sha256=${p512.patched_sha256.slice(0, 12)}..)`
        );

        // Idempotency on repeated execution with same 512K limit
        const p512Repeat = bp.patchTarget(sandboxExe, { backupDir: sandboxBackupDir, contextLimit: 512000 });
        assert(
          p512Repeat.status === 'ALREADY_PATCHED' &&
          p512Repeat.sha256 === p512.patched_sha256,
          '重复执行相同阈值 (512K) 具备幂等性，不重复改写二进制或污染原版备份'
        );

        // Seamless threshold switching: 512K -> 734K -> 600K (custom)
        const p734 = bp.patchTarget(sandboxExe, { backupDir: sandboxBackupDir, contextLimit: 734000 });
        const check734 = bp.analyzeBinary(sandboxExe, { backupDir: sandboxBackupDir });
        const p600 = bp.patchTarget(sandboxExe, { backupDir: sandboxBackupDir, contextLimit: 600000 });
        const check600 = bp.analyzeBinary(sandboxExe, { backupDir: sandboxBackupDir });
        assert(
          p734.status === 'PATCHED' && check734.status === 'ALREADY_PATCHED' && check734.context_limit === 734000 &&
          p600.status === 'PATCHED' && check600.status === 'ALREADY_PATCHED' && check600.context_limit === 600000,
          '支持基于验证备份无缝切换压缩阈值 (512K -> 734K -> 自定义 600K) 并通过跳板指令解码验证'
        );

        // Verified binary startup (--version / --help execution check on patched PE binary)
        const verOut = bp.getBinaryVersion(sandboxExe);
        assert(typeof verOut === 'string' && verOut.length > 0, `打补丁后的 Windows PE 二进制可正常加载执行 (version=${verOut})`);

        // Restore original binary and verify SHA256
        const restored = bp.restoreTarget(sandboxExe, { backupDir: sandboxBackupDir });
        const checkRestored = bp.analyzeBinary(sandboxExe, { backupDir: sandboxBackupDir });
        assert(
          restored.status === 'RESTORED' &&
          restored.restored_sha256 === origSha256 &&
          checkRestored.status === 'UNPATCHED' &&
          checkRestored.sha256 === origSha256,
          `备份恢复验证通过：恢复后文件 SHA256 与原版 100% 一致 (${origSha256.slice(0, 12)}..)`
        );
      } else {
        skip('真实后端二进制已打补丁且无未打补丁备份，跳过 Section 5b 生命周期沙盒测试');
      }
    } finally {
      fs.rmSync(lsSandboxDir, { recursive: true, force: true });
    }
  } else {
    skip(`未检测到真实 Windows PE 后端二进制 (${realLsExe})，跳过 Section 5a/5b 真实二进制与 Python 一致性测试`);
  }

  // 5c. Verify SQLite gen_metadata + executor_metadata protobuf parsing & HUD 512k linkage
  let DatabaseSync = null;
  try {
    ({ DatabaseSync } = require('node:sqlite'));
  } catch (_) {}

  if (DatabaseSync) {
    const sqlSandboxDir = fs.mkdtempSync(path.join(tempRoot, 'agy-sql-sandbox-'));
    try {
      const sbBrainDir = path.join(sqlSandboxDir, 'brain');
      const sbConvDir = path.join(sqlSandboxDir, 'conversations');
      const sbCid = '55555555-5555-4555-8555-555555555555';
      const sbLogsDir = path.join(sbBrainDir, sbCid, '.system_generated', 'logs');
      fs.mkdirSync(sbLogsDir, { recursive: true });
      fs.mkdirSync(sbConvDir, { recursive: true });

      fs.writeFileSync(path.join(sbLogsDir, 'transcript_full.jsonl'), [
        JSON.stringify({ step_index: 1, type: 'USER_INPUT', content: '测试 512K 补丁联动', created_at: '2026-11-08T15:00:00Z' }),
        JSON.stringify({
          step_index: 2,
          type: 'PLANNER_RESPONSE',
          status: 'DONE',
          created_at: '2026-11-08T15:00:05Z',
          input_tokens: 18000,
          cache_read_tokens: 110000,
          output_tokens: 600,
          thinking: '思考',
          content: '回复'
        })
      ].join('\n') + '\n', 'utf8');

      const encodeVarint = (num) => {
        const out = [];
        let v = BigInt(num);
        while (v >= 128n) {
          out.push(Number((v & 127n) | 128n));
          v >>= 7n;
        }
        out.push(Number(v));
        return Buffer.from(out);
      };
      const encodeTag = (field, wire) => encodeVarint((field << 3) | wire);
      const encodeLenField = (field, payload) => Buffer.concat([encodeTag(field, 2), encodeVarint(payload.length), payload]);
      const encodeVarintField = (field, val) => Buffer.concat([encodeTag(field, 0), encodeVarint(val)]);

      // Build gen_metadata protobuf: field 1 (chat) -> { field 3: 1417 (M417), field 19: "gemini-4-argon", field 9 -> field 10 -> { field 1: 128000, field 4: 512000 } }
      const winMsg = Buffer.concat([encodeVarintField(1, 128000), encodeVarintField(4, 512000)]);
      const field9Msg = encodeLenField(10, winMsg);
      const chatMsg = Buffer.concat([
        encodeVarintField(3, 1417),
        encodeLenField(19, Buffer.from('gemini-4-argon', 'utf8')),
        encodeLenField(9, field9Msg)
      ]);
      const genBlob = encodeLenField(1, chatMsg);

      // Build executor_metadata protobuf: field 10 -> field 2 -> field 5: 512000
      const execBlob = encodeLenField(10, encodeLenField(2, encodeVarintField(5, 512000)));

      const sbDbPath = path.join(sbConvDir, `${sbCid}.db`);
      const db = new DatabaseSync(sbDbPath);
      db.exec('CREATE TABLE gen_metadata (idx INTEGER PRIMARY KEY, data BLOB);');
      db.exec('CREATE TABLE executor_metadata (idx INTEGER PRIMARY KEY, data BLOB);');
      db.prepare('INSERT INTO gen_metadata (idx, data) VALUES (?, ?)').run(1, genBlob);
      db.prepare('INSERT INTO executor_metadata (idx, data) VALUES (?, ?)').run(1, execBlob);
      db.close();

      const parsed512 = parser.parseConversationTelemetry(sbCid, { brainDir: sbBrainDir, noCache: true });
      assert(
        parsed512 &&
        parsed512.contextLimit === 512000 &&
        parsed512.contextUsagePct === 25 &&
        parsed512.dbMeta &&
        parsed512.dbMeta.genMaxContextTokens === 512000 &&
        parsed512.dbMeta.executorMaxTokenLimit === 512000 &&
        parsed512.dbMeta.state === 'EXPECTED_WINDOW',
        `telemetry-parser 从 SQLite gen_metadata 自动解析真实压缩上限: ${parsed512.currentContext.toLocaleString()} / ${parsed512.contextLimit.toLocaleString()} (${parsed512.contextUsagePct}%, state=${parsed512.dbMeta.state})`
      );
    } finally {
      fs.rmSync(sqlSandboxDir, { recursive: true, force: true });
    }
  } else {
    skip('当前 Node.js 运行时不可用 node:sqlite，跳过 Section 5c SQLite 沙盒测试');
  }

  // Clean up isolated nested temp root
  try { fs.rmSync(tempRoot, { recursive: true, force: true }); } catch (_) {}

  console.log('\n============================================================');
  console.log(`[SUMMARY] 验证结果: 共 ${passed + failed} 项断言, 通过 ${passed} 项, 失败 ${failed} 项, 跳过 ${skipped} 项`);
  console.log('============================================================');
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('[FATAL] 测试运行异常:', err);
  try { fs.rmSync(tempRoot, { recursive: true, force: true }); } catch (_) {}
  process.exit(1);
});
