'use strict';
const fs = require('node:fs');
const fsp = fs.promises;
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');

const PENDING_TTL_MS = 45 * 1000;
const LOCK_STALE_MS = 5000;
const TRANSCRIPT_HEAD_BYTES = 131072;
const SUBAGENT_MSG_RE = /\[Message\]\s+timestamp=.*?\bsender=[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i;
const SUBAGENT_REMINDER_RE = /<subagent_reminder>/i;
const SLEEP_I32 = typeof SharedArrayBuffer === 'function' ? new Int32Array(new SharedArrayBuffer(4)) : null;
const SLEEP_I64 = typeof SharedArrayBuffer === 'function' && typeof BigInt64Array === 'function'
  ? new BigInt64Array(new SharedArrayBuffer(8))
  : null;

const validId = (id) => typeof id === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);
const validMode = (mode) => mode === 'hakimi' || mode === 'normal';

function defaultPersonaMode() {
  const envDefault = String(process.env.AGY_HUD_DEFAULT_PERSONA || '').trim().toLowerCase();
  return validMode(envDefault) ? envDefault : 'hakimi';
}

let sqliteLoaded = false;
let DatabaseSync = null;
function getDatabaseSync() {
  if (!sqliteLoaded) {
    sqliteLoaded = true;
    try {
      ({ DatabaseSync } = require('node:sqlite'));
    } catch (_) {}
  }
  return DatabaseSync;
}

function openReadOnlyDb(DbSync, dbPath) {
  try {
    return new DbSync(dbPath, { readOnly: true, timeout: 250 });
  } catch (err) {
    if (
      err &&
      (err instanceof TypeError ||
        err.code === 'ERR_INVALID_ARG_TYPE' ||
        err.code === 'ERR_INVALID_ARG_VALUE' ||
        /timeout|option/i.test(String(err.message || '')))
    ) {
      const db = new DbSync(dbPath, { readOnly: true });
      try { db.exec('PRAGMA busy_timeout = 250'); } catch (_) {}
      return db;
    }
    throw err;
  }
}

function sleepSync(ms) {
  const boundedMs = Math.min(Math.max(0, Number(ms) || 0), 1000);
  if (boundedMs <= 0) return;
  if (SLEEP_I32) {
    try {
      Atomics.wait(SLEEP_I32, 0, 0, boundedMs);
      return;
    } catch (_) {}
  }
  if (SLEEP_I64) {
    try {
      Atomics.wait(SLEEP_I64, 0, 0n, boundedMs);
      return;
    } catch (_) {}
  }
  // Bounded safety exit when Atomics.wait is disallowed on the current thread
  const end = Date.now() + Math.min(boundedMs, 25);
  let guard = 0;
  while (Date.now() < end && guard < 100000) {
    guard++;
  }
}

function sleepAsync(ms) {
  const boundedMs = Math.min(Math.max(0, Number(ms) || 0), 1000);
  if (boundedMs <= 0) return Promise.resolve();
  return new Promise((r) => setTimeout(r, boundedMs));
}

function dataDir() {
  return process.env.AGY_HUD_DATA_DIR || path.join(os.homedir(), '.gemini', 'antigravity', 'sidecar_data', 'agy-hud', 'telemetry', 'data');
}

function modeFile(id) {
  if (!validId(id)) throw Error('需要当前聊天 ID');
  return path.join(dataDir(), 'persona_' + id.toLowerCase() + '.json');
}

function pendingFile() {
  return path.join(dataDir(), 'pending_new_chats.json');
}

function writeJsonAtomic(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp-' + process.pid + '-' + crypto.randomUUID();
  try {
    fs.writeFileSync(tmp, JSON.stringify(obj) + '\n', 'utf8');
    let lastErr = null;
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        fs.renameSync(tmp, file);
        lastErr = null;
        break;
      } catch (err) {
        lastErr = err;
        if (err && (err.code === 'EPERM' || err.code === 'EACCES' || err.code === 'EBUSY') && attempt < 3) {
          sleepSync(5 * (attempt + 1));
          continue;
        }
        throw err;
      }
    }
    if (lastErr) throw lastErr;
  } finally {
    if (fs.existsSync(tmp)) {
      try { fs.unlinkSync(tmp); } catch (_) {}
    }
  }
}

