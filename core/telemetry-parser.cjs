'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

let DatabaseSync = null;
try {
  ({ DatabaseSync } = require('node:sqlite'));
} catch (_) {}

const DEFAULT_CONTEXT_LIMIT = 256000;
const PATCHED_DEFAULT_CONTEXT_LIMIT = 512000;
const ACCEPTED_PATCH_LIMITS = [512000, 734000, 900000, 983040];
const PRODUCT_DIRS = ['antigravity', 'antigravity-cli', 'antigravity-ide'];

/**
 * Map internal Antigravity placeholder enums (logged in some USER_INPUT model-switch lines)
 * to their human-readable model display names.
 */
const MODEL_PLACEHOLDER_NAMES = {
  MODEL_PLACEHOLDER_M400: 'Claude Opus 5.5 (Low)',
  MODEL_PLACEHOLDER_M401: 'Claude Opus 5.5 (Medium)',
  MODEL_PLACEHOLDER_M402: 'Claude Opus 5.5 (High)',
  MODEL_PLACEHOLDER_M406: 'Claude Opus 5.5 (Max)',
  MODEL_PLACEHOLDER_M368: 'Claude Opus 5.5',
  MODEL_PLACEHOLDER_M403: 'Claude Sonnet 5.5 (Low)',
  MODEL_PLACEHOLDER_M404: 'Claude Sonnet 5.5 (Medium)',
  MODEL_PLACEHOLDER_M405: 'Claude Sonnet 5.5 (High)',
  MODEL_PLACEHOLDER_M407: 'Claude Sonnet 5.5 (Max)',
  MODEL_PLACEHOLDER_M254: 'Claude Opus 4.8',
  MODEL_PLACEHOLDER_M26: 'Claude Opus 4.6 (Thinking)',
  MODEL_PLACEHOLDER_M35: 'Claude Sonnet 4.6',
  MODEL_PLACEHOLDER_M11: 'Claude Opus 4.5',
  MODEL_PLACEHOLDER_M12: 'Claude Opus 4.5 (Thinking)',
  MODEL_PLACEHOLDER_M417: 'Gemini 4 Argon (High)',
  MODEL_PLACEHOLDER_M418: 'Gemini 4 Argon (Medium)',
  MODEL_PLACEHOLDER_M419: 'Gemini 4 Argon (Low)',
  MODEL_PLACEHOLDER_M36: 'Gemini 3.1 Pro (Low)',
  MODEL_PLACEHOLDER_M37: 'Gemini 3.1 Pro (High)',
  MODEL_PLACEHOLDER_M16: 'Gemini 3.1 Pro (High)',
  MODEL_PLACEHOLDER_M198: 'Gemini 3.5 Flash Lite',
  MODEL_PLACEHOLDER_M71: 'Gemini 3.6 Flash (High)',
  MODEL_PLACEHOLDER_M72: 'Gemini 3.6 Flash (Medium)',
  MODEL_PLACEHOLDER_M73: 'Gemini 3.6 Flash (Low)',
  MODEL_PLACEHOLDER_M298: 'Gemini 3.7 Flash (High)',
  MODEL_PLACEHOLDER_M299: 'Gemini 3.7 Flash (Medium)',
  MODEL_PLACEHOLDER_M300: 'Gemini 3.7 Flash (Low)',
  MODEL_PLACEHOLDER_M318: 'Gemini 3.8 Flash (High)',
  MODEL_PLACEHOLDER_M319: 'Gemini 3.8 Flash (Medium)',
  MODEL_PLACEHOLDER_M320: 'Gemini 3.8 Flash (Low)',
  MODEL_PLACEHOLDER_M322: 'Gemini 3.8 Flash',
  MODEL_OPENAI_GPT_OSS_120B_MEDIUM: 'GPT-OSS 120B (Medium)'
};

const MODEL_SLUG_NAMES = {
  'claude-opus-5-5-low': 'Claude Opus 5.5 (Low)',
  'claude-opus-5-5-medium': 'Claude Opus 5.5 (Medium)',
  'claude-opus-5-5-high': 'Claude Opus 5.5 (High)',
  'claude-opus-5-5-max': 'Claude Opus 5.5 (Max)',
  'claude-opus-5-5': 'Claude Opus 5.5',
  'claude-sonnet-5-5-low': 'Claude Sonnet 5.5 (Low)',
  'claude-sonnet-5-5-medium': 'Claude Sonnet 5.5 (Medium)',
  'claude-sonnet-5-5-high': 'Claude Sonnet 5.5 (High)',
  'claude-sonnet-5-5-max': 'Claude Sonnet 5.5 (Max)',
  'claude-opus-4-8': 'Claude Opus 4.8',
  'claude-opus-4-6-thinking': 'Claude Opus 4.6 (Thinking)',
  'claude-sonnet-4-6': 'Claude Sonnet 4.6',
  'claude-opus-4-5': 'Claude Opus 4.5',
  'claude-opus-4-5-thinking': 'Claude Opus 4.5 (Thinking)',
  'gemini-4-argon': 'Gemini 4 Argon',
  'gemini-4-argon-b': 'Gemini 4 Argon (High)',
  'gemini-4-argon-high': 'Gemini 4 Argon (High)',
  'gemini-4-argon-medium': 'Gemini 4 Argon (Medium)',
  'gemini-4-argon-low': 'Gemini 4 Argon (Low)',
  'gemini-4-carbon': 'Gemini 4 Carbon',
  'gemini-4-carbon-high': 'Gemini 4 Carbon (High)',
  'gemini-4-carbon-medium': 'Gemini 4 Carbon (Medium)',
  'gemini-4-carbon-low': 'Gemini 4 Carbon (Low)',
  'gemini-3.1-pro-low': 'Gemini 3.1 Pro (Low)',
  'gemini-3.1-pro-low-thinking': 'Gemini 3.1 Pro (Low)',
  'gemini-3.1-pro-high': 'Gemini 3.1 Pro (High)',
  'gemini-3.1-pro-high-thinking': 'Gemini 3.1 Pro (High)',
  'gemini-pro-agent': 'Gemini 3.1 Pro (High)',
  'gemini-3.5-flash-lite': 'Gemini 3.5 Flash Lite',
  'gemini-3.8-flash': 'Gemini 3.8 Flash',
  'gemini-3.8-flash-n': 'Gemini 3.8 Flash (High)',
  'gemini-3.8-flash-tiered': 'Gemini 3.8 Flash',
  'gemini-3.8-flash-low': 'Gemini 3.8 Flash (Low)',
  'gemini-3.8-flash-medium': 'Gemini 3.8 Flash (Medium)',
  'gemini-3.8-flash-high': 'Gemini 3.8 Flash (High)',
  'gpt-oss-120b-medium': 'GPT-OSS 120B (Medium)'
};

/**
 * Per-model effective context limits (`max_context_tokens` auto-compaction threshold
 * in Antigravity's CortexStepGeneratorMetadata.ChatStartMetadata.ContextWindowMetadata).
 */
const MODEL_CONTEXT_LIMIT_RULES = [
  // Claude Opus 5.5 / Sonnet 5.5 / Opus 4.8: 1M raw context, 128k max output -> 840k auto-compaction limit
  {
    pattern: /claude-(?:opus|sonnet)-5[-.]5|claude\s+(?:opus|sonnet)\s+5\.5|claude-opus-4[-.]8|claude\s+opus\s+4\.8|model_placeholder_m(?:368|40[0-7]|254)\b/i,
    limit: 840000
  },
  // Claude 4 / 4.5 / 4.6 (Opus, Sonnet, Haiku): 200k window -> 160k auto-compaction limit
  {
    pattern: /claude-(?:opus|sonnet|haiku)-4(?:[-.](?:5|6))?|claude\s+(?:opus|sonnet|haiku)\s+4(?:\.(?:5|6))?|model_placeholder_m(?:11|12|26|35)\b/i,
    limit: 160000
  },
  // Gemini 3.1 Pro (Low) & Gemini 3.5 Flash Lite: 128k auto-compaction limit
  {
    pattern: /gemini-3\.1-pro-low|gemini\s+3\.1\s+pro(?:\s*\(low\)|\s*$)|gemini-3\.5-flash-lite|gemini\s+3\.5\s+flash\s+lite|model_placeholder_m(?:36|198)\b/i,
    limit: 128000
  },
  // Gemini 4 Argon/Carbon, Gemini 3.5-3.8 Flash, Gemini 3.1 Pro (High)/Flash, Gemini 3 Pro/Flash, Gemini 2.5: 256k auto-compaction limit
  {
    pattern: /gemini-4-(?:argon|carbon)|gemini\s+4\s+(?:argon|carbon)|gemini-3\.[5-8]-flash|gemini\s+3\.[5-8]\s+flash|gemini-3\.1-(?:pro|flash)|gemini\s+3\.1\s+(?:pro|flash)|gemini-3-(?:pro|flash)|gemini\s+3\s+(?:pro|flash)|gemini-2\.5|gemini\s+2\.5|model_placeholder_m(?:41[7-9]|16|37|7[1-3]|29[89]|300|31[89]|32[02])\b/i,
    limit: 256000
  }
];

function normalizeModelName(modelName) {
  if (typeof modelName !== 'string') return '';
  const trimmed = modelName.trim();
  if (!trimmed) return '';
  return MODEL_PLACEHOLDER_NAMES[trimmed.toUpperCase()] || MODEL_SLUG_NAMES[trimmed.toLowerCase()] || trimmed;
}

