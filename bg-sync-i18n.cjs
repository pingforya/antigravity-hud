#!/usr/bin/env node
'use strict';

/**
 * antigravity-chinese background update checker.
 *
 * Default mode (spawned detached after each successful patch):
 *   - `git fetch origin main` (with a probed local proxy if one is available)
 *   - records how many upstream commits are pending in .last_bg_sync.json
 *   - NEVER merges and NEVER rebuilds anything: upstream JS (i18n-runtime.js, cli.js
 *     transforms) ends up inside the client's privileged preload/main process, so it is
 *     only applied after the user explicitly confirms (patch.ps1 prompt or `--apply`).
 *
 * `--apply <sha>` mode: fast-forwards the checkout to the specific user-confirmed commit `<sha>`
 * (refuses branch names or dirty tracked files), records `approvedHead` in .last_bg_sync.json,
 * and reports any error instead of silently swallowing it.
 *
 * `--daemon-run` mode: internal marker passed by `spawnDetachedBackgroundSync()` for detached
 * fetch-only background runs (equivalent to default mode).
 */

const fs = require('fs');
const net = require('net');
const crypto = require('crypto');
const { spawn, execFileSync } = require('child_process');
const P = require('./paths.cjs');

const MIN_SYNC_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes cooldown unless --force

function getChinesePaths() {
  return process.env.AGY_CHINESE_ROOT ? P.resolveChinesePaths(process.env.AGY_CHINESE_ROOT) : P;
}

function getStatusFile() {
  return process.env.AGY_SYNC_STATUS_FILE || P.SYNC_STATUS_FILE;
}

function readSyncStatus() {
  try {
    const sf = getStatusFile();
    if (fs.existsSync(sf)) {
      return JSON.parse(fs.readFileSync(sf, 'utf8'));
    }
  } catch (_) {}
  return null;
}

function writeSyncStatus(status) {
  const sf = getStatusFile();
  const tmp = `${sf}.tmp-${process.pid}-${crypto.randomBytes(6).toString('hex')}`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(status, null, 2), 'utf8');
    fs.renameSync(tmp, sf);
  } catch (_) {
  } finally {
    try {
      if (fs.existsSync(tmp)) fs.rmSync(tmp, { force: true });
    } catch (_) {}
  }
}

function getLocalVersion() {
  try {
    const pkg = JSON.parse(fs.readFileSync(getChinesePaths().CHINESE_PKG_PATH, 'utf8'));
    return pkg.version || 'unknown';
  } catch (_) {
    return 'unknown';
  }
}

// --- Proxy probing --------------------------------------------------------------
// An open port is not necessarily a proxy, and 1080/10808 are usually SOCKS5.
// Probe the protocol so git gets a URL with the right scheme.

function probe(port, payload, isOk, timeoutMs = 600) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let settled = false;
    let data = Buffer.alloc(0);
    const done = (ok) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => socket.write(payload));
    socket.on('data', (chunk) => {
      data = Buffer.concat([data, chunk]);
      const verdict = isOk(data);
      if (verdict !== undefined) done(verdict);
    });
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
    socket.once('close', () => done(false));
    socket.connect(port, '127.0.0.1');
  });
}

function probeHttpProxy(port) {
  return probe(port, Buffer.from('CONNECT github.com:443 HTTP/1.1\r\nHost: github.com:443\r\n\r\n'), (d) => {
    const s = d.toString('latin1');
    if (!s.includes('\r\n')) return undefined;
    return /^HTTP\/1\.[01] 200/.test(s);
  });
}

function probeSocks5(port) {
  return probe(port, Buffer.from([0x05, 0x01, 0x00]), (d) => {
    if (d.length < 2) return undefined;
    return d[0] === 0x05 && d[1] === 0x00;
  });
}

async function detectLocalProxy() {
  const existing = process.env.HTTPS_PROXY || process.env.HTTP_PROXY || process.env.ALL_PROXY;
  if (existing) return existing;
  const candidatePorts = [7890, 7897, 10809, 10808, 1080];
  for (const port of candidatePorts) {
    if (await probeHttpProxy(port)) return `http://127.0.0.1:${port}`;
    if (await probeSocks5(port)) return `socks5h://127.0.0.1:${port}`;
  }
  return null;
}

function gitExec(args, extraEnv = {}, timeoutMs = 8000) {
  return execFileSync('git', ['-C', getChinesePaths().CHINESE_ROOT, ...args], {
    encoding: 'utf8',
    timeout: timeoutMs,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      GIT_TERMINAL_PROMPT: '0',
      ...extraEnv
    }
  }).trim();
}