async function writeJsonAtomicAsync(file, obj) {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp-' + process.pid + '-' + crypto.randomUUID();
  try {
    await fsp.writeFile(tmp, JSON.stringify(obj) + '\n', 'utf8');
    let lastErr = null;
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        await fsp.rename(tmp, file);
        lastErr = null;
        break;
      } catch (err) {
        lastErr = err;
        if (err && (err.code === 'EPERM' || err.code === 'EACCES' || err.code === 'EBUSY') && attempt < 3) {
          await sleepAsync(5 * (attempt + 1));
          continue;
        }
        throw err;
      }
    }
    if (lastErr) throw lastErr;
  } finally {
    try { await fsp.unlink(tmp); } catch (_) {}
  }
}

function tryEvictStaleLockSync(lockFile) {
  try {
    const st = fs.statSync(lockFile);
    if (Date.now() - st.mtimeMs > LOCK_STALE_MS) {
      const stConfirm = fs.statSync(lockFile);
      if (stConfirm.mtimeMs === st.mtimeMs && Date.now() - stConfirm.mtimeMs > LOCK_STALE_MS) {
        const stalePath = `${lockFile}.stale-${process.pid}-${Date.now()}`;
        fs.renameSync(lockFile, stalePath);
        try { fs.unlinkSync(stalePath); } catch (_) {}
        return true;
      }
    }
  } catch (_) {}
  return false;
}

async function tryEvictStaleLockAsync(lockFile) {
  try {
    const st = await fsp.stat(lockFile);
    if (Date.now() - st.mtimeMs > LOCK_STALE_MS) {
      const stConfirm = await fsp.stat(lockFile);
      if (stConfirm.mtimeMs === st.mtimeMs && Date.now() - stConfirm.mtimeMs > LOCK_STALE_MS) {
        const stalePath = `${lockFile}.stale-${process.pid}-${Date.now()}`;
        await fsp.rename(lockFile, stalePath);
        try { await fsp.unlink(stalePath); } catch (_) {}
        return true;
      }
    }
  } catch (_) {}
  return false;
}

function withPendingLock(fn) {
  const dir = dataDir();
  fs.mkdirSync(dir, { recursive: true });
  const lockFile = path.join(dir, 'pending_new_chats.lock');
  let fd = null;
  const deadline = Date.now() + 1500;
  let delay = 4;
  while (true) {
    try {
      fd = fs.openSync(lockFile, 'wx');
      try {
        fs.writeSync(fd, `${process.pid}:${Date.now()}\n`);
      } catch (writeErr) {
        try { fs.closeSync(fd); } catch (_) {}
        try { fs.unlinkSync(lockFile); } catch (_) {}
        fd = null;
        throw writeErr;
      }
      break;
    } catch (err) {
      if (err && (err.code === 'EEXIST' || err.code === 'EPERM' || err.code === 'EACCES')) {
        if (tryEvictStaleLockSync(lockFile)) {
          continue;
        }
        if (Date.now() < deadline) {
          sleepSync(delay);
          delay = Math.min(40, delay * 2);
          continue;
        }
        throw new Error('Pending new-chat lock timeout');
      }
      throw err;
    }
  }
  try {
    return fn();
  } finally {
    if (fd !== null) {
      try { fs.closeSync(fd); } catch (_) {}
      try { fs.unlinkSync(lockFile); } catch (_) {}
    }
  }
}

async function withPendingLockAsync(fn) {
  const dir = dataDir();
  await fsp.mkdir(dir, { recursive: true });
  const lockFile = path.join(dir, 'pending_new_chats.lock');
  let fh = null;
  const deadline = Date.now() + 1500;
  let delay = 4;
  while (true) {
    try {
      fh = await fsp.open(lockFile, 'wx');
      try {
        await fh.write(`${process.pid}:${Date.now()}\n`);
      } catch (writeErr) {
        try { await fh.close(); } catch (_) {}
        try { await fsp.unlink(lockFile); } catch (_) {}
        fh = null;
        throw writeErr;
      }
      break;
    } catch (err) {
      if (err && (err.code === 'EEXIST' || err.code === 'EPERM' || err.code === 'EACCES')) {
        if (await tryEvictStaleLockAsync(lockFile)) {
          continue;
        }
        if (Date.now() < deadline) {
          await sleepAsync(delay);
          delay = Math.min(40, delay * 2);
          continue;
        }
        throw new Error('Pending new-chat lock timeout');
      }
      throw err;
    }
  }
  try {
    return await fn();
  } finally {
    if (fh !== null) {
      try { await fh.close(); } catch (_) {}
      try { await fsp.unlink(lockFile); } catch (_) {}
    }
  }
}