function getModelVisualMeta(modelName) {
  const normalized = normalizeModelName(modelName) || 'Gemini';
  let family = 'other';
  let color = '#38bdf8';
  if (/orchestrator/i.test(normalized)) {
    family = 'orchestrator';
    color = '#818cf8';
  } else if (/claude\s+opus/i.test(normalized)) {
    family = 'claude-opus';
    color = '#f59e0b';
  } else if (/claude\s+sonnet/i.test(normalized)) {
    family = 'claude-sonnet';
    color = '#f97316';
  } else if (/carbon/i.test(normalized)) {
    family = 'gemini-carbon';
    color = '#38bdf8';
  } else if (/gemini\s+4\s+argon/i.test(normalized)) {
    family = 'gemini-argon';
    color = '#38bdf8';
  } else if (/gemini\s+3\.1\s+pro/i.test(normalized)) {
    family = 'gemini-pro';
    color = '#60a5fa';
  } else if (/gemini.*flash/i.test(normalized)) {
    family = 'gemini-flash';
    color = '#34d399';
  }

  let shortLabel = normalized;
  const claudeMatch = normalized.match(/^Claude\s+(Opus|Sonnet|Haiku)\s+([0-9.]+)(?:\s*\(([^)]+)\))?$/i);
  const argonMatch = normalized.match(/^Gemini\s+4\s+Argon(?:\s*\(([^)]+)\))?$/i);
  const geminiMatch = normalized.match(/^Gemini\s+([0-9.]+)\s+(Pro|Flash(?:\s+Lite)?)(?:\s*\(([^)]+)\))?$/i);

  if (/orchestrator/i.test(normalized)) {
    shortLabel = 'Orchestrator';
  } else if (/carbon/i.test(normalized)) {
    shortLabel = 'Carbon';
  } else if (claudeMatch) {
    const tier = (claudeMatch[3] || '').trim();
    const base = `${claudeMatch[1]} ${claudeMatch[2]}`;
    if (!tier || /^medium$/i.test(tier) || /^thinking$/i.test(tier)) {
      shortLabel = base;
    } else {
      shortLabel = `${base} (${tier})`;
    }
  } else if (argonMatch) {
    const tier = (argonMatch[1] || '').trim();
    if (!tier || /^high$/i.test(tier)) {
      shortLabel = 'Argon';
    } else if (/^medium$/i.test(tier)) {
      shortLabel = 'Argon (Med)';
    } else {
      shortLabel = `Argon (${tier})`;
    }
  } else if (geminiMatch) {
    const base = `${geminiMatch[1]} ${geminiMatch[2]}`;
    const tier = (geminiMatch[3] || '').trim();
    if (!tier || /^high$/i.test(tier)) {
      shortLabel = base;
    } else if (/^medium$/i.test(tier)) {
      shortLabel = `${base} (Med)`;
    } else {
      shortLabel = `${base} (${tier})`;
    }
  } else {
    shortLabel = normalized
      .replace(/\s*\(Medium\)$/i, ' (Med)')
      .replace(/\s*\(Thinking\)$/i, '');
  }

  return {
    modelName: normalized,
    shortLabel,
    family,
    color
  };
}

function toLocalDateKey(tsMs) {
  let d;
  if (tsMs instanceof Date) {
    d = tsMs;
  } else if (typeof tsMs === 'number' && Number.isFinite(tsMs) && tsMs > 0) {
    d = new Date(tsMs);
  } else if (typeof tsMs === 'string' && tsMs.trim()) {
    const parsed = Date.parse(tsMs);
    d = !Number.isNaN(parsed) ? new Date(parsed) : new Date();
  } else {
    d = new Date();
  }
  if (Number.isNaN(d.getTime())) d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function getModelContextLimit(modelName) {
  if (typeof modelName !== 'string' || !modelName.trim()) {
    return DEFAULT_CONTEXT_LIMIT;
  }
  const normalized = normalizeModelName(modelName);
  for (const rule of MODEL_CONTEXT_LIMIT_RULES) {
    if (rule.pattern.test(normalized) || rule.pattern.test(modelName)) {
      return rule.limit;
    }
  }
  return DEFAULT_CONTEXT_LIMIT;
}

function getBrainDirs(customHome) {
  if (process.env.AGY_BRAIN_DIR && !customHome) return [process.env.AGY_BRAIN_DIR];
  const home = customHome || os.homedir();
  return PRODUCT_DIRS.map(p => path.join(home, '.gemini', p, 'brain'));
}

function getBrainDir(customHome) {
  return getBrainDirs(customHome)[0];
}

function getTelemetryDataDir(customHome) {
  if (process.env.AGY_HUD_DATA_DIR && !customHome) return process.env.AGY_HUD_DATA_DIR;
  const home = customHome || os.homedir();
  return path.join(home, '.gemini', 'antigravity', 'sidecar_data', 'agy-hud', 'telemetry', 'data');
}

function decodeArg(val) {
  if (typeof val !== 'string') return val;
  const trimmed = val.trim();
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith('{') && trimmed.endsWith('}'))) {
    try { return JSON.parse(trimmed); } catch (_) {}
  }
  return val;
}

function summarizeToolCall(tc) {
  if (!tc || !tc.name) return 'unknown_tool';
  const name = tc.name;
  const args = tc.args || {};
  if (name === 'read_file' || name === 'write_file' || name === 'edit_file' || name === 'view_file') {
    const p = String(decodeArg(args.Path || args.TargetFile || args.FilePath || '') || '');
    const base = p ? path.basename(p.replace(/\\/g, '/')) : '';
    return base ? `${name}(${base})` : name;
  }
  if (name === 'run_command') {
    const cmd = String(decodeArg(args.toolSummary || args.CommandLine || '') || '').trim();
    const shortCmd = cmd.length > 32 ? cmd.slice(0, 32) + '...' : cmd;
    return shortCmd ? `run_command(${shortCmd})` : 'run_command';
  }
  if (name === 'invoke_subagent') {
    const role = String(decodeArg(args.Role || args.TypeName || '') || '').trim();
    return role ? `subagent(${role})` : 'invoke_subagent';
  }
  return name;
}

function extractCreatedAtFromContent(content) {
  if (typeof content !== 'string') return null;
  const m = content.match(/Created At:\s*([0-9T:\-+.]+\b)/);
  if (m) {
    const ms = Date.parse(m[1]);
    if (!Number.isNaN(ms)) return ms;
  }
  return null;
}

function extractCompletedAtFromContent(content) {
  if (typeof content !== 'string') return null;
  const m = content.match(/Completed At:\s*([0-9T:\-+.]+\b)/);
  if (m) {
    const ms = Date.parse(m[1]);
    if (!Number.isNaN(ms)) return ms;
  }
  return null;
}

// --- Parse result cache -------------------------------------------------------
// The transcript is re-requested every ~1.5s by the in-app HUD (Electron main process)
// and by the sidecar. Re-parsing is only needed when the transcript or timing file
// actually changed, so results are memoised on (path, size, mtime).
const CACHE_MAX_ENTRIES = 64;
const BINARY_HASH_CACHE_MAX = 64;
const DAILY_CONV_CACHE_MAX = 4096;
const SUMMARIES_CACHE_MAX = 32;
const parseCache = new Map();
const binaryHashCache = new Map();
const dailyConvCache = new Map();
const summariesCache = new Map();
let dailyUsageMemo = null;

function lruGet(map, key, sig) {
  const hit = map.get(key);
  if (!hit || hit.sig !== sig) return null;
  map.delete(key);
  map.set(key, hit);
  return hit;
}

function lruSet(map, key, entry, maxEntries) {
  map.delete(key);
  map.set(key, entry);
  while (map.size > maxEntries) {
    map.delete(map.keys().next().value);
  }
}

function estimateTokensFromChars(chars) {
  if (!chars || chars <= 0) return 0;
  return Math.max(12, Math.round(chars / 3.2));
}

function parseJsonlSteps(rawText) {
  const rawSteps = [];
  if (!rawText) return rawSteps;
  for (const line of rawText.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      rawSteps.push(JSON.parse(trimmed));
    } catch (_) {}
  }
  return rawSteps;
}

function readTimingEvents(timingFile, hasTimingStat) {
  const hookTimings = [];
  if (!hasTimingStat || !timingFile) return hookTimings;
  try {
    const tLines = fs.readFileSync(timingFile, 'utf8').split('\n');
    for (const tl of tLines) {
      if (!tl.trim()) continue;
      try {
        const ev = JSON.parse(tl);
        if (typeof ev.tsMs === 'number') hookTimings.push(ev);
      } catch (_) {}
    }
  } catch (_) {}
  hookTimings.sort((a, b) => a.tsMs - b.tsMs);
  return hookTimings;
}

function statSig(file) {
  try {
    const st = fs.statSync(file);
    return { sig: `${st.size}:${st.mtimeMs}`, stat: st };
  } catch (_) {
    return { sig: 'missing', stat: null };
  }
}

function readVarint(buf, p) {
  let v = 0n;
  for (let i = 0; i < 10; i++) {
    if (p >= buf.length) throw new Error('Truncated protobuf varint');
    const x = buf[p++];
    if (i === 9 && x > 1) throw new Error('Protobuf varint exceeds uint64');
    v |= BigInt(x & 127) << BigInt(i * 7);
    if (x < 128) return [Number(v), p];
  }
  throw new Error('Invalid protobuf varint');
}

function iterFields(buf) {
  const fields = [];
  let p = 0;
  while (p < buf.length) {
    const [t, nextP] = readVarint(buf, p);
    p = nextP;
    const fieldNum = Math.floor(t / 8);
    if (fieldNum < 1 || fieldNum > 0x1FFFFFFF) throw new Error('Invalid protobuf field number');
    const w = t & 7;
    let v;
    if (w === 0) {
      [v, p] = readVarint(buf, p);
    } else if (w === 2) {
      let n;
      [n, p] = readVarint(buf, p);
      if (n > buf.length - p) throw new Error('Truncated protobuf length-delimited field');
      v = buf.subarray(p, p + n);
      p += n;
    } else if (w === 1 || w === 5) {
      const n = w === 1 ? 8 : 4;
      if (n > buf.length - p) throw new Error('Truncated protobuf fixed-width field');
      v = buf.subarray(p, p + n);
      p += n;
    } else {
      throw new Error(`Unsupported wire type: ${w}`);
    }
    fields.push([fieldNum, w, v]);
  }
  return fields;
}

function getField(buf, k, wire = 2) {
  const fields = iterFields(buf);
  const values = fields.filter(([f]) => f === k);
  if (values.length === 0) throw new Error(`Missing protobuf field ${k}`);
  if (values.some(([, w]) => w !== wire)) throw new Error(`Unexpected wire type for protobuf field ${k}`);
  return values[values.length - 1][2];
}

function parseGenUsage(raw) {
  const buf = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
  const chat = getField(buf, 1, 2);
  const chatFields = iterFields(chat);
  const windowParents = chatFields.filter(([f]) => f === 9);
  if (windowParents.length === 0) throw new Error('Missing protobuf field 9');
  if (windowParents.some(([, w]) => w !== 2)) throw new Error('Unexpected wire type for protobuf field 9');
  const windowBuf = getField(windowParents[windowParents.length - 1][2], 10, 2);
  const genLimit = getField(windowBuf, 4, 0);
  const winFields = iterFields(windowBuf);
  const usedVals = winFields.filter(([f]) => f === 1);
  if (usedVals.some(([, w]) => w !== 0)) throw new Error('Unexpected wire type for protobuf field 1');
  const genUsed = usedVals.length > 0 ? usedVals[usedVals.length - 1][2] : null;
  const modelIdVals = chatFields.filter(([f]) => f === 3);
  if (modelIdVals.some(([, w]) => w !== 0)) throw new Error('Unexpected wire type for protobuf field 3');
  const modelNameVals = chatFields.filter(([f]) => f === 19);
  if (modelNameVals.some(([, w]) => w !== 2)) throw new Error('Unexpected wire type for protobuf field 19');
  return {
    genMaxContextTokens: genLimit,
    genUsedTokens: genUsed,
    modelId: modelIdVals.length > 0 ? modelIdVals[modelIdVals.length - 1][2] : null,
    modelName: modelNameVals.length > 0 ? modelNameVals[modelNameVals.length - 1][2].toString('utf8') : null
  };
}