function errText(err) {
  const stderr = err && err.stderr ? String(err.stderr).trim() : '';
  return stderr || (err && err.message) || String(err);
}

function getPendingInfo() {
  const head = gitExec(['rev-parse', 'HEAD'], {}, 3000);
  const remoteHead = gitExec(['rev-parse', 'origin/main'], {}, 3000);
  const count = Number(gitExec(['rev-list', '--count', 'HEAD..origin/main'], {}, 3000)) || 0;
  const commits = count > 0
    ? gitExec(['log', '--oneline', '--no-decorate', '-n', '20', 'HEAD..origin/main'], {}, 3000).split('\n').filter(Boolean)
    : [];
  return { head, remoteHead, count, commits };
}

async function runBackgroundSync(options = {}) {
  if (!fs.existsSync(getChinesePaths().CHINESE_ROOT)) return { ok: false, reason: 'repo_missing' };

  const prevStatus = readSyncStatus();
  const now = Date.now();
  if (!options.force && prevStatus && prevStatus.lastAttemptAt && (now - prevStatus.lastAttemptAt < MIN_SYNC_INTERVAL_MS)) {
    return { ok: true, skipped: true, version: getLocalVersion() };
  }

  writeSyncStatus({ ...(prevStatus || {}), lastAttemptAt: now });

  const detectedProxy = await detectLocalProxy();
  const envAttempts = [];
  if (detectedProxy) envAttempts.push({ HTTPS_PROXY: detectedProxy, HTTP_PROXY: detectedProxy });
  envAttempts.push({});

  let fetchSucceeded = false;
  let usedProxy = 'direct';
  let lastError = '';
  for (const envVars of envAttempts) {
    try {
      gitExec(['fetch', 'origin', 'main', '--quiet'], envVars, 15000);
      fetchSucceeded = true;
      usedProxy = envVars.HTTPS_PROXY || 'direct';
      break;
    } catch (err) {
      lastError = errText(err);
    }
  }

  if (!fetchSucceeded) {
    const status = {
      ...(prevStatus || {}),
      lastAttemptAt: now,
      lastSuccessAt: prevStatus ? prevStatus.lastSuccessAt || null : null,
      ok: false,
      version: getLocalVersion(),
      pendingUpdate: prevStatus ? prevStatus.pendingUpdate || null : null,
      error: `git fetch 失败: ${lastError}`.slice(0, 500)
    };
    writeSyncStatus(status);
    return { ok: false, reason: 'fetch_failed', error: lastError };
  }

  let pending;
  try {
    pending = getPendingInfo();
  } catch (err) {
    const status = {
      ...(prevStatus || {}),
      lastAttemptAt: now,
      lastSuccessAt: prevStatus ? prevStatus.lastSuccessAt || null : null,
      lastAppliedAt: prevStatus ? prevStatus.lastAppliedAt || null : null,
      ok: false,
      version: getLocalVersion(),
      error: `读取提交信息失败: ${errText(err)}`.slice(0, 500)
    };
    writeSyncStatus(status);
    return status;
  }

  const finalStatus = {
    ...(prevStatus || {}),
    lastAttemptAt: now,
    lastSuccessAt: now,
    lastAppliedAt: (prevStatus && prevStatus.lastAppliedAt) || undefined,
    ok: true,
    version: getLocalVersion(),
    head: pending.head,
    approvedHead: (prevStatus && prevStatus.approvedHead) || undefined,
    proxyUsed: usedProxy,
    error: undefined,
    pendingUpdate: pending.count > 0
      ? { count: pending.count, remoteHead: pending.remoteHead, commits: pending.commits }
      : null
  };
  writeSyncStatus(finalStatus);
  return finalStatus;
}