function normalizePendingItems(raw, now = Date.now()) {
  const items = Array.isArray(raw && raw.items) ? raw.items : [];
  return items
    .filter((it) =>
      it &&
      typeof it.token === 'string' &&
      it.token.trim().length > 0 &&
      it.token.length <= 128 &&
      validMode(it.mode) &&
      typeof it.createdAtMs === 'number' &&
      Number.isFinite(it.createdAtMs) &&
      (it.claimedBy === null || it.claimedBy === undefined || validId(it.claimedBy)) &&
      now - it.createdAtMs >= -5000 &&
      now - it.createdAtMs <= PENDING_TTL_MS
    )
    .map((it) => ({
      token: it.token,
      mode: it.mode,
      createdAtMs: it.createdAtMs,
      claimedBy: it.claimedBy ? it.claimedBy.toLowerCase() : null
    }));
}

function readPendingList(now = Date.now()) {
  try {
    return normalizePendingItems(JSON.parse(fs.readFileSync(pendingFile(), 'utf8')), now);
  } catch (_) {
    return [];
  }
}

async function readPendingListAsync(now = Date.now()) {
  try {
    return normalizePendingItems(JSON.parse(await fsp.readFile(pendingFile(), 'utf8')), now);
  } catch (_) {
    return [];
  }
}

function validateOptionalToken(token) {
  if (token === undefined || token === null) return '';
  if (typeof token !== 'string' || /[\r\n\0]/.test(token)) {
    throw Error('无效的待建聊天凭据');
  }
  return token.trim().slice(0, 80);
}

function stagePendingNewChat(mode, token) {
  if (!validMode(mode)) throw Error('未知角色模式');
  const cleaned = validateOptionalToken(token);
  const safeToken = cleaned || crypto.randomUUID();
  return withPendingLock(() => {
    const now = Date.now();
    const items = readPendingList(now).filter((it) => it.token !== safeToken);
    items.push({ token: safeToken, mode, createdAtMs: now, claimedBy: null });
    // Keep bounded queue
    const bounded = items.slice(-12);
    writeJsonAtomic(pendingFile(), { items: bounded });
    return { token: safeToken, mode };
  });
}

async function stagePendingNewChatAsync(mode, token) {
  if (!validMode(mode)) throw Error('未知角色模式');
  const cleaned = validateOptionalToken(token);
  const safeToken = cleaned || crypto.randomUUID();
  return withPendingLockAsync(async () => {
    const now = Date.now();
    const items = (await readPendingListAsync(now)).filter((it) => it.token !== safeToken);
    items.push({ token: safeToken, mode, createdAtMs: now, claimedBy: null });
    const bounded = items.slice(-12);
    await writeJsonAtomicAsync(pendingFile(), { items: bounded });
    return { token: safeToken, mode };
  });
}

function cancelPendingNewChat(token) {
  if (typeof token !== 'string' || !token.trim() || /[\r\n\0]/.test(token)) return false;
  const target = token.trim().slice(0, 80);
  return withPendingLock(() => {
    const now = Date.now();
    const items = readPendingList(now);
    const next = items.filter((it) => it.token !== target);
    if (next.length !== items.length) {
      writeJsonAtomic(pendingFile(), { items: next });
      return true;
    }
    return false;
  });
}

async function cancelPendingNewChatAsync(token) {
  if (typeof token !== 'string' || !token.trim() || /[\r\n\0]/.test(token)) return false;
  const target = token.trim().slice(0, 80);
  return withPendingLockAsync(async () => {
    const now = Date.now();
    const items = await readPendingListAsync(now);
    const next = items.filter((it) => it.token !== target);
    if (next.length !== items.length) {
      await writeJsonAtomicAsync(pendingFile(), { items: next });
      return true;
    }
    return false;
  });
}

function commitPendingNewChat(id, mode, token) {
  if (!validId(id)) throw Error('需要当前聊天 ID');
  if (!validMode(mode)) throw Error('未知角色模式');
  const cleanToken = validateOptionalToken(token);
  const savedMode = setMode(id, mode);
  const normId = id.toLowerCase();
  try {
    withPendingLock(() => {
      const now = Date.now();
      const items = readPendingList(now);
      const next = items.filter((it) => {
        if (cleanToken && it.token === cleanToken) return false;
        if (it.claimedBy === normId) return false;
        return true;
      });
      if (next.length !== items.length) {
        writeJsonAtomic(pendingFile(), { items: next });
      }
    });
  } catch (_) {}
  return savedMode;
}