function parseExecRow(raw) {
  const buf = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
  return getField(getField(getField(buf, 10, 2), 2, 2), 5, 0);
}

function findConversationDbPath(conversationId, options = {}) {
  if (!conversationId || !/^[0-9a-f-]{36}$/i.test(conversationId)) return null;
  const dirs = [];
  const customBrainDir = options.brainDir || process.env.AGY_BRAIN_DIR;
  if (options.conversationsDir) {
    dirs.push(options.conversationsDir);
  } else if (customBrainDir && !options.homedir) {
    dirs.push(path.join(path.dirname(customBrainDir), 'conversations'));
  } else {
    const home = options.homedir || os.homedir();
    for (const p of PRODUCT_DIRS) {
      dirs.push(path.join(home, '.gemini', p, 'conversations'));
    }
  }
  for (const d of dirs) {
    const cand = path.join(d, `${conversationId}.db`);
    if (fs.existsSync(cand)) return cand;
  }
  return null;
}

function isSqliteBusyError(err) {
  return Boolean(err && /busy|locked/i.test(String(err.message || err)));
}

/**
 * Open a SQLite database in read-only mode with a 250ms busy timeout so concurrent
 * WAL checkpoints/flushes from Antigravity's language_server do not fail immediately
 * with SQLITE_BUSY. Falls back cleanly on older Node 22.5 builds without `timeout`.
 */
function openReadOnlyDb(dbPath) {
  if (!DatabaseSync) return null;
  try {
    return new DatabaseSync(dbPath, { readOnly: true, timeout: 250 });
  } catch (err) {
    if (
      err &&
      (err instanceof TypeError ||
        err.code === 'ERR_INVALID_ARG_TYPE' ||
        err.code === 'ERR_INVALID_ARG_VALUE' ||
        /timeout|option/i.test(String(err.message || '')))
    ) {
      const db = new DatabaseSync(dbPath, { readOnly: true });
      try { db.exec('PRAGMA busy_timeout = 250'); } catch (_) {}
      return db;
    }
    throw err;
  }
}

function inspectSessionDbInternal(conversationId, options = {}) {
  if (!DatabaseSync) return { meta: null, dbBusy: false };
  const dbPath = options.dbPath || findConversationDbPath(conversationId, options);
  if (!dbPath || !fs.existsSync(dbPath)) return { meta: null, dbBusy: false };
  let db = null;
  let dbBusy = false;
  try {
    db = openReadOnlyDb(dbPath);
    const gRow = db.prepare('SELECT idx, data FROM gen_metadata ORDER BY idx DESC LIMIT 1').get();
    if (!gRow || !gRow.data) return { meta: null, dbBusy: false };
    const genInfo = parseGenUsage(gRow.data);
    let execLimit = null;
    let execIdx = null;
    try {
      const eRow = db.prepare('SELECT idx, data FROM executor_metadata ORDER BY idx DESC LIMIT 1').get();
      if (eRow && eRow.data) {
        execIdx = Number(eRow.idx);
        execLimit = parseExecRow(eRow.data);
      }
    } catch (execErr) {
      if (isSqliteBusyError(execErr)) dbBusy = true;
    }

    const genLim = genInfo.genMaxContextTokens;
    const gIdx = Number(gRow.idx);
    const sameTurnExec = execLimit !== null && execIdx !== null && execIdx >= gIdx;
    let state = 'OTHER_WINDOW';
    if (
      (ACCEPTED_PATCH_LIMITS.includes(genLim) || (genLim > DEFAULT_CONTEXT_LIMIT && genLim <= 1048576)) &&
      (!sameTurnExec || execLimit > DEFAULT_CONTEXT_LIMIT)
    ) {
      state = 'EXPECTED_WINDOW';
    } else if (genLim === DEFAULT_CONTEXT_LIMIT && (!sameTurnExec || execLimit === DEFAULT_CONTEXT_LIMIT)) {
      state = 'LIMITED_256K';
    } else if (sameTurnExec && genLim !== execLimit) {
      state = 'MIXED_LIMITS';
    }

    return {
      meta: {
        dbPath,
        genIdx: Number(gRow.idx),
        genMaxContextTokens: genLim,
        genUsedTokens: genInfo.genUsedTokens,
        executorIdx: execIdx,
        executorMaxTokenLimit: execLimit,
        modelId: genInfo.modelId,
        modelName: genInfo.modelName || null,
        state
      },
      dbBusy
    };
  } catch (err) {
    if (isSqliteBusyError(err)) dbBusy = true;
    return { meta: null, dbBusy };
  } finally {
    if (db) {
      try { db.close(); } catch (_) {}
    }
  }
}

function inspectSessionDb(conversationId, options = {}) {
  return inspectSessionDbInternal(conversationId, options).meta;
}

function getCachedFileSha256(filePath, existingStat = null) {
  try {
    const st = existingStat || fs.statSync(filePath);
    if (!st.isFile()) return null;
    const sig = `${st.size}:${st.mtimeMs}`;
    const cached = lruGet(binaryHashCache, filePath, sig);
    if (cached) return cached.sha256;
    const sha256 = crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
    lruSet(binaryHashCache, filePath, { sig, sha256 }, BINARY_HASH_CACHE_MAX);
    return sha256;
  } catch (_) {
    return null;
  }
}

function getBackendPatchDir(options = {}) {
  if (options.patchBackupDir) return options.patchBackupDir;
  const customBrainDir = options.brainDir || process.env.AGY_BRAIN_DIR;
  if (customBrainDir && !options.homedir) {
    return path.join(path.dirname(customBrainDir), 'agy-patches');
  }
  const home = options.homedir || os.homedir();
  return path.join(home, '.gemini', 'agy-patches');
}

function getBackendPatchStatus(options = {}) {
  const patchDir = getBackendPatchDir(options);
  if (!patchDir || !fs.existsSync(patchDir)) {
    return { patched: false, contextLimit: null };
  }
  try {
    const files = fs.readdirSync(patchDir)
      .filter((f) => f.includes('manifest') && f.endsWith('.json'))
      .map((f) => {
        const full = path.join(patchDir, f);
        let mtimeMs = 0;
        try { mtimeMs = fs.statSync(full).mtimeMs; } catch (_) {}
        const isLs = f.toLowerCase().startsWith('language_server');
        return { file: f, full, mtimeMs, isLs };
      })
      .sort((a, b) => (Number(b.isLs) - Number(a.isLs)) || (b.mtimeMs - a.mtimeMs));

    const seenPaths = new Set();
    for (const item of files) {
      try {
        const m = JSON.parse(fs.readFileSync(item.full, 'utf8'));
        if (!m || typeof m !== 'object' || !m.patched_sha256 || !m.path) continue;
        const normTarget = process.platform === 'win32' ? String(m.path).toLowerCase() : String(m.path);
        if (seenPaths.has(normTarget)) continue;
        seenPaths.add(normTarget);
        let targetStat;
        try {
          targetStat = fs.statSync(m.path);
        } catch (_) {
          continue;
        }
        if (!targetStat || !targetStat.isFile()) continue;
        const diskSha = getCachedFileSha256(m.path, targetStat);
        if (diskSha && diskSha.toLowerCase() === String(m.patched_sha256).toLowerCase()) {
          const hostSym = m.functions && m.functions.trampolineHost && m.functions.trampolineHost.symbol
            ? String(m.functions.trampolineHost.symbol).split('.').pop()
            : 'SetSessionSummaryPromptOverride';
          return {
            patched: true,
            contextLimit: Number(m.context_limit) || PATCHED_DEFAULT_CONTEXT_LIMIT,
            rulesFileLimit: 1048576,
            rulesTokenBudget: 131072,
            targetPath: m.path,
            hostSymbol: hostSym,
            patchedSha256: m.patched_sha256
          };
        }
      } catch (_) {}
    }
  } catch (_) {}
  return { patched: false, contextLimit: null };
}

function cacheGet(key, sig) {
  const hit = lruGet(parseCache, key, sig);
  return hit ? hit.value : null;
}

function cacheSet(key, sig, value) {
  lruSet(parseCache, key, { sig, value }, CACHE_MAX_ENTRIES);
}

function clearCache() {
  parseCache.clear();
  binaryHashCache.clear();
  dailyConvCache.clear();
  summariesCache.clear();
  dailyUsageMemo = null;
}

function findConversationFiles(conversationId, options = {}) {
  if (typeof conversationId !== 'string' || !/^[0-9a-f-]{36}$/i.test(conversationId)) {
    return null;
  }
  const brainDirs = options.brainDir ? [options.brainDir] : getBrainDirs(options.homedir);
  for (const brainDir of brainDirs) {
    const logsDir = path.join(brainDir, conversationId, '.system_generated', 'logs');
    const fullPath = path.join(logsDir, 'transcript_full.jsonl');
    const compactPath = path.join(logsDir, 'transcript.jsonl');
    if (fs.existsSync(fullPath)) return fullPath;
    if (fs.existsSync(compactPath)) return compactPath;
  }
  return null;
}

// Binary search: first index whose tsMs >= target (arr sorted by tsMs)
function lowerBound(arr, target) {
  let lo = 0;
  let hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (arr[mid].tsMs < target) lo = mid + 1; else hi = mid;
  }
  return lo;
}

function parseConversationTelemetry(conversationId, options = {}) {
  const targetFile = findConversationFiles(conversationId, options);
  if (!targetFile) {
    return null;
  }

  const dataDir = options.dataDir || getTelemetryDataDir(options.homedir);
  const timingFile = path.join(dataDir, `timing_${conversationId}.jsonl`);
  const dbPath = options.dbPath || findConversationDbPath(conversationId, options);
  const patchDir = getBackendPatchDir(options);

  const tSig = statSig(targetFile);
  if (!tSig.stat) return null;
  const timingSig = statSig(timingFile);
  const dbSig = dbPath ? `${statSig(dbPath).sig}:${statSig(dbPath + '-wal').sig}` : 'nodb';
  const patchDirSig = patchDir ? statSig(patchDir).sig : 'nopatchdir';
  const cacheKey = [targetFile, timingFile, dbPath || '', patchDir || '', options.contextLimit || '', options.defaultModelName || ''].join('|');
  const fullSig = `${tSig.sig}|${timingSig.sig}|${dbSig}|${patchDirSig}`;
  if (!options.noCache) {
    const cached = cacheGet(cacheKey, fullSig);
    if (cached) return cached;
  }

  const parsed = parseUncached(conversationId, options, targetFile, tSig.stat, timingFile, timingSig.stat);
  if (!parsed) return null;
  const { result, dbBusy } = parsed;
  if (result && !options.noCache && !dbBusy) cacheSet(cacheKey, fullSig, result);
  return result;
}

