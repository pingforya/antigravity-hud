'use strict';

/**
 * Antigravity HUD Lifecycle Hook (Silent Millisecond Timing Logger)
 *
 * - Appends ONE small timing record per event to
 *   ~/.gemini/antigravity/sidecar_data/agy-hud/telemetry/data/timing_<conversationId>.jsonl
 * - Never makes a permission decision: it is registered only for PreInvocation /
 *   PostInvocation / Stop (NOT PreToolUse or PostToolUse) and emits persona context only on PreInvocation,
 *   so the user's normal tool-approval flow is untouched and tool calls are not slowed down.
 * - Does no transcript parsing and writes no conversation content to disk; the HUD /
 *   sidecar parse transcripts on demand (with caching).
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const personaMode = require('./persona-mode.cjs');

const MAX_TIMING_FILE_BYTES = 1024 * 1024; // rotate when > 1 MB
const KEEP_TIMING_LINES = 4000;
const MAX_TIMING_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const MAX_TIMING_FILES = 30;
const MAX_STDIN_BYTES = 256 * 1024;
const SLEEP_I32 = typeof SharedArrayBuffer === 'function' ? new Int32Array(new SharedArrayBuffer(4)) : null;

function sleepBackoffSync(ms) {
  if (SLEEP_I32 && ms > 0) {
    try {
      Atomics.wait(SLEEP_I32, 0, 0, ms);
    } catch (_) {}
  }
}

function getDataDir() {
  if (process.env.AGY_HUD_DATA_DIR) return process.env.AGY_HUD_DATA_DIR;
  return path.join(os.homedir(), '.gemini', 'antigravity', 'sidecar_data', 'agy-hud', 'telemetry', 'data');
}

function rotateIfNeeded(file) {
  try {
    const st = fs.statSync(file);
    if (st.size <= MAX_TIMING_FILE_BYTES) return;
    const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
    const kept = lines.slice(-KEEP_TIMING_LINES).join('\n') + '\n';
    const tmp = `${file}.tmp-${process.pid}-${crypto.randomUUID()}`;
    try {
      fs.writeFileSync(tmp, kept, 'utf8');
      for (let attempt = 0; attempt < 4; attempt++) {
        try {
          fs.renameSync(tmp, file);
          break;
        } catch (err) {
          if (err && (err.code === 'EPERM' || err.code === 'EACCES' || err.code === 'EBUSY') && attempt < 3) {
            sleepBackoffSync(5 * (attempt + 1));
            continue;
          }
          throw err;
        }
      }
    } finally {
      if (fs.existsSync(tmp)) {
        try { fs.unlinkSync(tmp); } catch (_) {}
      }
    }
  } catch (_) {}
}

function pruneOldTimingFiles(dataDir = getDataDir(), options = {}) {
  const maxAgeMs = typeof options.maxAgeMs === 'number' ? options.maxAgeMs : MAX_TIMING_AGE_MS;
  const maxFiles = typeof options.maxFiles === 'number' ? options.maxFiles : MAX_TIMING_FILES;
  const activeConvId = options.activeConvId || '';
  const activeFile = activeConvId ? `timing_${activeConvId}.jsonl` : '';
  const now = Date.now();
  let removed = 0;

  try {
    if (!fs.existsSync(dataDir)) return 0;
    const timingEntries = [];
    for (const name of fs.readdirSync(dataDir)) {
      const fullPath = path.join(dataDir, name);
      if (/\.tmp(-[0-9a-z-]+)?$/i.test(name) || /^pending_new_chats\.lock\.stale-/i.test(name)) {
        // Leave fresh temp/stale-lock files alone: another hook or IPC process may be mid-write.
        try {
          if (now - fs.statSync(fullPath).mtimeMs > 60 * 1000) {
            fs.rmSync(fullPath, { force: true });
            removed++;
          }
        } catch (_) {}
        continue;
      }
      if (name === 'pending_new_chats.lock') {
        try {
          const st = fs.statSync(fullPath);
          if (now - st.mtimeMs > 60 * 1000) {
            const stConfirm = fs.statSync(fullPath);
            if (stConfirm.mtimeMs === st.mtimeMs && now - stConfirm.mtimeMs > 60 * 1000) {
              const stalePath = `${fullPath}.stale-${process.pid}-${now}`;
              fs.renameSync(fullPath, stalePath);
              try { fs.unlinkSync(stalePath); } catch (_) {}
              removed++;
            }
          }
        } catch (_) {}
        continue;
      }
      if (!/^timing_[0-9a-f-]{36}\.jsonl$/i.test(name)) continue;
      if (name === activeFile) continue;
      try {
        const st = fs.statSync(fullPath);
        if (now - st.mtimeMs > maxAgeMs) {
          fs.rmSync(fullPath, { force: true });
          removed++;
        } else {
          timingEntries.push({ fullPath, mtimeMs: st.mtimeMs });
        }
      } catch (_) {}
    }
    if (timingEntries.length > maxFiles) {
      timingEntries.sort((a, b) => b.mtimeMs - a.mtimeMs);
      for (const old of timingEntries.slice(maxFiles)) {
        try { fs.rmSync(old.fullPath, { force: true }); removed++; } catch (_) {}
      }
    }
  } catch (_) {}
  return removed;
}

function handleHook(eventType, payload) {
  payload = payload || {};
  const nowMs = Date.now();
  const common = payload.common || payload;
  const convId = common.conversationId || payload.conversationId || '';
  const modelName = common.modelName || payload.modelName || '';

  if (convId && /^[0-9a-f-]{36}$/i.test(convId)) {
    try {
      const dataDir = getDataDir();
      fs.mkdirSync(dataDir, { recursive: true });
      const timingFile = path.join(dataDir, `timing_${convId}.jsonl`);
      const record = {
        event: eventType,
        tsMs: nowMs,
        stepIdx: payload.stepIdx ?? payload.invocationNum ?? null,
        modelName: modelName || undefined,
        toolName: (payload.toolCall && payload.toolCall.name) || undefined,
        terminationReason: payload.terminationReason || undefined
      };
      fs.appendFileSync(timingFile, JSON.stringify(record) + '\n', 'utf8');
      rotateIfNeeded(timingFile);
      if (eventType === 'Stop' || eventType === 'PostInvocation') {
        pruneOldTimingFiles(dataDir, { activeConvId: convId });
      }
    } catch (_) {}
  }

  // Persona is transient per invocation; never alter permission decisions.
  if(eventType === 'PreInvocation') {
    try { return personaMode.hookContext(payload); }
    catch(error) { console.error('[agy-hud] persona:', error.message); }
  }
  return {};
}

if (require.main === module) {
  const eventType = process.argv[2] || 'PostInvocation';
  let input = '';
  let inputBytes = 0;
  let overflow = false;
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => {
    if (overflow) return;
    inputBytes += Buffer.byteLength(chunk, 'utf8');
    if (inputBytes > MAX_STDIN_BYTES) {
      overflow = true;
      input = '';
      return;
    }
    input += chunk;
  });
  process.stdin.on('end', () => {
    let result = {};
    if (!overflow) {
      try {
        const payload = input.trim() ? JSON.parse(input) : {};
        result = handleHook(eventType, payload);
      } catch (_) {}
    }
    process.stdout.write(JSON.stringify(result));
  });
}

module.exports = { handleHook, rotateIfNeeded, pruneOldTimingFiles };