async function commitPendingNewChatAsync(id, mode, token) {
  if (!validId(id)) throw Error('需要当前聊天 ID');
  if (!validMode(mode)) throw Error('未知角色模式');
  const cleanToken = validateOptionalToken(token);
  const savedMode = await setModeAsync(id, mode);
  const normId = id.toLowerCase();
  try {
    await withPendingLockAsync(async () => {
      const now = Date.now();
      const items = await readPendingListAsync(now);
      const next = items.filter((it) => {
        if (cleanToken && it.token === cleanToken) return false;
        if (it.claimedBy === normId) return false;
        return true;
      });
      if (next.length !== items.length) {
        await writeJsonAtomicAsync(pendingFile(), { items: next });
      }
    });
  } catch (_) {}
  return savedMode;
}

function getMode(id) {
  const file = modeFile(id);
  let state;
  try {
    state = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    if (e.code === 'ENOENT') return defaultPersonaMode();
    throw e;
  }
  if (!validMode(state && state.mode)) throw Error('角色设置无法读取');
  return state.mode;
}

async function getModeAsync(id) {
  const file = modeFile(id);
  let state;
  try {
    state = JSON.parse(await fsp.readFile(file, 'utf8'));
  } catch (e) {
    if (e.code === 'ENOENT') return defaultPersonaMode();
    throw e;
  }
  if (!validMode(state && state.mode)) throw Error('角色设置无法读取');
  return state.mode;
}

function setMode(id, mode) {
  if (!validMode(mode)) throw Error('未知角色模式');
  const file = modeFile(id);
  writeJsonAtomic(file, { mode });
  return mode;
}

async function setModeAsync(id, mode) {
  if (!validMode(mode)) throw Error('未知角色模式');
  const file = modeFile(id);
  await writeJsonAtomicAsync(file, { mode });
  return mode;
}

function hasPayloadSubagentMarker(payload) {
  if (!payload || typeof payload !== 'object') return false;
  const common = (payload.common && typeof payload.common === 'object') ? payload.common : null;
  const preArgs = (payload.preInvocationHookArgs && typeof payload.preInvocationHookArgs === 'object')
    ? payload.preInvocationHookArgs
    : ((payload.pre_invocation_hook_args && typeof payload.pre_invocation_hook_args === 'object') ? payload.pre_invocation_hook_args : null);
  const sources = [payload, common, preArgs].filter(Boolean);
  for (const src of sources) {
    if (src.isSubagent === true || src.is_subagent === true) return true;
    for (const key of ['parentConversationId', 'parent_conversation_id', 'subagentType', 'subagent_type']) {
      if (typeof src[key] === 'string' && src[key].trim().length > 0) return true;
    }
    for (const depthKey of ['nestingDepth', 'nesting_depth']) {
      if (src[depthKey] !== undefined && src[depthKey] !== null && src[depthKey] !== '' && Number(src[depthKey]) > 0) {
        return true;
      }
    }
  }
  return false;
}

function readHeadUtf8(filePath, maxBytes = TRANSCRIPT_HEAD_BYTES) {
  let fd = null;
  try {
    fd = fs.openSync(filePath, 'r');
    const buf = Buffer.allocUnsafe(maxBytes);
    const bytesRead = fs.readSync(fd, buf, 0, maxBytes, 0);
    if (bytesRead <= 0) return '';
    return buf.subarray(0, bytesRead).toString('utf8');
  } catch (_) {
    return '';
  } finally {
    if (fd !== null) {
      try { fs.closeSync(fd); } catch (_) {}
    }
  }
}