function extractModelSelectionFromUserContent(content) {
  if (typeof content !== 'string' || !content) return null;
  const settingsBlock = content.match(/<USER_SETTINGS_CHANGE>([\s\S]*?)<\/USER_SETTINGS_CHANGE>/);
  const target = settingsBlock ? settingsBlock[1] : content;
  const m = target.match(/changed setting `Model Selection` from .*? to ([^\r\n<]+?)(?:\.(?:\s|$)|[\r\n<]|$)/);
  return m && m[1] ? normalizeModelName(m[1].trim()) : null;
}

function parseUncached(conversationId, options, targetFile, stat, timingFile, timingStat) {
  let rawText;
  try {
    rawText = fs.readFileSync(targetFile, 'utf8');
  } catch (_) {
    return null;
  }

  const hookTimings = readTimingEvents(timingFile, Boolean(timingStat));

  let hookModelName = '';
  let hookSwitchTs = 0;
  for (const ev of hookTimings) {
    if (ev.modelName && ev.modelName !== 'auto') {
      const norm = normalizeModelName(ev.modelName);
      if (norm && norm.toLowerCase() !== hookModelName.toLowerCase()) {
        hookModelName = norm;
        hookSwitchTs = ev.tsMs;
      } else if (norm) {
        hookModelName = norm;
      }
    }
  }

  const preInvocationEvents = hookTimings.filter(e => e.event === 'PreInvocation');
  // Events that mark "model finished generating" (PreToolUse kept for legacy timing files)
  const modelEndEvents = hookTimings.filter(e => e.event === 'PreToolUse' || e.event === 'PostInvocation' || e.event === 'Stop');

  const rawSteps = parseJsonlSteps(rawText);

  let userModelName = '';
  let userSwitchTs = 0;
  for (const s of rawSteps) {
    if (s.type === 'USER_INPUT' && typeof s.content === 'string') {
      const candidate = extractModelSelectionFromUserContent(s.content);
      if (candidate) {
        userModelName = candidate;
        const stepTs = s.created_at ? Date.parse(s.created_at) : 0;
        if (stepTs > 0) userSwitchTs = stepTs;
      }
    }
  }

  let latestModelName = normalizeModelName(options.defaultModelName || '');
  if (userModelName && hookModelName) {
    if (userModelName.toLowerCase() === hookModelName.toLowerCase()) {
      latestModelName = userModelName;
    } else if (!hookSwitchTs || (userSwitchTs && userSwitchTs >= hookSwitchTs - 5000)) {
      latestModelName = userModelName;
    } else {
      latestModelName = hookModelName;
    }
  } else if (userModelName) {
    latestModelName = userModelName;
  } else if (hookModelName) {
    latestModelName = hookModelName;
  }

  const plannerSteps = [];
  const contextConsumers = [];
  let prevTotalContext = 0;
  let totalOutputTokens = 0;
  let totalInputTokens = 0;     // sum of uncached (newly billed) input tokens over all model calls
  let totalCacheReadTokens = 0; // sum of cache-read input tokens over all model calls
  let measuredOutputTokens = 0;
  let measuredModelSec = 0;
  let totalToolSec = 0;
  let lastPlannerHadAskQuestion = false;
  let pendingStepChars = 0;
  let baselineContext = 0;       // system prompt + tools + skills baseline inferred from first model step
  let checkpointCompactions = 0; // explicit CHECKPOINT compactions
  let implicitCompactions = 0;   // context drops (>10k) without a preceding CHECKPOINT step
  let pendingCheckpoint = null;  // active CHECKPOINT awaiting next PLANNER_RESPONSE
  let checkpointPeakContext = 0;
  let modelSwitchedSinceLastPlanner = false;
  const hasExplicitCheckpoints = rawSteps.some(s => s && s.type === 'CHECKPOINT');
  let hasExactTokens = rawSteps.some(s => s && s.type === 'PLANNER_RESPONSE' && (Number(s.input_tokens || 0) > 0 || Number(s.cache_read_tokens || 0) > 0));
  let isEstimated = !hasExactTokens && rawSteps.some(s => s && s.type === 'PLANNER_RESPONSE');

  for (let i = 0; i < rawSteps.length; i++) {
    const step = rawSteps[i];

    if (step.type === 'CHECKPOINT') {
      const chkContentLen = typeof step.content === 'string' ? step.content.length : 0;
      const chkOutTok = Number(step.output_tokens || 0);
      const chkInTok = Number(step.input_tokens || 0) + Number(step.cache_read_tokens || 0);
      if (chkInTok > checkpointPeakContext) {
        checkpointPeakContext = chkInTok;
      }
      const isCheckpointDone = step.status
        ? step.status === 'DONE'
        : (chkOutTok > 0 || chkContentLen > 0);
      if (isCheckpointDone) {
        const summaryTokens = chkOutTok > 0
          ? chkOutTok
          : (chkContentLen > 0 ? estimateTokensFromChars(chkContentLen) : 2500);
        const baseTokens = baselineContext > 0 ? baselineContext : 14500;
        const compactedContext = baseTokens + summaryTokens;
        checkpointCompactions++;
        pendingCheckpoint = {
          stepIndex: step.step_index,
          createdAt: step.created_at || '',
          baseTokens,
          summaryTokens,
          compactedContext
        };
        pendingStepChars = 0;
      }
      continue;
    }

    if (step.type === 'USER_INPUT' && typeof step.content === 'string') {
      if (extractModelSelectionFromUserContent(step.content)) {
        modelSwitchedSinceLastPlanner = true;
      }
    }

    if (step.type !== 'PLANNER_RESPONSE') {
      const cLen = (typeof step.content === 'string' ? step.content.length : 0) +
        (Array.isArray(step.tool_calls) ? JSON.stringify(step.tool_calls).length : 0);
      pendingStepChars += cLen;
    }

    if (step.type === 'GENERIC' && typeof step.content === 'string') {
      if (!lastPlannerHadAskQuestion) {
        const cStart = extractCreatedAtFromContent(step.content);
        const cEnd = extractCompletedAtFromContent(step.content);
        if (cStart && cEnd && cEnd >= cStart) {
          totalToolSec += (cEnd - cStart) / 1000;
        }
      }
    }

    if (step.type !== 'PLANNER_RESPONSE') continue;

    const toolCallsRaw = Array.isArray(step.tool_calls) ? step.tool_calls : [];
    lastPlannerHadAskQuestion = toolCallsRaw.some(tc => tc && tc.name === 'ask_question');

    let inTok = Number(step.input_tokens || 0);
    let cacheTok = Number(step.cache_read_tokens || 0);
    let outTok = Number(step.output_tokens || 0);

    const selfOutChars = (typeof step.thinking === 'string' ? step.thinking.length : 0) +
      (typeof step.content === 'string' ? step.content.length : 0) +
      (toolCallsRaw.length > 0 ? JSON.stringify(toolCallsRaw).length : 0);

    if (outTok <= 0 && selfOutChars > 0) {
      outTok = estimateTokensFromChars(selfOutChars);
    }

    const pendingCharsBeforePlanner = pendingStepChars;
    const activeCheckpoint = pendingCheckpoint;
    const wasAfterCheckpoint = !!activeCheckpoint;
    if (inTok <= 0 && cacheTok <= 0) {
      if (activeCheckpoint) {
        cacheTok = activeCheckpoint.baseTokens;
        inTok = activeCheckpoint.summaryTokens + Math.max(80, estimateTokensFromChars(pendingCharsBeforePlanner));
      } else {
        const deltaEst = (plannerSteps.length === 0 ? 14500 : 0) + estimateTokensFromChars(pendingCharsBeforePlanner);
        cacheTok = prevTotalContext;
        inTok = Math.max(80, deltaEst);
      }
    }
    pendingStepChars = selfOutChars;

    const totalCtx = inTok + cacheTok;
    const deltaCtx = activeCheckpoint
      ? Math.max(0, totalCtx - activeCheckpoint.compactedContext)
      : (prevTotalContext === 0 ? totalCtx : (totalCtx - prevTotalContext));

    if (plannerSteps.length === 0) {
      const firstTurnUserTokens = estimateTokensFromChars(pendingCharsBeforePlanner);
      baselineContext = Math.max(12000, totalCtx - firstTurnUserTokens);
    }

    if (activeCheckpoint) {
      pendingCheckpoint = null;
    } else if (!hasExplicitCheckpoints && !(modelSwitchedSinceLastPlanner && deltaCtx > -30000) && deltaCtx < -10000) {
      implicitCompactions++;
    }
    modelSwitchedSinceLastPlanner = false;

    const startMs = step.created_at ? Date.parse(step.created_at) : null;
    let effectiveStartMs = startMs;
    let endMs = null;
    let isExactDuration = false;

    // 1. Only use nextStep timestamp when nextStep is a GENERIC tool execution in the same turn
    // (Never use nextStep when it is USER_INPUT, which includes human idle time between turns!)
    if (i + 1 < rawSteps.length && rawSteps[i + 1].type === 'GENERIC') {
      const nextStep = rawSteps[i + 1];
      const contentStart = extractCreatedAtFromContent(nextStep.content);
      const nextCreated = nextStep.created_at ? Date.parse(nextStep.created_at) : null;
      endMs = contentStart || nextCreated;
      if (endMs && startMs && endMs > startMs) {
        isExactDuration = true;
      }
    }

    // 2. Hook millisecond timings (PreInvocation -> PreToolUse / PostInvocation / Stop)
    // Preferred over stat.mtimeMs on the trailing step so subsequent file touches never inflate
    // durationSec or depress tok/s, and uses millisecond preEv.tsMs when matched.
    if (!isExactDuration && startMs && hookTimings.length > 0) {
      let preEv = null;
      for (let k = lowerBound(preInvocationEvents, startMs - 5000); k < preInvocationEvents.length; k++) {
        const e = preInvocationEvents[k];
        if (e.tsMs - startMs >= 5000) break;
        preEv = e;
        break;
      }
      const baseMs = preEv ? preEv.tsMs : startMs;
      const idx = lowerBound(modelEndEvents, baseMs);
      const postEv = idx < modelEndEvents.length && (modelEndEvents[idx].tsMs - baseMs) < 300000
        ? modelEndEvents[idx]
        : null;
      if (postEv && postEv.tsMs > baseMs) {
        effectiveStartMs = baseMs;
        endMs = postEv.tsMs;
        isExactDuration = true;
      }
    }

    // 3. Fallback when hook timings are absent and this DONE step is the very last line on disk
    if (!isExactDuration && i === rawSteps.length - 1 && step.status === 'DONE' && stat) {
      if (startMs && stat.mtimeMs > startMs && (stat.mtimeMs - startMs) < 300000) {
        endMs = stat.mtimeMs;
        isExactDuration = true;
      }
    }

    let durationSec = null;
    if (isExactDuration && effectiveStartMs && endMs && endMs > effectiveStartMs) {
      durationSec = Math.max(0.5, (endMs - effectiveStartMs) / 1000);
      measuredOutputTokens += outTok;
      measuredModelSec += durationSec;
    }

    let sourceLabel = '对话与工具返回';
    if (wasAfterCheckpoint) {
      sourceLabel = pendingCharsBeforePlanner > 0 ? '上下文压缩后首轮提问' : '上下文压缩摘要续接';
    } else if (plannerSteps.length === 0) {
      sourceLabel = '系统提示词 + 技能定义基线 + 首轮提问';
    } else {
      const prevPlanner = plannerSteps[plannerSteps.length - 1];
      if (prevPlanner.toolSummaries && prevPlanner.toolSummaries.length > 0) {
        sourceLabel = prevPlanner.toolSummaries.slice(0, 3).join(' + ');
        if (prevPlanner.toolSummaries.length > 3) {
          sourceLabel += ` 等 ${prevPlanner.toolSummaries.length} 项`;
        }
      } else {
        sourceLabel = '用户追问输入';
      }
    }

    const toolSummaries = toolCallsRaw.map(summarizeToolCall);
    totalOutputTokens += outTok;
    totalInputTokens += inTok;
    totalCacheReadTokens += cacheTok;

    const pEntry = {
      stepIndex: step.step_index,
      createdAt: step.created_at || '',
      inputTokens: inTok,
      cacheReadTokens: cacheTok,
      outputTokens: outTok,
      totalContext: totalCtx,
      deltaContext: deltaCtx,
      cacheHitRate: totalCtx > 0 ? Number(((cacheTok / totalCtx) * 100).toFixed(1)) : 0,
      durationSec,
      tokPerSec: 0,
      thinking: typeof step.thinking === 'string' ? step.thinking.trim() : '',
      responseText: typeof step.content === 'string' ? step.content.trim() : '',
      toolSummaries,
      sourceLabel
    };

    plannerSteps.push(pEntry);
    if (deltaCtx > 0) {
      contextConsumers.push({
        stepIndex: step.step_index,
        deltaTokens: deltaCtx,
        totalContextAfter: totalCtx,
        label: sourceLabel,
        createdAt: step.created_at || ''
      });
    }

    prevTotalContext = totalCtx;
  }

  const avgTokPerSec = measuredModelSec > 0
    ? Number((measuredOutputTokens / measuredModelSec).toFixed(1))
    : 75.0;

  let totalModelSec = 0;
  for (const p of plannerSteps) {
    if (p.durationSec === null) {
      p.durationSec = Number(Math.max(1.0, p.outputTokens / avgTokPerSec).toFixed(1));
    } else {
      p.durationSec = Number(p.durationSec.toFixed(1));
    }
    p.tokPerSec = p.outputTokens > 0 ? Number((p.outputTokens / p.durationSec).toFixed(1)) : 0;
    totalModelSec += p.durationSec;
  }

  const latest = plannerSteps.length > 0 ? plannerSteps[plannerSteps.length - 1] : null;
  const extraPendingTokens = (pendingCheckpoint && pendingStepChars > 0)
    ? estimateTokensFromChars(pendingStepChars)
    : 0;
  const currentContext = pendingCheckpoint
    ? (pendingCheckpoint.compactedContext + extraPendingTokens)
    : (latest ? latest.totalContext : 0);
  const plannerPeakContext = plannerSteps.reduce((max, p) => Math.max(max, p.totalContext), 0);
  const peakContext = plannerPeakContext > 0
    ? Math.max(plannerPeakContext, currentContext)
    : Math.max(checkpointPeakContext, currentContext);
  const compactionCount = checkpointCompactions + implicitCompactions;

  const { meta: dbMeta, dbBusy } = inspectSessionDbInternal(conversationId, options);
  const backendPatch = getBackendPatchStatus(options);
  const dbModelNorm = dbMeta
    ? ((dbMeta.modelId && MODEL_PLACEHOLDER_NAMES[`MODEL_PLACEHOLDER_M${dbMeta.modelId - 1000}`]) ||
       normalizeModelName(dbMeta.modelName || ''))
    : '';
  if (!latestModelName && dbModelNorm) {
    latestModelName = dbModelNorm;
  }

  const baseModelLimit = getModelContextLimit(latestModelName);
  const dbMatchesCurrentModel = Boolean(
    dbMeta &&
    (!latestModelName || !dbModelNorm || getModelContextLimit(dbModelNorm) === baseModelLimit)
  );
  let contextLimit;
  if (options.contextLimit) {
    contextLimit = options.contextLimit;
  } else if (dbMatchesCurrentModel && dbMeta.genMaxContextTokens > DEFAULT_CONTEXT_LIMIT) {
    contextLimit = dbMeta.genMaxContextTokens;
  } else if (backendPatch.patched && backendPatch.contextLimit > DEFAULT_CONTEXT_LIMIT && baseModelLimit === DEFAULT_CONTEXT_LIMIT) {
    contextLimit = backendPatch.contextLimit;
  } else if (dbMatchesCurrentModel && dbMeta.genMaxContextTokens > 0) {
    contextLimit = dbMeta.genMaxContextTokens;
  } else {
    contextLimit = baseModelLimit;
  }
  const contextUsagePct = Number(((currentContext / contextLimit) * 100).toFixed(1));

  const latestInputTokens = pendingCheckpoint
    ? (pendingCheckpoint.summaryTokens + extraPendingTokens)
    : (latest ? latest.inputTokens : 0);
  const latestCacheReadTokens = pendingCheckpoint
    ? pendingCheckpoint.baseTokens
    : (latest ? latest.cacheReadTokens : 0);
  const latestCacheHitRate = pendingCheckpoint
    ? (currentContext > 0 ? Number(((latestCacheReadTokens / currentContext) * 100).toFixed(1)) : 0)
    : (latest ? latest.cacheHitRate : 0);

  const topConsumers = [...contextConsumers]
    .sort((a, b) => b.deltaTokens - a.deltaTokens)
    .slice(0, 8);

  const updatedMs = Math.max(stat.mtimeMs, timingStat ? timingStat.mtimeMs : 0);

  return {
    result: {
      conversationId,
      updatedAt: new Date(updatedMs).toISOString(),
      modelName: latestModelName || 'Gemini',
      isEstimated,
      contextLimit,
      currentContext,
      peakContext,
      compactionCount,
      contextUsagePct,
      latestInputTokens,
      latestCacheReadTokens,
      latestCacheHitRate,
      latestOutputTokens: latest ? latest.outputTokens : 0,
      latestTokPerSec: latest ? latest.tokPerSec : 0,
      latestDurationSec: latest ? latest.durationSec : 0,
      avgTokPerSec,
      totalOutputTokens,
      // Cumulative tokens consumed by the whole conversation (every model call re-sends its context):
      // uncached input + cache-read input + output.
      totalInputTokens,
      totalCacheReadTokens,
      totalTokens: totalInputTokens + totalCacheReadTokens + totalOutputTokens,
      totalModelSec: Number(totalModelSec.toFixed(1)),
      totalToolSec: Number(totalToolSec.toFixed(1)),
      stepCount: rawSteps.length,
      plannerStepCount: plannerSteps.length,
      dbMeta: dbMeta || null,
      backendPatch,
      topConsumers,
      steps: plannerSteps
    },
    dbBusy
  };
}