/** Explicit, user-confirmed fast-forward to a specific commit SHA (never a branch ref). */
function applyPendingUpdate(targetSha) {
  const prev = readSyncStatus() || {};
  const result = { ok: false };
  const cleanSha = typeof targetSha === 'string' ? targetSha.trim() : '';
  if (!/^[0-9a-f]{7,40}$/i.test(cleanSha)) {
    result.error = '必须指定明确的目标提交 SHA (--apply <sha>)，拒绝直接合并分支引用';
    return result;
  }
  let isDetached = false;
  try {
    const dirty = gitExec(['status', '--porcelain', '--untracked-files=no'], {}, 5000);
    if (dirty) throw new Error(`上游仓库存在未提交的已跟踪文件修改，已拒绝合并:\n${dirty}`);
    try {
      gitExec(['symbolic-ref', '--quiet', 'HEAD'], {}, 3000);
    } catch (_) {
      isDetached = true;
    }
    const before = gitExec(['rev-parse', 'HEAD'], {}, 3000);
    if (!before.toLowerCase().startsWith(cleanSha.toLowerCase())) {
      gitExec(['merge', '--ff-only', cleanSha], {}, 15000);
    }
    const after = gitExec(['rev-parse', 'HEAD'], {}, 3000);
    Object.assign(result, { ok: true, from: before, to: after, version: getLocalVersion() });
    writeSyncStatus({
      ...prev,
      ok: true,
      version: result.version,
      head: after,
      approvedHead: after,
      pendingUpdate: null,
      lastAppliedAt: Date.now(),
      lastSuccessAt: prev.lastSuccessAt || Date.now(),
      error: undefined
    });
  } catch (err) {
    const rawMsg = errText(err);
    result.error = isDetached
      ? `${rawMsg}（当前处于 detached HEAD 状态，请先切换到 main 分支后再重试: git checkout main）`
      : rawMsg;
    writeSyncStatus({ ...prev, ok: false, error: `合并失败: ${result.error}`.slice(0, 500) });
  }
  return result;
}

/**
 * Spawns this script in a detached, hidden background process (fetch-only).
 */
function spawnDetachedBackgroundSync(force = false) {
  try {
    const args = [__filename, '--daemon-run'];
    if (force) args.push('--force');
    const child = spawn(process.execPath, args, {
      detached: true,
      stdio: 'ignore',
      windowsHide: true
    });
    child.unref();
    return true;
  } catch (_) {
    return false;
  }
}

function printHelp() {
  console.log([
    '用法: node bg-sync-i18n.cjs [选项]',
    '',
    '功能: 检查可选 antigravity-chinese 上游仓库更新 (仅 fetch，绝不自动合并或重建补丁)',
    '',
    '选项:',
    '  --force          忽略 5 分钟冷却间隔，立即拉取上游分支信息',
    '  --verbose        打印 JSON 格式检查结果',
    '  --spawn          在独立后台进程中异步触发检查',
    '  --apply <sha>    将上游仓库快进合并至已确认的具体提交 SHA',
    '  -h, --help       显示此帮助信息'
  ].join('\n'));
}

function parseCliArgs(argv) {
  const opts = {
    help: false,
    force: false,
    verbose: false,
    spawnMode: false,
    daemonRun: false,
    applySha: null
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '-h' || arg === '--help') {
      opts.help = true;
    } else if (arg === '--force') {
      opts.force = true;
    } else if (arg === '--verbose') {
      opts.verbose = true;
    } else if (arg === '--spawn') {
      opts.spawnMode = true;
    } else if (arg === '--daemon-run') {
      opts.daemonRun = true;
    } else if (arg === '--apply') {
      if (i + 1 >= argv.length || !argv[i + 1] || argv[i + 1].startsWith('-')) {
        throw new Error('参数 --apply 缺少目标提交 <sha>');
      }
      opts.applySha = argv[++i];
    } else {
      throw new Error(`未知参数: ${arg} (使用 --help 查看帮助)`);
    }
  }
  return opts;
}

if (require.main === module) {
  let opts;
  try {
    opts = parseCliArgs(process.argv.slice(2));
  } catch (err) {
    console.error(`[ERR] ${err.message}`);
    process.exit(1);
  }

  if (opts.help) {
    printHelp();
    process.exit(0);
  }

  if (opts.applySha !== null) {
    const res = applyPendingUpdate(opts.applySha);
    if (res.ok) {
      console.log(`[OK] 词库仓库已快进: ${res.from.slice(0, 7)} -> ${res.to.slice(0, 7)} (v${res.version})`);
      process.exit(0);
    }
    console.error(`[ERR] 合并上游更新失败: ${res.error}`);
    process.exit(1);
  } else if (opts.spawnMode) {
    spawnDetachedBackgroundSync(opts.force);
    process.exit(0);
  } else {
    // Handles both direct runs and detached `--daemon-run` invocations
    runBackgroundSync({ force: opts.force }).then((res) => {
      if (opts.verbose) {
        console.log(JSON.stringify(res, null, 2));
      }
      process.exit(0);
    }).catch(() => process.exit(0));
  }
}

module.exports = {
  runBackgroundSync,
  applyPendingUpdate,
  spawnDetachedBackgroundSync,
  readSyncStatus,
  getLocalVersion,
  detectLocalProxy
};