function isWithinDir(filePath, dirPath) {
  let a = path.resolve(dirPath);
  let b = path.resolve(filePath);
  if (process.platform === 'win32') {
    a = a.toLowerCase();
    b = b.toLowerCase();
  }
  const rel = path.relative(a, b);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

function resolveSafePath(p) {
  const abs = path.resolve(p);
  try {
    return fs.realpathSync(abs);
  } catch (_) {
    try {
      if (fs.lstatSync(abs).isSymbolicLink()) return null;
    } catch (_) {}
  }
  let cur = abs;
  const tail = [];
  while (true) {
    const parent = path.dirname(cur);
    if (parent === cur) return abs;
    tail.unshift(path.basename(cur));
    cur = parent;
    try {
      const realAncestor = fs.realpathSync(cur);
      return path.join(realAncestor, ...tail);
    } catch (_) {
      try {
        if (fs.lstatSync(cur).isSymbolicLink()) return null;
      } catch (_) {}
    }
  }
}

function isAllowedTranscriptPath(rawPath) {
  if (typeof rawPath !== 'string') return false;
  const trimmed = rawPath.trim();
  if (!trimmed || trimmed.includes('\0')) return false;
  if (!trimmed.toLowerCase().endsWith('.jsonl')) return false;
  const resolvedTarget = resolveSafePath(trimmed);
  if (!resolvedTarget) return false;
  const allowedRoots = [path.join(os.homedir(), '.gemini')];
  if (process.env.AGY_BRAIN_DIR) {
    allowedRoots.push(process.env.AGY_BRAIN_DIR);
  }
  return allowedRoots.some((root) => {
    const resolvedRoot = resolveSafePath(root);
    return Boolean(resolvedRoot && isWithinDir(resolvedTarget, resolvedRoot));
  });
}

function candidateTranscriptPaths(id, payload) {
  const paths = [];
  const p = (payload && typeof payload === 'object') ? payload : {};
  const common = (p.common && typeof p.common === 'object') ? p.common : p;
  for (const raw of [p.transcriptPath, p.transcript_path, common.transcriptPath, common.transcript_path]) {
    if (isAllowedTranscriptPath(raw)) {
      const safe = resolveSafePath(raw.trim());
      if (safe) paths.push(safe);
    }
  }
  const normId = id.toLowerCase();
  const ids = id === normId ? [normId] : [id, normId];
  const customBrain = process.env.AGY_BRAIN_DIR;
  if (customBrain) {
    for (const cid of ids) {
      const logsDir = path.join(customBrain, cid, '.system_generated', 'logs');
      paths.push(path.join(logsDir, 'transcript_full.jsonl'), path.join(logsDir, 'transcript.jsonl'));
    }
  } else {
    const home = os.homedir();
    for (const product of ['antigravity', 'antigravity-cli', 'antigravity-ide']) {
      for (const cid of ids) {
        const logsDir = path.join(home, '.gemini', product, 'brain', cid, '.system_generated', 'logs');
        paths.push(path.join(logsDir, 'transcript_full.jsonl'), path.join(logsDir, 'transcript.jsonl'));
      }
    }
  }
  return [...new Set(paths)];
}

function isSubagentFromTranscript(id, payload) {
  const candidates = candidateTranscriptPaths(id, payload);
  for (const filePath of candidates) {
    const head = readHeadUtf8(filePath);
    if (!head) continue;
    const lines = head.split('\n');
    let totalLines = 0;
    let checked = 0;
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      totalLines++;
      if (totalLines > 64) break;
      let step = null;
      try {
        step = JSON.parse(trimmed);
      } catch (_) {
        // Line may be cut off at TRANSCRIPT_HEAD_BYTES boundary; inspect prefix safely
        if (/"type"\s*:\s*"EPHEMERAL_MESSAGE"/.test(trimmed)) continue;
        checked++;
        if (checked > 6) break;
        if (/"type"\s*:\s*"(?:USER_INPUT|PLANNER_RESPONSE)"/.test(trimmed) || /"source"\s*:\s*"USER_EXPLICIT"/.test(trimmed)) {
          break;
        }
        if (/"type"\s*:\s*"SYSTEM_MESSAGE"/.test(trimmed) && (SUBAGENT_MSG_RE.test(trimmed) || SUBAGENT_REMINDER_RE.test(trimmed))) {
          return true;
        }
        break;
      }
      if (!step || typeof step !== 'object') continue;
      if (step.type === 'EPHEMERAL_MESSAGE') continue;
      checked++;
      if (checked > 6) break;
      if (step.isSubagent === true || step.is_subagent === true) return true;
      if (typeof step.parentConversationId === 'string' && step.parentConversationId.trim()) return true;
      if (step.type === 'USER_INPUT' || step.source === 'USER_EXPLICIT' || step.type === 'PLANNER_RESPONSE') {
        // Conversation began with an explicit human user turn; never misclassify later subagent replies
        break;
      }
      if (typeof step.content === 'string' && (SUBAGENT_MSG_RE.test(step.content) || SUBAGENT_REMINDER_RE.test(step.content))) {
        return true;
      }
    }
    // We found and inspected a non-empty primary transcript for this conversation
    if (totalLines > 0) break;
  }
  return false;
}