function findLatestConversationId(brainDir) {
  const dirs = brainDir ? [brainDir] : getBrainDirs();
  let bestId = null;
  let bestMtime = 0;
  for (const dir of dirs) {
    if (!dir || !fs.existsSync(dir)) continue;
    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory() || !/^[0-9a-f-]{36}$/i.test(entry.name)) continue;
        const logFile = path.join(dir, entry.name, '.system_generated', 'logs', 'transcript_full.jsonl');
        const fallbackFile = path.join(dir, entry.name, '.system_generated', 'logs', 'transcript.jsonl');
        const target = fs.existsSync(logFile) ? logFile : (fs.existsSync(fallbackFile) ? fallbackFile : null);
        if (!target) continue;
        const mtime = fs.statSync(target).mtimeMs;
        if (mtime > bestMtime) {
          bestMtime = mtime;
          bestId = entry.name;
        }
      }
    } catch (_) {}
  }
  return bestId;
}

function decodeProtoTimestampMs(buf) {
  try {
    const fields = iterFields(buf);
    let sec = 0;
    let nanos = 0;
    for (const [f, w, v] of fields) {
      if (f === 1 && w === 0) sec = Number(v);
      else if (f === 2 && w === 0) nanos = Number(v);
    }
    if (sec > 0) return sec * 1000 + Math.floor(nanos / 1e6);
  } catch (_) {}
  return 0;
}

function decodeGenMetaModel(raw) {
  try {
    const buf = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
    const topFields = iterFields(buf);
    const chats = topFields.filter(([f, w]) => f === 1 && w === 2);
    const targetBuf = chats.length > 0 ? chats[chats.length - 1][2] : buf;
    const fields = iterFields(targetBuf);
    let modelId = null;
    let responseModel = '';
    let displayName = '';
    for (const [f, w, v] of fields) {
      if (f === 3 && w === 0) modelId = Number(v);
      else if (f === 19 && w === 2) responseModel = v.toString('utf8').trim();
      else if (f === 21 && w === 2) displayName = v.toString('utf8').trim();
    }
    return { modelId, responseModel, displayName };
  } catch (_) {
    return null;
  }
}

function decodeModelUsageStats(uBuf, fallbackModelId) {
  try {
    const fields = iterFields(uBuf);
    let modelId = fallbackModelId || 0;
    let inputTokens = 0;
    let outputTokens = 0;
    let cacheWriteTokens = 0;
    let cacheReadTokens = 0;
    let thinkingTokens = 0;
    let responseTokens = null;
    for (const [f, w, v] of fields) {
      if (w !== 0) continue;
      if (f === 1 && v > 0) modelId = Number(v);
      else if (f === 2) inputTokens = Number(v);
      else if (f === 3) outputTokens = Number(v);
      else if (f === 4) cacheWriteTokens = Number(v);
      else if (f === 5) cacheReadTokens = Number(v);
      else if (f === 9) thinkingTokens = Number(v);
      else if (f === 10) responseTokens = Number(v);
    }
    if (responseTokens === null) {
      responseTokens = Math.max(0, outputTokens - thinkingTokens);
    }
    const totalTokens = inputTokens + cacheReadTokens + cacheWriteTokens + outputTokens;
    return {
      modelId,
      inputTokens,
      outputTokens,
      cacheWriteTokens,
      cacheReadTokens,
      thinkingTokens,
      responseTokens,
      totalTokens
    };
  } catch (_) {
    return null;
  }
}

function decodeStepMetadataUsage(raw, fallbackTsMs) {
  try {
    const buf = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
    const fields = iterFields(buf);
    let createdAtMs = 0;
    let viewableAtMs = 0;
    let generatorModelId = 0;
    let usageBuf = null;
    const retryUsageBufs = [];

    for (const [f, w, v] of fields) {
      if (f === 1 && w === 2) {
        const ms = decodeProtoTimestampMs(v);
        if (ms > 0) createdAtMs = ms;
      } else if (f === 6 && w === 2) {
        const ms = decodeProtoTimestampMs(v);
        if (ms > 0) viewableAtMs = ms;
      } else if (f === 11 && w === 0) {
        generatorModelId = Number(v);
      } else if (f === 9 && w === 2) {
        usageBuf = v;
      } else if (f === 28 && w === 2) {
        try {
          for (const [rf, rw, rv] of iterFields(v)) {
            if (rf === 2 && rw === 2) retryUsageBufs.push(rv);
          }
        } catch (_) {}
      }
    }

    let stats = usageBuf ? decodeModelUsageStats(usageBuf, generatorModelId) : null;
    if ((!stats || stats.totalTokens <= 0) && retryUsageBufs.length > 0) {
      for (let i = retryUsageBufs.length - 1; i >= 0; i--) {
        const cand = decodeModelUsageStats(retryUsageBufs[i], generatorModelId);
        if (cand && cand.totalTokens > 0) {
          stats = cand;
          break;
        }
      }
    }
    if (!stats || stats.totalTokens <= 0) return null;
    return {
      tsMs: createdAtMs || viewableAtMs || fallbackTsMs || Date.now(),
      ...stats
    };
  } catch (_) {
    return null;
  }
}

function readConversationSummaries(summaryDbPaths, options = {}) {
  const result = new Map();
  let dbBusy = false;
  if (!DatabaseSync) return { summariesMap: result, dbBusy };
  for (const dbPath of summaryDbPaths) {
    if (!dbPath || !fs.existsSync(dbPath)) continue;
    const sig = `${statSig(dbPath).sig}:${statSig(dbPath + '-wal').sig}`;
    if (!options.noCache) {
      const cached = lruGet(summariesCache, dbPath, sig);
      if (cached) {
        for (const [k, v] of cached.map) result.set(k, v);
        continue;
      }
    }
    const map = new Map();
    let db = null;
    try {
      db = openReadOnlyDb(dbPath);
      const rows = db.prepare('SELECT conversation_id, title, agent_name, parent_conversation_id, nesting_depth FROM conversation_summaries').all();
      for (const r of rows) {
        if (!r || !r.conversation_id) continue;
        const cid = String(r.conversation_id).toLowerCase();
        map.set(cid, {
          title: r.title ? String(r.title) : '',
          agentName: r.agent_name ? String(r.agent_name) : '',
          parentConversationId: r.parent_conversation_id ? String(r.parent_conversation_id) : '',
          isSubagent: Number(r.nesting_depth || 0) > 0 || Boolean(r.parent_conversation_id)
        });
      }
      if (!options.noCache) {
        lruSet(summariesCache, dbPath, { sig, map }, SUMMARIES_CACHE_MAX);
      }
      for (const [k, v] of map) result.set(k, v);
    } catch (err) {
      if (isSqliteBusyError(err)) dbBusy = true;
    } finally {
      if (db) {
        try { db.close(); } catch (_) {}
      }
    }
  }
  return { summariesMap: result, dbBusy };
}

function extractConversationStepUsages(cid, dbPath, transcriptPath, timingFile, options = {}) {
  const dbStat = dbPath ? statSig(dbPath) : { sig: 'missing', stat: null };
  const walStat = dbPath ? statSig(dbPath + '-wal') : { sig: 'missing', stat: null };
  const tStat = transcriptPath ? statSig(transcriptPath) : { sig: 'missing', stat: null };
  const timingStat = timingFile ? statSig(timingFile) : { sig: 'missing', stat: null };
  const cacheKey = `${cid}|${dbPath || ''}|${transcriptPath || ''}|${timingFile || ''}|${options.defaultModelName || ''}`;
  const fullSig = `${dbStat.sig}|${walStat.sig}|${tStat.sig}|${timingStat.sig}`;

  if (!options.noCache) {
    const hit = lruGet(dailyConvCache, cacheKey, fullSig);
    if (hit) return hit.value;
  }

  const steps = [];
  let maxDbStepIdx = -1;
  let activeDbModel = normalizeModelName(options.defaultModelName || '');
  let isSubagentFromTranscript = false;
  let dbBusy = false;
  const dbActivityMs = Math.max(
    dbStat.stat ? dbStat.stat.mtimeMs : 0,
    walStat.stat ? walStat.stat.mtimeMs : 0
  );

  // Source 1: SQLite <cid>.db
  if (dbPath && DatabaseSync && dbStat.stat) {
    let db = null;
    try {
      db = openReadOnlyDb(dbPath);
      const genModelById = new Map();
      try {
        const gRows = db.prepare('SELECT idx, data FROM gen_metadata ORDER BY idx ASC').all();
        for (const gr of gRows) {
          if (!gr || !gr.data) continue;
          const info = decodeGenMetaModel(gr.data);
          if (!info) continue;
          const resolved = (info.modelId > 1000 && MODEL_PLACEHOLDER_NAMES[`MODEL_PLACEHOLDER_M${info.modelId - 1000}`]) ||
            normalizeModelName(info.displayName) ||
            normalizeModelName(info.responseModel);
          if (info.modelId && resolved) genModelById.set(info.modelId, resolved);
          if (resolved) activeDbModel = resolved;
        }
      } catch (genErr) {
        if (isSqliteBusyError(genErr)) dbBusy = true;
      }

      try {
        const sRows = db.prepare('SELECT idx, step_type, metadata FROM steps WHERE step_type IN (15, 23) AND metadata IS NOT NULL ORDER BY idx ASC').all();
        let runningModel = activeDbModel || 'Gemini';
        for (const row of sRows) {
          const idx = Number(row.idx);
          if (Number.isFinite(idx) && idx > maxDbStepIdx) maxDbStepIdx = idx;
          if (!row.metadata) continue;
          const decoded = decodeStepMetadataUsage(row.metadata, dbActivityMs || Date.now());
          if (!decoded) continue;
          const mId = decoded.modelId;
          const resolvedModel = (mId > 1000 && MODEL_PLACEHOLDER_NAMES[`MODEL_PLACEHOLDER_M${mId - 1000}`]) ||
            (mId && genModelById.get(mId)) ||
            runningModel ||
            'Gemini';
          runningModel = resolvedModel;
          steps.push({
            stepIndex: idx,
            tsMs: decoded.tsMs,
            modelName: resolvedModel,
            inputTokens: decoded.inputTokens,
            cacheReadTokens: decoded.cacheReadTokens,
            cacheWriteTokens: decoded.cacheWriteTokens,
            outputTokens: decoded.outputTokens,
            thinkingTokens: decoded.thinkingTokens,
            responseTokens: decoded.responseTokens
          });
        }
        activeDbModel = runningModel;
      } catch (stepErr) {
        if (isSqliteBusyError(stepErr)) dbBusy = true;
      }
    } catch (err) {
      if (isSqliteBusyError(err)) dbBusy = true;
    } finally {
      if (db) {
        try { db.close(); } catch (_) {}
      }
    }
  }

  // Source 2: Transcript JSONL Fallback / Supplement
  const shouldReadTranscript = Boolean(
    transcriptPath &&
    tStat.stat &&
    (steps.length === 0 || tStat.stat.mtimeMs >= dbActivityMs - 2000)
  );

  if (shouldReadTranscript) {
    let rawText = '';
    try {
      rawText = fs.readFileSync(transcriptPath, 'utf8');
    } catch (_) {}
    if (rawText) {
      const hookTimings = readTimingEvents(timingFile, Boolean(timingStat.stat));
      const rawSteps = parseJsonlSteps(rawText);

      // Check if first user/system message indicates a subagent invocation
      for (let i = 0; i < Math.min(rawSteps.length, 3); i++) {
        const s = rawSteps[i];
        if (s && typeof s.content === 'string') {
          if (/\[Message\]\s+timestamp=.*?\bsender=[0-9a-f-]{36}\b/i.test(s.content) || /<subagent_reminder>/i.test(s.content)) {
            isSubagentFromTranscript = true;
            break;
          }
        }
      }

      let currentModel = activeDbModel || normalizeModelName(options.defaultModelName || '');
      if (!currentModel) {
        for (const ev of hookTimings) {
          if (ev.modelName && ev.modelName !== 'auto') {
            const norm = normalizeModelName(ev.modelName);
            if (norm) { currentModel = norm; break; }
          }
        }
      }
      if (!currentModel) {
        for (const s of rawSteps) {
          if (s && typeof s.content === 'string') {
            const cand = extractModelSelectionFromUserContent(s.content);
            if (cand) { currentModel = cand; break; }
          }
        }
      }
      if (!currentModel) currentModel = 'Gemini';

      let hookCursor = 0;
      let lastUserSwitchTs = 0;
      let prevTotalContext = 0;
      let pendingStepChars = 0;
      let baselineContext = 0;
      let pendingCheckpoint = null;
      let plannerSeen = 0;

      for (let i = 0; i < rawSteps.length; i++) {
        const step = rawSteps[i];
        if (!step) continue;
        const stepIdx = typeof step.step_index === 'number' ? step.step_index : i;
        const stepTs = (step.created_at && Date.parse(step.created_at)) || 0;

        if (typeof step.content === 'string') {
          const switched = extractModelSelectionFromUserContent(step.content);
          if (switched) {
            currentModel = switched;
            if (stepTs > 0) lastUserSwitchTs = stepTs;
          }
        }

        while (hookCursor < hookTimings.length) {
          const ev = hookTimings[hookCursor];
          if (stepTs > 0 && ev.tsMs > stepTs + 2000) break;
          if (ev.modelName && ev.modelName !== 'auto' && (!lastUserSwitchTs || ev.tsMs >= lastUserSwitchTs)) {
            const norm = normalizeModelName(ev.modelName);
            if (norm) currentModel = norm;
          }
          hookCursor++;
        }

        if (step.type === 'CHECKPOINT') {
          const chkContentLen = typeof step.content === 'string' ? step.content.length : 0;
          const chkOutTok = Number(step.output_tokens || 0);
          const chkInTok = Number(step.input_tokens || 0);
          const chkCacheTok = Number(step.cache_read_tokens || 0);
          const isCheckpointDone = step.status
            ? step.status === 'DONE'
            : (chkOutTok > 0 || chkContentLen > 0);
          if (isCheckpointDone) {
            const summaryTokens = chkOutTok > 0
              ? chkOutTok
              : (chkContentLen > 0 ? estimateTokensFromChars(chkContentLen) : 2500);
            const baseTokens = baselineContext > 0 ? baselineContext : 14500;
            pendingCheckpoint = {
              baseTokens,
              summaryTokens,
              compactedContext: baseTokens + summaryTokens
            };
            pendingStepChars = 0;
          }
          if (stepIdx > maxDbStepIdx && (chkInTok + chkCacheTok + chkOutTok > 0)) {
            const thinkTok = (typeof step.thinking === 'string' && step.thinking.length > 0)
              ? Math.min(chkOutTok, estimateTokensFromChars(step.thinking.length))
              : 0;
            steps.push({
              stepIndex: stepIdx,
              tsMs: stepTs || tStat.stat.mtimeMs,
              modelName: currentModel || 'Gemini',
              inputTokens: chkInTok,
              cacheReadTokens: chkCacheTok,
              cacheWriteTokens: 0,
              outputTokens: chkOutTok,
              thinkingTokens: thinkTok,
              responseTokens: Math.max(0, chkOutTok - thinkTok)
            });
          }
          continue;
        }

        if (step.type !== 'PLANNER_RESPONSE') {
          const cLen = (typeof step.content === 'string' ? step.content.length : 0) +
            (Array.isArray(step.tool_calls) ? JSON.stringify(step.tool_calls).length : 0);
          pendingStepChars += cLen;
          continue;
        }

        const toolCallsRaw = Array.isArray(step.tool_calls) ? step.tool_calls : [];
        let inTok = Number(step.input_tokens || 0);
        let cacheTok = Number(step.cache_read_tokens || 0);
        let outTok = Number(step.output_tokens || 0);

        const selfOutChars = (typeof step.thinking === 'string' ? step.thinking.length : 0) +
          (typeof step.content === 'string' ? step.content.length : 0) +
          (toolCallsRaw.length > 0 ? JSON.stringify(toolCallsRaw).length : 0);

        if (outTok <= 0 && selfOutChars > 0) {
          outTok = estimateTokensFromChars(selfOutChars);
        }

        const pendingCharsBeforePlanner = pendingStepChars;
        const activeCheckpoint = pendingCheckpoint;
        if (inTok <= 0 && cacheTok <= 0) {
          if (activeCheckpoint) {
            cacheTok = activeCheckpoint.baseTokens;
            inTok = activeCheckpoint.summaryTokens + Math.max(80, estimateTokensFromChars(pendingCharsBeforePlanner));
          } else {
            const deltaEst = (plannerSeen === 0 ? 14500 : 0) + estimateTokensFromChars(pendingCharsBeforePlanner);
            cacheTok = prevTotalContext;
            inTok = Math.max(80, deltaEst);
          }
        }
        pendingStepChars = selfOutChars;
        const totalCtx = inTok + cacheTok;
        if (plannerSeen === 0) {
          const firstTurnUserTokens = estimateTokensFromChars(pendingCharsBeforePlanner);
          baselineContext = Math.max(12000, totalCtx - firstTurnUserTokens);
        }
        if (activeCheckpoint) pendingCheckpoint = null;
        prevTotalContext = totalCtx;
        plannerSeen++;

        if (stepIdx > maxDbStepIdx && (inTok + cacheTok + outTok > 0)) {
          const thinkTok = (typeof step.thinking === 'string' && step.thinking.length > 0)
            ? Math.min(outTok, estimateTokensFromChars(step.thinking.length))
            : 0;
          steps.push({
            stepIndex: stepIdx,
            tsMs: stepTs || tStat.stat.mtimeMs,
            modelName: currentModel || 'Gemini',
            inputTokens: inTok,
            cacheReadTokens: cacheTok,
            cacheWriteTokens: 0,
            outputTokens: outTok,
            thinkingTokens: thinkTok,
            responseTokens: Math.max(0, outTok - thinkTok)
          });
        }
      }
    }
  }

  const value = { steps, isSubagentFromTranscript, dbBusy };
  if (!options.noCache && !dbBusy) {
    lruSet(dailyConvCache, cacheKey, { sig: fullSig, value }, DAILY_CONV_CACHE_MAX);
  }
  return value;
}