function isSubagentFromSummaryDb(id) {
  const customBrain = process.env.AGY_BRAIN_DIR;
  const home = os.homedir();
  const dbCandidates = customBrain
    ? [path.join(path.dirname(customBrain), 'conversation_summaries.db')]
    : [
        path.join(home, '.gemini', 'antigravity', 'conversation_summaries.db'),
        path.join(home, '.gemini', 'antigravity-cli', 'conversation_summaries.db'),
        path.join(home, '.gemini', 'antigravity-ide', 'conversation_summaries.db')
      ];
  const existing = dbCandidates.filter((p) => {
    try { return fs.existsSync(p); } catch (_) { return false; }
  });
  if (existing.length === 0) return false;
  const DbSync = getDatabaseSync();
  if (!DbSync) return false;
  const normId = id.toLowerCase();
  for (const dbPath of existing) {
    let db = null;
    try {
      db = openReadOnlyDb(DbSync, dbPath);
      const stmt = db.prepare(
        'SELECT parent_conversation_id, nesting_depth FROM conversation_summaries WHERE conversation_id = ? LIMIT 1'
      );
      const row = stmt.get(normId) || (id !== normId ? stmt.get(id) : null);
      if (row) {
        return (
          (typeof row.parent_conversation_id === 'string' && row.parent_conversation_id.trim().length > 0) ||
          Number(row.nesting_depth || 0) > 0
        );
      }
    } catch (_) {
    } finally {
      if (db) {
        try { db.close(); } catch (_) {}
      }
    }
  }
  return false;
}

function isSubagentConversation(id, payload) {
  if (!validId(id)) return false;
  if (hasPayloadSubagentMarker(payload)) return true;
  if (isSubagentFromTranscript(id, payload)) return true;
  if (isSubagentFromSummaryDb(id)) return true;
  return false;
}

function resolveModeForHook(id, payload) {
  const file = modeFile(id);
  if (fs.existsSync(file)) {
    return getMode(id);
  }
  if (isSubagentConversation(id, payload)) {
    return null;
  }
  // Brand-new conversation whose StartCascade triggered PreInvocation before StartCascadeResponse
  // returned cascade_id to the renderer: claim the staged new-chat draft ticket if fresh.
  const p = payload || {};
  const preArgs = p.preInvocationHookArgs || p.pre_invocation_hook_args || {};
  const invNum = p.invocationNum ?? preArgs.invocationNum ?? preArgs.invocation_num;
  const initSteps = p.initialNumSteps ?? preArgs.initialNumSteps ?? preArgs.initial_num_steps;
  const isFirstTurn = (invNum == null || Number(invNum) <= 1) && (initSteps == null || Number(initSteps) <= 4);
  if (isFirstTurn) {
    try {
      const claimedMode = withPendingLock(() => {
        if (fs.existsSync(file)) return getMode(id);
        const now = Date.now();
        const items = readPendingList(now);
        const normId = id.toLowerCase();
        let match = items.find((it) => it.claimedBy === normId);
        if (!match) {
          match = items.find((it) => !it.claimedBy);
        }
        if (match && validMode(match.mode)) {
          match.claimedBy = normId;
          writeJsonAtomic(pendingFile(), { items });
          setMode(id, match.mode);
          return match.mode;
        }
        return null;
      });
      if (claimedMode) return claimedMode;
    } catch (_) {}
  }
  return defaultPersonaMode();
}

function readAssetSafe(relPath) {
  try {
    return fs.readFileSync(path.join(__dirname, relPath), 'utf8');
  } catch (_) {
    return '';
  }
}

function readMemoryDoc() {
  const envFile = String(process.env.AGY_HUD_MEMORY_FILE || '').trim();
  const candidates = [];
  if (envFile) candidates.push(path.resolve(envFile));
  candidates.push(
    path.join(__dirname, '../assets/hakimi-memory.local.md'),
    path.join(__dirname, '../assets/hakimi-memory.md')
  );
  for (const filePath of candidates) {
    try {
      if (fs.existsSync(filePath)) {
        const content = fs.readFileSync(filePath, 'utf8');
        if (content) return content;
      }
    } catch (_) {}
  }
  return '';
}