function createEmptyDayBucket(dateKey) {
  return {
    date: dateKey,
    totalTokens: 0,
    inputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    outputTokens: 0,
    thinkingTokens: 0,
    responseTokens: 0,
    mainTokens: 0,
    subagentTokens: 0,
    turnCount: 0,
    sessionCount: 0,
    cacheHitRate: 0,
    models: []
  };
}

function accumulateModelStep(modelMap, meta, st, stepTotal, isSubagent, cid) {
  const mKey = meta.modelName;
  let mEntry = modelMap.get(mKey);
  if (!mEntry) {
    mEntry = {
      modelName: meta.modelName,
      shortLabel: meta.shortLabel,
      family: meta.family,
      color: meta.color,
      totalTokens: 0,
      inputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      outputTokens: 0,
      thinkingTokens: 0,
      responseTokens: 0,
      mainTokens: 0,
      subagentTokens: 0,
      turnCount: 0,
      sessions: new Set()
    };
    modelMap.set(mKey, mEntry);
  }
  mEntry.totalTokens += stepTotal;
  mEntry.inputTokens += st.inputTokens;
  mEntry.cacheReadTokens += st.cacheReadTokens;
  mEntry.cacheWriteTokens += st.cacheWriteTokens;
  mEntry.outputTokens += st.outputTokens;
  mEntry.thinkingTokens += st.thinkingTokens;
  mEntry.responseTokens += st.responseTokens;
  if (isSubagent) mEntry.subagentTokens += stepTotal;
  else mEntry.mainTokens += stepTotal;
  mEntry.turnCount += 1;
  mEntry.sessions.add(cid);
}

function finalizeModelList(modelMap, bucketTotalTokens) {
  const modelsList = [...modelMap.values()].map(m => {
    const mPrompt = m.inputTokens + m.cacheReadTokens;
    return {
      modelName: m.modelName,
      shortLabel: m.shortLabel,
      family: m.family,
      color: m.color,
      totalTokens: m.totalTokens,
      inputTokens: m.inputTokens,
      cacheReadTokens: m.cacheReadTokens,
      cacheWriteTokens: m.cacheWriteTokens,
      outputTokens: m.outputTokens,
      thinkingTokens: m.thinkingTokens,
      responseTokens: m.responseTokens,
      mainTokens: m.mainTokens,
      subagentTokens: m.subagentTokens,
      turnCount: m.turnCount,
      sessionCount: m.sessions.size,
      sharePct: bucketTotalTokens > 0 ? Number(((m.totalTokens / bucketTotalTokens) * 100).toFixed(1)) : 0,
      cacheHitRate: mPrompt > 0 ? Number(((m.cacheReadTokens / mPrompt) * 100).toFixed(1)) : 0
    };
  });

  // Disambiguate colliding shortLabels in the same bucket by preserving compact tier suffix
  const labelCounts = new Map();
  for (const m of modelsList) {
    labelCounts.set(m.shortLabel, (labelCounts.get(m.shortLabel) || 0) + 1);
  }
  if ([...labelCounts.values()].some(c => c > 1)) {
    for (const m of modelsList) {
      if ((labelCounts.get(m.shortLabel) || 0) > 1) {
        const tierMatch = m.modelName.match(/\(([^)]+)\)$/);
        if (tierMatch) {
          const rawTier = tierMatch[1].trim();
          const compactTier = /^medium$/i.test(rawTier) ? 'Med' : rawTier;
          if (!m.shortLabel.endsWith(`(${compactTier})`)) {
            m.shortLabel = `${m.shortLabel} (${compactTier})`;
          }
        }
      }
    }
  }

  modelsList.sort((a, bModel) => bModel.totalTokens - a.totalTokens);
  return modelsList;
}

function getDailyModelUsage(options = {}) {
  const customBrainDir = options.brainDir || process.env.AGY_BRAIN_DIR;
  const isIsolated = Boolean(customBrainDir && !options.homedir);
  const home = options.homedir || os.homedir();
  const brainDirs = options.brainDir
    ? [options.brainDir]
    : (isIsolated ? [customBrainDir] : getBrainDirs(home));
  const dataDir = options.dataDir || getTelemetryDataDir(options.homedir);

  let convDirs = [];
  let summaryDbPaths = [];
  if (options.conversationsDir) {
    convDirs = Array.isArray(options.conversationsDir) ? options.conversationsDir : [options.conversationsDir];
    summaryDbPaths = convDirs.map(d => path.join(path.dirname(d), 'conversation_summaries.db'));
  } else if (isIsolated) {
    const baseDir = path.dirname(brainDirs[0]);
    convDirs = [path.join(baseDir, 'conversations')];
    summaryDbPaths = [path.join(baseDir, 'conversation_summaries.db')];
  } else {
    convDirs = PRODUCT_DIRS.map(p => path.join(home, '.gemini', p, 'conversations'));
    summaryDbPaths = PRODUCT_DIRS.map(p => path.join(home, '.gemini', p, 'conversation_summaries.db'));
  }

  const todayKey = options.todayKey || toLocalDateKey(options.nowMs || Date.now());
  const memoKey = [brainDirs.join(';'), dataDir || '', convDirs.join(';'), summaryDbPaths.join(';'), todayKey, options.defaultModelName || ''].join('|');
  if (!options.noCache && dailyUsageMemo && dailyUsageMemo.key === memoKey && (Date.now() - dailyUsageMemo.tsMs) < 1200) {
    return dailyUsageMemo.value;
  }
  const { summariesMap, dbBusy: summariesBusy } = readConversationSummaries(summaryDbPaths, options);
  let anyDbBusy = summariesBusy;

  const convMap = new Map();
  for (const cDir of convDirs) {
    if (!cDir || !fs.existsSync(cDir)) continue;
    try {
      for (const name of fs.readdirSync(cDir)) {
        if (!name.endsWith('.db')) continue;
        const cid = name.slice(0, -3).toLowerCase();
        if (!/^[0-9a-f-]{36}$/.test(cid)) continue;
        const fullDb = path.join(cDir, name);
        const existing = convMap.get(cid);
        if (!existing || !existing.dbPath) {
          convMap.set(cid, { cid, dbPath: fullDb, transcriptPath: null });
        }
      }
    } catch (_) {}
  }

  for (const brainDir of brainDirs) {
    if (!brainDir || !fs.existsSync(brainDir)) continue;
    try {
      const entries = fs.readdirSync(brainDir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory() || !/^[0-9a-f-]{36}$/i.test(entry.name)) continue;
        const cid = entry.name.toLowerCase();
        const logsDir = path.join(brainDir, entry.name, '.system_generated', 'logs');
        const fullPath = path.join(logsDir, 'transcript_full.jsonl');
        const compactPath = path.join(logsDir, 'transcript.jsonl');
        const tPath = fs.existsSync(fullPath) ? fullPath : (fs.existsSync(compactPath) ? compactPath : null);
        if (!tPath) continue;
        const existing = convMap.get(cid);
        if (existing) {
          if (!existing.transcriptPath) existing.transcriptPath = tPath;
        } else {
          convMap.set(cid, { cid, dbPath: null, transcriptPath: tPath });
        }
      }
    } catch (_) {}
  }

  const dayInternal = new Map();
  const ensureDay = (dKey) => {
    let d = dayInternal.get(dKey);
    if (!d) {
      d = {
        bucket: createEmptyDayBucket(dKey),
        sessions: new Set(),
        modelMap: new Map()
      };
      dayInternal.set(dKey, d);
    }
    return d;
  };
  ensureDay(todayKey);

  const [ty, tm, td] = todayKey.split('-').map(Number);
  const recentDateKeys = [];
  for (let offset = 6; offset >= 0; offset--) {
    const dt = new Date(ty, (tm || 1) - 1, (td || 1) - offset, 12, 0, 0);
    recentDateKeys.push(toLocalDateKey(dt.getTime()));
  }
  const recentDateSet = new Set(recentDateKeys);

  const grandTotal = {
    totalTokens: 0,
    inputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    outputTokens: 0,
    thinkingTokens: 0,
    responseTokens: 0,
    mainTokens: 0,
    subagentTokens: 0,
    turnCount: 0,
    sessionCount: 0,
    dayCount: 0,
    cacheHitRate: 0,
    models: []
  };
  const allSessions = new Set();
  const grandModelMap = new Map();

  const weekly = {
    startDate: recentDateKeys[0] || todayKey,
    endDate: todayKey,
    totalTokens: 0,
    inputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    outputTokens: 0,
    thinkingTokens: 0,
    responseTokens: 0,
    mainTokens: 0,
    subagentTokens: 0,
    turnCount: 0,
    sessionCount: 0,
    dayCount: 0,
    cacheHitRate: 0,
    models: []
  };
  const weeklySessions = new Set();
  const weeklyModelMap = new Map();

  for (const [cid, info] of convMap) {
    const timingFile = dataDir ? path.join(dataDir, `timing_${cid}.jsonl`) : null;
    const extracted = extractConversationStepUsages(cid, info.dbPath, info.transcriptPath, timingFile, options);
    if (extracted && extracted.dbBusy) anyDbBusy = true;
    if (!extracted || !extracted.steps || extracted.steps.length === 0) continue;
    const sumInfo = summariesMap.get(cid);
    const isSubagent = sumInfo ? Boolean(sumInfo.isSubagent) : Boolean(extracted.isSubagentFromTranscript);

    allSessions.add(cid);
    for (const st of extracted.steps) {
      const dateKey = toLocalDateKey(st.tsMs);
      const dayEntry = ensureDay(dateKey);
      const b = dayEntry.bucket;
      const stepTotal = st.inputTokens + st.cacheReadTokens + st.cacheWriteTokens + st.outputTokens;
      if (stepTotal <= 0) continue;

      b.totalTokens += stepTotal;
      b.inputTokens += st.inputTokens;
      b.cacheReadTokens += st.cacheReadTokens;
      b.cacheWriteTokens += st.cacheWriteTokens;
      b.outputTokens += st.outputTokens;
      b.thinkingTokens += st.thinkingTokens;
      b.responseTokens += st.responseTokens;
      if (isSubagent) b.subagentTokens += stepTotal;
      else b.mainTokens += stepTotal;
      b.turnCount += 1;
      dayEntry.sessions.add(cid);

      const meta = getModelVisualMeta(st.modelName);
      accumulateModelStep(dayEntry.modelMap, meta, st, stepTotal, isSubagent, cid);
      accumulateModelStep(grandModelMap, meta, st, stepTotal, isSubagent, cid);

      grandTotal.totalTokens += stepTotal;
      grandTotal.inputTokens += st.inputTokens;
      grandTotal.cacheReadTokens += st.cacheReadTokens;
      grandTotal.cacheWriteTokens += st.cacheWriteTokens;
      grandTotal.outputTokens += st.outputTokens;
      grandTotal.thinkingTokens += st.thinkingTokens;
      grandTotal.responseTokens += st.responseTokens;
      if (isSubagent) grandTotal.subagentTokens += stepTotal;
      else grandTotal.mainTokens += stepTotal;
      grandTotal.turnCount += 1;

      if (recentDateSet.has(dateKey)) {
        weekly.totalTokens += stepTotal;
        weekly.inputTokens += st.inputTokens;
        weekly.cacheReadTokens += st.cacheReadTokens;
        weekly.cacheWriteTokens += st.cacheWriteTokens;
        weekly.outputTokens += st.outputTokens;
        weekly.thinkingTokens += st.thinkingTokens;
        weekly.responseTokens += st.responseTokens;
        if (isSubagent) weekly.subagentTokens += stepTotal;
        else weekly.mainTokens += stepTotal;
        weekly.turnCount += 1;
        weeklySessions.add(cid);
        accumulateModelStep(weeklyModelMap, meta, st, stepTotal, isSubagent, cid);
      }
    }
  }

  const availableDates = [...dayInternal.keys()].sort();
  const days = {};
  for (const dKey of availableDates) {
    const d = dayInternal.get(dKey);
    const b = d.bucket;
    b.sessionCount = d.sessions.size;
    const promptTok = b.inputTokens + b.cacheReadTokens;
    b.cacheHitRate = promptTok > 0 ? Number(((b.cacheReadTokens / promptTok) * 100).toFixed(1)) : 0;
    b.models = finalizeModelList(d.modelMap, b.totalTokens);
    days[dKey] = b;
    if (b.totalTokens > 0) grandTotal.dayCount += 1;
  }
  grandTotal.sessionCount = allSessions.size;
  const grandPrompt = grandTotal.inputTokens + grandTotal.cacheReadTokens;
  grandTotal.cacheHitRate = grandPrompt > 0 ? Number(((grandTotal.cacheReadTokens / grandPrompt) * 100).toFixed(1)) : 0;
  grandTotal.models = finalizeModelList(grandModelMap, grandTotal.totalTokens);

  const recentDays = [];
  for (const dKey of recentDateKeys) {
    const dayObj = days[dKey] || createEmptyDayBucket(dKey);
    if (dayObj.totalTokens > 0) weekly.dayCount += 1;
    recentDays.push({
      date: dKey,
      label: dKey.slice(5),
      isToday: dKey === todayKey,
      totalTokens: dayObj.totalTokens,
      inputTokens: dayObj.inputTokens,
      cacheReadTokens: dayObj.cacheReadTokens,
      outputTokens: dayObj.outputTokens,
      thinkingTokens: dayObj.thinkingTokens,
      turnCount: dayObj.turnCount,
      sessionCount: dayObj.sessionCount,
      topModelColor: (dayObj.models[0] && dayObj.models[0].color) || '#60a5fa',
      models: dayObj.models.map(m => ({
        modelName: m.modelName,
        shortLabel: m.shortLabel,
        color: m.color,
        totalTokens: m.totalTokens,
        sharePct: m.sharePct
      }))
    });
  }
  weekly.sessionCount = weeklySessions.size;
  const weeklyPrompt = weekly.inputTokens + weekly.cacheReadTokens;
  weekly.cacheHitRate = weeklyPrompt > 0 ? Number(((weekly.cacheReadTokens / weeklyPrompt) * 100).toFixed(1)) : 0;
  weekly.models = finalizeModelList(weeklyModelMap, weekly.totalTokens);

  const result = {
    generatedAt: new Date().toISOString(),
    todayKey,
    today: days[todayKey],
    weekly,
    days,
    recentDays,
    availableDates,
    grandTotal
  };
  if (!options.noCache && !anyDbBusy) {
    dailyUsageMemo = { key: memoKey, tsMs: Date.now(), value: result };
  }
  return result;
}

/**
 * Strip per-step details (steps array, thinking / response bodies) from a telemetry snapshot.
 * Used for everything that leaves the parsing process except the same-origin sidecar UI:
 * the in-app HUD only needs aggregate numbers and stepCount, so sending per-step arrays over
 * IPC every poll is pure overhead (and needlessly widens exposure of conversation content).
 */
function summarizeTelemetry(t) {
  if (!t || typeof t !== 'object') return t;
  const out = Object.assign({}, t);
  out.stepCount = typeof t.stepCount === 'number'
    ? t.stepCount
    : (Array.isArray(t.steps) ? t.steps.length : 0);
  delete out.steps;
  if (!out.dailyUsage) {
    out.dailyUsage = getDailyModelUsage();
  }
  return out;
}

module.exports = {
  parseConversationTelemetry,
  summarizeTelemetry,
  findLatestConversationId,
  getDailyModelUsage,
  getModelVisualMeta,
  inferModelVisuals: getModelVisualMeta,
  toLocalDateKey,
  getBrainDir,
  getBrainDirs,
  findConversationFiles,
  getTelemetryDataDir,
  getModelContextLimit,
  normalizeModelName,
  inspectSessionDb,
  getBackendPatchStatus,
  parseGenUsage,
  parseExecRow,
  DEFAULT_CONTEXT_LIMIT,
  PATCHED_DEFAULT_CONTEXT_LIMIT,
  ACCEPTED_PATCH_LIMITS,
  MODEL_CONTEXT_LIMIT_RULES,
  MODEL_PLACEHOLDER_NAMES,
  MODEL_SLUG_NAMES,
  clearCache
};