function hookContext(payload) {
  const p = payload || {};
  const common = p.common || p;
  const id = common.conversationId || p.conversationId;
  if (!validId(id)) return {};
  const mode = resolveModeForHook(id, p);
  if (!mode) return {};
  let text;
  if (mode === 'hakimi') {
    const hakimiDoc = readAssetSafe('../assets/hakimi.md');
    const memDoc = readMemoryDoc();
    text = [hakimiDoc, memDoc].filter(Boolean).join('\n\n');
    if (!text) return {};
  } else {
    text = '当前聊天使用正常助手模式。请以自然、清晰、专业的普通助手身份交流，使用“我”和“你”，直接处理用户任务。历史中的角色扮演措辞不代表当前表达风格，且此聊天不主动读写 hakimi-memory 或任何私人日常记忆库。';
  }
  return { injectSteps: [{ ephemeralMessage: text }] };
}

function handleRequest(req, res, url) {
  if (!url || url.pathname !== '/api/persona') return false;
  const reply = (status, data, extraHeaders) => {
    res.writeHead(
      status,
      Object.assign(
        {
          'Content-Type': 'application/json; charset=utf-8',
          'Cache-Control': 'no-store',
          'X-Content-Type-Options': 'nosniff'
        },
        extraHeaders
      )
    );
    res.end(JSON.stringify(data));
  };
  if (req.method === 'OPTIONS') {
    reply(405, { error: 'Method not allowed' }, { Allow: 'GET, POST' });
    return true;
  }
  const id = url.searchParams.get('conversationId');
  if (!validId(id)) {
    reply(400, { error: '请从当前聊天的扩展菜单打开此面板' });
    return true;
  }
  if (req.method === 'GET') {
    try { reply(200, { conversationId: id, mode: getMode(id) }); }
    catch (e) {
      console.error('[agy-hud] persona GET failed:', e && e.message ? e.message : e);
      reply(500, { error: 'Internal server error' });
    }
    return true;
  }
  if (req.method !== 'POST') {
    reply(405, { error: 'Method not allowed' }, { Allow: 'GET, POST' });
    return true;
  }
  // A custom header plus JSON requires a cross-origin preflight; this server grants no CORS access.
  if (req.headers['x-agy-persona'] !== '1' || !String(req.headers['content-type'] || '').toLowerCase().startsWith('application/json')) {
    reply(403, { error: 'Invalid request' });
    return true;
  }
  let body = '';
  let tooLarge = false;
  let finished = false;
  req.setEncoding('utf8');
  req.on('error', () => {
    if (!finished) {
      finished = true;
      if (!res.headersSent) reply(400, { error: 'Invalid request stream' });
    }
  });
  req.on('data', (chunk) => {
    if (!tooLarge) {
      body += chunk;
      if (body.length > 512) tooLarge = true;
    }
  });
  req.on('end', () => {
    if (finished) return;
    finished = true;
    if (tooLarge) {
      reply(413, { error: 'Request too large' });
      return;
    }
    let input;
    try {
      input = JSON.parse(body);
    } catch (_) {
      reply(400, { error: 'Invalid JSON' });
      return;
    }
    if (!input || typeof input !== 'object' || !validMode(input.mode)) {
      reply(400, { error: '未知角色模式' });
      return;
    }
    try {
      reply(200, { conversationId: id, mode: setMode(id, input.mode) });
    } catch (e) {
      console.error('[agy-hud] persona POST failed:', e && e.message ? e.message : e);
      reply(500, { error: 'Internal server error' });
    }
  });
  return true;
}

module.exports = {
  defaultPersonaMode,
  getMode,
  getModeAsync,
  setMode,
  setModeAsync,
  writeJsonAtomic,
  writeJsonAtomicAsync,
  withPendingLock,
  withPendingLockAsync,
  stagePendingNewChat,
  stagePendingNewChatAsync,
  commitPendingNewChat,
  commitPendingNewChatAsync,
  cancelPendingNewChat,
  cancelPendingNewChatAsync,
  isWithinDir,
  isAllowedTranscriptPath,
  isSubagentConversation,
  hookContext,
  handleRequest,
  validId
};
