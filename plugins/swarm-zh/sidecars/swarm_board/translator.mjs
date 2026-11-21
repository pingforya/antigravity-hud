/**
 * Hybrid non-blocking Chinese translation engine for Swarm Board sidecar.
 * Zero external npm dependencies (Node.js built-ins only).
 *
 * Features:
 *   F1: Placeholder masking & restoration (code blocks, inline code, URLs, paths,
 *       filenames, UUIDs, @#channel, @mentions, #seq) + CJK/bare-token detection.
 *   F2: Deterministic Tier-1 offline rules (Swarm protocol tags, BOARD_ACTIVITY,
 *       describeToolCall, stepFailure, systemAttention, verdicts/labels).
 *   F3: Optional explicit opt-in async LLM worker queue (only when providerConfig
 *       or AGY_SWARM_TRANSLATE_BASE_URL is explicitly configured; completely offline
 *       by default with zero external API calls or key lookups) and atomic LRU cache.
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export const PROMPT_VERSION = 'v1';

const DEFAULT_MAX_ENTRIES = 2000;
const DEFAULT_CONCURRENCY = 3;
const DEFAULT_TIMEOUT_MS = 45_000;
const DEFAULT_BASE_BACKOFF_MS = 1000;
const DEFAULT_DEBOUNCE_MS = 1500;
const MAX_QUEUE_SIZE = 500;
const RETRY_COOLDOWN_MS = 60_000;
const LONG_MESSAGE_CHUNK_THRESHOLD = 2000;
const LONG_MESSAGE_CHUNK_MAX_CHARS = 1800;

const SYSTEM_PROMPT = [
  '将以下 Swarm 协作看板文本翻译为自然、通顺、简洁的简体中文。严格规则：',
  '1) 原样保留所有 `⟦P0⟧`、`⟦P1⟧` 等占位符标记，不得翻译、删改、拆分或重新编号；',
  '2) 保留原有的 Markdown 结构（标题、列表、加粗、引用等）；',
  '3) 常见技术缩写（API、JSON、HTTP、CLI、UUID、ESM、CJS、ETag 等）保持自然混排；',
  '4) 只输出翻译后的中文正文，不要附加任何解释或引号。',
].join('\n');

// ---------------------------------------------------------------------------
// F1: Placeholder Masking & Restoration
// ---------------------------------------------------------------------------

const BARE_FILE_EXTS =
  'mjs|cjs|jsx?|tsx?|json[l]?|ya?ml|md|py|rs|go|css|html|svg|png|jpe?g|webp|txt|log|db|pb|pbtxt|exe|ps1|sh|toml|lock|sql|csv';

const CJK_CHAR = '\\p{Script=Han}\\p{Script=Hiragana}\\p{Script=Katakana}\\p{Script=Hangul}';
const NON_CJK_ALNUM = `(?![${CJK_CHAR}])[\\p{L}\\p{N}]`;
const WIN_STOP_CHARS = `\\s<>"'|\`*?()[\\]{},;!?⟦⟧\\uE000\\uE001\\u3000-\\u303F\\uFF00-\\uFFEF\\u2018-\\u201F${CJK_CHAR}`;
const RE_SENTINEL = /⟦P\d+⟧/g;
const RE_INLINE_CODE = /(?<!`)```(?:(?!```)[^\r\n])+```(?!`)|(?<!`)``(?:(?!``)[^\r\n])+``(?!`)|(?<!`)`[^`\r\n]+`(?!`)/g;
const RE_URL = new RegExp(
  `(?:https?|wss?|file|customization):\\/\\/[^\\s<>"'\`⟦⟧\\uE000\\uE001\\u3000-\\u303F\\uFF00-\\uFFEF\\u2018-\\u201F${CJK_CHAR}]+`,
  'giu',
);
const RE_WIN_DRIVE = new RegExp(
  `(?<!${NON_CJK_ALNUM}|_)[A-Za-z]:(?:\\\\|\\/)[^${WIN_STOP_CHARS}]*`,
  'gu',
);
const RE_WIN_UNC = new RegExp(
  `(?<!${NON_CJK_ALNUM}|_)\\\\\\\\(?:[?\\\\]\\.?\\\\)?[^${WIN_STOP_CHARS}]+`,
  'gu',
);
const RE_WIN_REL = new RegExp(
  `(?<!${NON_CJK_ALNUM}|[._\\\\/-])(?:\\.\\.?\\\\|(?:(?![${CJK_CHAR}])[\\p{L}\\p{N}._-])+\\\\)[^${WIN_STOP_CHARS}]*`,
  'gu',
);
const LINE_RANGE_OPT = '(?::\\d+(?:-\\d+|:\\d+(?:-\\d+)?)?)?';
const FILE_TRAIL_GUARD = `(?!\\.(?=${NON_CJK_ALNUM}|[_-])|${NON_CJK_ALNUM}|[_/-])`;
const RE_POSIX_ABS = new RegExp(
  `(?<!${NON_CJK_ALNUM}|[_./~])(?:~\\/|\\.\\.?\\/|\\/)[A-Za-z0-9._-]+(?:\\/[A-Za-z0-9._-]+)*\\/?${LINE_RANGE_OPT}`,
  'gu',
);
const RE_POSIX_REL = new RegExp(
  `(?<!${NON_CJK_ALNUM}|[_./-])(?:[A-Za-z0-9_.-]+\\/){2,}(?:[A-Za-z0-9_.-]*[A-Za-z0-9_-])?${LINE_RANGE_OPT}${FILE_TRAIL_GUARD}|(?<!${NON_CJK_ALNUM}|[_./-])[A-Za-z0-9_.-]+\\/[A-Za-z0-9_.-]+\\.[A-Za-z0-9]{1,8}${LINE_RANGE_OPT}${FILE_TRAIL_GUARD}`,
  'gu',
);
const RE_BARE_FILE = new RegExp(
  `(?<!${NON_CJK_ALNUM}|[_./-])[A-Za-z][A-Za-z0-9_-]*(?:\\.[A-Za-z0-9_-]+)*\\.(?:${BARE_FILE_EXTS})${LINE_RANGE_OPT}${FILE_TRAIL_GUARD}`,
  'giu',
);
const RE_UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
const RE_CHANNEL_MENTION = new RegExp(
  `(?<!(?![${CJK_CHAR}])[\\p{L}\\p{N}_-])@#([a-z][a-z0-9-]{0,23})(?!(?![${CJK_CHAR}])[\\p{L}\\p{N}_-])`,
  'giu',
);
const RE_MENTION = new RegExp(
  `(?<!(?![${CJK_CHAR}])[\\p{L}\\p{N}_-])@((?:(?![${CJK_CHAR}])[\\p{L}\\p{N}_-])+)`,
  'gu',
);
const RE_CITATION = new RegExp(
  `(?<!(?![${CJK_CHAR}])[\\p{L}\\p{N}_&#/-])#([1-9]\\d{0,8})(?!(?![${CJK_CHAR}])[\\p{L}\\p{N}_-])`,
  'gu',
);

function escapeRegExp(str) {
  return String(str).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function splitFencedSegments(text) {
  const s = String(text ?? '');
  if (!s) return [];
  const segments = [];
  let plainStart = 0;
  let openFence = null; // { char, len, start }
  let pos = 0;

  while (pos < s.length) {
    const nlIdx = s.indexOf('\n', pos);
    const lineEnd = nlIdx === -1 ? s.length : nlIdx;
    const nextPos = nlIdx === -1 ? s.length : nlIdx + 1;
    const contentEnd = lineEnd > pos && s[lineEnd - 1] === '\r' ? lineEnd - 1 : lineEnd;
    const rawLine = s.slice(pos, contentEnd);

    if (!openFence) {
      const m = /^[ \t]*(`{3,}|~{3,})(.*)$/.exec(rawLine);
      if (m && !(m[1][0] === '`' && m[2].includes('`'))) {
        if (pos > plainStart) {
          segments.push({ fenced: false, text: s.slice(plainStart, pos) });
        }
        openFence = { char: m[1][0], len: m[1].length, start: pos };
      }
    } else {
      const cm = /^[ \t]*(`{3,}|~{3,})[ \t]*$/.exec(rawLine);
      if (cm && cm[1][0] === openFence.char && cm[1].length >= openFence.len) {
        segments.push({ fenced: true, text: s.slice(openFence.start, contentEnd) });
        openFence = null;
        plainStart = contentEnd;
      }
    }
    pos = nextPos;
  }

  if (openFence) {
    segments.push({ fenced: true, text: s.slice(openFence.start) });
  } else if (plainStart < s.length) {
    segments.push({ fenced: false, text: s.slice(plainStart) });
  }

  return segments;
}

const CJK_TRAILING_PUNCT = new Set([
  '。', '，', '；', '：', '！', '？', '、', '】', '》', '」', '』', '”', '’',
]);

function trimUrlTrailing(raw) {
  let end = raw.length;
  let counts = null;
  const initCounts = () => {
    counts = { op: 0, cp: 0, ocp: 0, ccp: 0, ob: 0, cb: 0, oc: 0, cc: 0 };
    for (let i = 0; i < end; i++) {
      switch (raw[i]) {
        case '(': counts.op++; break;
        case ')': counts.cp++; break;
        case '（': counts.ocp++; break;
        case '）': counts.ccp++; break;
        case '[': counts.ob++; break;
        case ']': counts.cb++; break;
        case '{': counts.oc++; break;
        case '}': counts.cc++; break;
      }
    }
  };
  while (end > 0) {
    const c = raw[end - 1];
    if (c === '.' || c === ',' || c === ';' || c === ':' || c === '!' || c === '?' || CJK_TRAILING_PUNCT.has(c)) {
      end--;
      continue;
    }
    if (c === ')' || c === '）' || c === ']' || c === '}') {
      if (!counts) initCounts();
      if (c === ')' && counts.cp > counts.op) { counts.cp--; end--; continue; }
      if (c === '）' && counts.ccp > counts.ocp) { counts.ccp--; end--; continue; }
      if (c === ']' && counts.cb > counts.ob) { counts.cb--; end--; continue; }
      if (c === '}' && counts.cc > counts.oc) { counts.cc--; end--; continue; }
    }
    break;
  }
  return { head: raw.slice(0, end), tail: raw.slice(end) };
}

function trimPathTrailing(raw) {
  let end = raw.length;
  while (end > 0) {
    const c = raw[end - 1];
    if (c === '.' || c === ',' || c === ';' || c === '!' || c === '?') {
      end--;
      continue;
    }
    // Strip trailing ':' unless it is a bare drive root like "C:\" (which ends in '\') or ":line".
    if (c === ':') {
      end--;
      continue;
    }
    break;
  }
  return { head: raw.slice(0, end), tail: raw.slice(end) };
}

function pickPuaDelimiter(input, edgeChar) {
  if (!input.includes(edgeChar)) return edgeChar;
  const used1 = new Set();
  const used2 = new Set();
  let pos = 0;
  while ((pos = input.indexOf(edgeChar, pos)) !== -1) {
    if (pos + 2 < input.length && input[pos + 2] === edgeChar) {
      used1.add(input.charCodeAt(pos + 1));
    }
    if (pos + 3 < input.length && input[pos + 3] === edgeChar) {
      used2.add((input.charCodeAt(pos + 1) << 16) | input.charCodeAt(pos + 2));
    }
    pos++;
  }
  for (let i = 0; i < 254; i++) {
    const code = 0xE002 + i;
    if (!used1.has(code)) return `${edgeChar}${String.fromCharCode(code)}${edgeChar}`;
  }
  for (let i = 0; ; i++) {
    const hi = 0xE002 + (i >> 8);
    const lo = 0xE002 + (i & 0xFF);
    if (!used2.has((hi << 16) | lo)) {
      return `${edgeChar}${String.fromCharCode(hi, lo)}${edgeChar}`;
    }
  }
}

export function maskTechnicalLiterals(text) {
  if (text == null) return { masked: '', tokens: [] };
  const input = String(text);
  if (!input) return { masked: '', tokens: [] };

  // Collision-free internal temporary markers so literal ⟦P0⟧ inside inline/fenced code
  // is never double-masked or buried inside another token.
  const puaOpen = pickPuaDelimiter(input, '\uE000');
  const puaClose = pickPuaDelimiter(input, '\uE001');

  const fenceTokens = [];
  const inlineTokens = [];
  const sentinelTokens = [];
  const restTokens = [];

  const pushFence = (raw) => {
    const id = fenceTokens.length;
    fenceTokens.push(raw);
    return `${puaOpen}F${id}${puaClose}`;
  };
  const pushInline = (raw) => {
    const id = inlineTokens.length;
    inlineTokens.push(raw);
    return `${puaOpen}I${id}${puaClose}`;
  };
  const pushSentinel = (raw) => {
    const id = sentinelTokens.length;
    sentinelTokens.push(raw);
    return `${puaOpen}S${id}${puaClose}`;
  };
  const pushRest = (raw) => {
    const id = restTokens.length;
    restTokens.push(raw);
    return `${puaOpen}R${id}${puaClose}`;
  };

  // 1. Outermost fenced code blocks (closed + unclosed EOF, handles cross-delimiter nesting)
  let s = splitFencedSegments(input)
    .map((seg) => (seg.fenced ? pushFence(seg.text) : seg.text))
    .join('');
  // 2. Inline code spans (supports single, double, and triple backtick spans)
  if (s.includes('`')) s = s.replace(RE_INLINE_CODE, (m) => pushInline(m));
  // 0. Pre-existing sentinel guard (outside code blocks and inline code)
  if (s.includes('⟦')) s = s.replace(RE_SENTINEL, (m) => pushSentinel(m));
  // 3. URLs (with balanced-paren and CJK punctuation trimming)
  if (s.includes('://')) {
    s = s.replace(RE_URL, (m) => {
      const { head, tail } = trimUrlTrailing(m);
      if (!head) return m;
      return pushRest(head) + tail;
    });
  }
  // 4. Windows paths (before UUIDs!)
  const maskWin = (m) => {
    const { head, tail } = trimPathTrailing(m);
    if (!head) return m;
    return pushRest(head) + tail;
  };
  if (s.includes(':')) s = s.replace(RE_WIN_DRIVE, maskWin);
  if (s.includes('\\')) {
    s = s.replace(RE_WIN_UNC, maskWin);
    s = s.replace(RE_WIN_REL, maskWin);
  }
  // 5. POSIX & relative slash paths
  if (s.includes('/')) {
    s = s.replace(RE_POSIX_ABS, (m) => pushRest(m));
    s = s.replace(RE_POSIX_REL, (m) => pushRest(m));
  }
  // 6. Bare filenames with known extensions
  if (s.includes('.')) s = s.replace(RE_BARE_FILE, (m) => pushRest(m));
  // 7. UUIDs
  if (s.includes('-')) s = s.replace(RE_UUID, (m) => pushRest(m));
  // 8. @#channel mentions (before @mention)
  if (s.includes('@')) {
    s = s.replace(RE_CHANNEL_MENTION, (m) => pushRest(m));
    // 9. @mentions
    s = s.replace(RE_MENTION, (m) => pushRest(m));
  }
  // 10. #<seq> citations
  if (s.includes('#')) s = s.replace(RE_CITATION, (m) => pushRest(m));

  const tokens = [...sentinelTokens, ...fenceTokens, ...inlineTokens, ...restTokens];
  if (tokens.length > 0) {
    const fenceOffset = sentinelTokens.length;
    const inlineOffset = fenceOffset + fenceTokens.length;
    const restOffset = inlineOffset + inlineTokens.length;
    const markerRe = new RegExp(`${escapeRegExp(puaOpen)}([SFIR])(\\d+)${escapeRegExp(puaClose)}`, 'g');
    s = s.replace(markerRe, (_m, kind, idxStr) => {
      const idx = Number(idxStr);
      const finalIdx =
        kind === 'S'
          ? idx
          : kind === 'F'
            ? fenceOffset + idx
            : kind === 'I'
              ? inlineOffset + idx
              : restOffset + idx;
      return `⟦P${finalIdx}⟧`;
    });
  }

  return { masked: s, tokens };
}

export function unmaskTechnicalLiterals(translated, tokens) {
  const safeTokens = Array.isArray(tokens) ? tokens : [];
  let s = String(translated ?? '');

  // Normalize minor whitespace/case drift inside ⟦Pn⟧
  if (s.includes('⟦')) s = s.replace(/⟦\s*[Pp]\s*(\d+)\s*⟧/g, '⟦P$1⟧');

  // Optional salvage: if LLM converted ⟦Pn⟧ to 【Pn】 and ⟦Pn⟧ is missing
  if (safeTokens.length > 0 && s.includes('【')) {
    const present = new Set();
    for (const m of s.matchAll(/⟦P(\d+)⟧/g)) {
      present.add(Number(m[1]));
    }
    const altCounts = new Map();
    for (const m of s.matchAll(/【\s*[Pp]\s*(\d+)\s*】/g)) {
      const idx = Number(m[1]);
      altCounts.set(idx, (altCounts.get(idx) || 0) + 1);
    }
    s = s.replace(/【\s*[Pp]\s*(\d+)\s*】/g, (full, idxStr) => {
      const idx = Number(idxStr);
      if (
        Number.isInteger(idx) &&
        idx >= 0 &&
        idx < safeTokens.length &&
        !present.has(idx) &&
        altCounts.get(idx) === 1
      ) {
        return `⟦P${idx}⟧`;
      }
      return full;
    });
  }

  // Validate integrity
  const counts = new Array(safeTokens.length).fill(0);
  let hasOutOfRange = false;
  for (const m of s.matchAll(/⟦P(\d+)⟧/g)) {
    const idx = Number(m[1]);
    if (!Number.isInteger(idx) || idx < 0 || idx >= safeTokens.length) {
      hasOutOfRange = true;
    } else {
      counts[idx]++;
    }
  }
  const intact = !hasOutOfRange && counts.every((c) => c === 1);

  // Callback-based restoration (immune to $$/$1/$&) + boundary repairs
  const peekRe = /⟦P(\d+)⟧/y;
  const parts = [];
  let prevChar = '';
  const appendPart = (chunk) => {
    if (!chunk) return;
    parts.push(chunk);
    prevChar = chunk[chunk.length - 1];
  };
  let lastIdx = 0;
  for (const m of s.matchAll(/⟦P(\d+)⟧/g)) {
    const offset = m.index;
    const matchStr = m[0];
    appendPart(s.slice(lastIdx, offset));
    lastIdx = offset + matchStr.length;

    const idx = Number(m[1]);
    if (!Number.isInteger(idx) || idx < 0 || idx >= safeTokens.length) {
      appendPart(matchStr);
      continue;
    }

    let tok = String(safeTokens[idx]);
    let nextChar = lastIdx < s.length ? s[lastIdx] : '';

    // Peek through an immediately adjacent placeholder to know its leading char
    if (nextChar === '⟦') {
      peekRe.lastIndex = lastIdx;
      const nm = peekRe.exec(s);
      if (nm) {
        const nIdx = Number(nm[1]);
        if (Number.isInteger(nIdx) && nIdx >= 0 && nIdx < safeTokens.length) {
          nextChar = String(safeTokens[nIdx])[0] || '';
        }
      }
    }

    // Fenced code block newline repair (only for multi-line blocks)
    if (/^[ \t]*(?:```|~~~)/.test(tok) && tok.includes('\n')) {
      if (prevChar && prevChar !== '\n') tok = '\n' + tok;
      if (nextChar && nextChar !== '\n' && nextChar !== '\r') tok = tok + '\n';
      appendPart(tok);
      continue;
    }

    // @mention / @#channel CJK-boundary spacing repair
    if (tok.startsWith('@')) {
      if (prevChar && /[\p{L}\p{N}_-]/u.test(prevChar)) tok = ' ' + tok;
      if (nextChar && /[\p{L}\p{N}_-]/u.test(nextChar)) tok = tok + ' ';
      appendPart(tok);
      continue;
    }

    // #<seq> CJK-boundary spacing repair
    if (/^#[1-9]\d{0,8}$/.test(tok)) {
      if (prevChar && /[\p{L}\p{N}_&#/-]/u.test(prevChar)) tok = ' ' + tok;
      if (nextChar && /[\p{L}\p{N}_-]/u.test(nextChar)) tok = tok + ' ';
      appendPart(tok);
      continue;
    }

    appendPart(tok);
  }
  appendPart(s.slice(lastIdx));

  return { text: parts.join(''), intact };
}

const RE_TIER1_TAGS = /\[(?:已完成|停滞告警|额度告警|阻塞|频道)\]/g;

export function isPredominantlyChinese(text) {
  if (typeof text !== 'string' || !text.trim()) return false;
  // Strip technical literals via maskTechnicalLiterals + strip placeholders & Tier-1 tags
  const { masked } = maskTechnicalLiterals(text);
  const stripped = masked
    .replace(/⟦P\d+⟧/g, ' ')
    .replace(RE_TIER1_TAGS, ' ');

  const cjkCount = (stripped.match(/\p{Script=Han}/gu) || []).length;
  if (cjkCount === 0) return false;
  const latinChars = (stripped.match(/[A-Za-z]/g) || []).length;
  if (latinChars === 0) return true;
  const ratio = cjkCount / (cjkCount + latinChars);
  if (ratio >= 0.35) return true;
  const latinWords = (stripped.match(/[A-Za-z]{2,}/g) || []).length;
  return cjkCount >= 3 && latinWords <= 1 && ratio >= 0.2;
}

function needsLlmTranslation(maskedText) {
  if (typeof maskedText !== 'string') return false;
  const trimmed = maskedText.trim();
  if (!trimmed) return false;

  // Single whitespace-free code identifier (snake_case, ::, camelCase)
  if (
    /^[A-Za-z_][A-Za-z0-9_.-]*$/.test(trimmed) &&
    (trimmed.includes('_') || trimmed.includes('::') || /[a-z][A-Z]/.test(trimmed))
  ) {
    return false;
  }

  const withoutTokens = trimmed.replace(/⟦P\d+⟧/g, ' ').replace(RE_TIER1_TAGS, ' ');
  const stripped = withoutTokens.replace(/[\d\s#*_`~>\-|.,:;!?()[\]{}'"/\\+=]+/g, ' ').trim();
  if (!/[A-Za-z]{2,}|\p{Script=Han}/u.test(stripped)) return false;
  if (isPredominantlyChinese(withoutTokens)) return false;

  // If only single-word/short code identifiers remain without spaces (e.g. "foo_bar")
  const words = stripped.split(/\s+/).filter(Boolean);
  if (
    words.length === 1 &&
    /^[A-Za-z_][A-Za-z0-9_.-]*$/.test(words[0]) &&
    (words[0].includes('_') || /[a-z][A-Z]/.test(words[0]))
  ) {
    return false;
  }

  return /[A-Za-z]{2,}/.test(stripped);
}

// ---------------------------------------------------------------------------
// F2: Tier-1 Deterministic Rules
// ---------------------------------------------------------------------------

const EXACT_STRINGS = new Map([
  ['Waiting for posts', '正在等待新消息'],
  ['Reading the board', '正在读取看板'],
  ['Posting to the board', '正在发布到看板'],
  ['model error', '模型调用错误'],
  ['step failed', '步骤执行失败'],
  ['Coordinator', '协调者'],
  ['Narrator', '播报员'],
  ['Monitor', '监控员'],
  ['Retired', '已停用'],
  ['No posts yet', '暂无消息'],
  ['Untitled swarm', '未命名集群'],
  ['Waiting for the first post.', '等待首条消息。'],
  ['In progress', '进行中'],
  ['Done', '已完成'],
  ['Active', '活跃'],
  ['Waiting', '等待中'],
  ['Working', '工作中'],
  ['Stuck', '停滞'],
  ['Error', '错误'],
  ['Task', '任务'],
  ['Tasks', '任务列表'],
  ['Other', '其他'],
  ['The coordinator is waiting for your reply', '协调者正在等待你的回复'],
  ['Answer it in the coordinator chat.', '请在协调者对话中回复。'],
  ['Waiting for your reply in chat', '等待你在对话中回复'],
  ['Remote', '远程'],
  ['swarm watcher exited', '集群监听器已退出'],
]);

const BARE_TOOLS = new Map([
  ['read_file', '读取文件'],
  ['view_file', '读取文件'],
  ['write_file', '写入文件'],
  ['write_to_file', '写入文件'],
  ['edit_file', '编辑文件'],
  ['replace_file_content', '编辑文件'],
  ['multi_replace_file_content', '编辑文件'],
  ['run_command', '执行命令'],
  ['command_status', '查看命令状态'],
  ['send_command_input', '向命令发送输入'],
  ['read_terminal', '读取终端输出'],
  ['grep_search', '搜索文本内容'],
  ['find_by_name', '按名称查找文件'],
  ['list_dir', '列出目录内容'],
  ['code_search', '搜索代码'],
  ['search_web', '搜索网络资料'],
  ['read_url_content', '读取网页内容'],
  ['call_mcp_tool', '调用 MCP 工具'],
  ['list_resources', '列出 MCP 资源'],
  ['read_resource', '读取 MCP 资源'],
  ['invoke_subagent', '调度子智能体'],
  ['manage_task', '管理后台任务'],
  ['schedule', '设置定时任务'],
  ['send_message', '发送协同消息'],
  ['swarm_wait', '等待看板新消息'],
  ['read_board', '读取看板'],
  ['post_message', '发布到看板'],
  ['swarm', '管理集群'],
]);

const TOOL_SUMMARIES = new Map([
  ['unit test execution', '执行单元测试'],
  ['git status check', '检查 Git 状态'],
  ['package build', '构建软件包'],
  ['dev server startup', '启动开发服务器'],
  ['running tests', '运行测试'],
  ['verifying changes', '验证改动'],
  ['checking board', '检查看板'],
  ['checking swarm status', '检查集群状态'],
  ['analyzing code', '分析代码'],
  ['synthesizing findings', '汇总调查结果'],
]);

const SWARM_ACTIONS = new Map([
  ['status', '查看集群状态'],
  ['models', '查看可用模型'],
  ['add', '添加成员'],
  ['model', '切换成员模型'],
  ['kill', '停止成员'],
  ['title', '设置集群标题'],
  ['channel', '管理集群频道'],
]);

const QUOTA_ERR_RE = /RESOURCE_EXHAUSTED|quota|\b429\b|exhausted your capacity|rate.?limit/i;

const CHANNEL_TOKEN_PATTERN = '[^\\s()（）:：—]+';
const CHANNEL_TOPIC_SUFFIX_PATTERN =
  '(?:[ \\t]*[:：—][ \\t]*(\\S[^\\r\\n]*)|[ \\t]+-[ \\t]+(\\S[^\\r\\n]*)|[ \\t]*\\(([^\\r\\n]*)\\)|[ \\t]*（([^\\r\\n]*)）)?';
const CHANNEL_CREATE_ACTOR_RE = new RegExp(
  `^(?:(?!created\\b)([^\\s#()（）:：—]+)[ \\t]+)?created[ \\t]+(?:#)?(${CHANNEL_TOKEN_PATTERN})(?:[ \\t]+by[ \\t]+(${CHANNEL_TOKEN_PATTERN}))?${CHANNEL_TOPIC_SUFFIX_PATTERN}$`,
  'i',
);
const CHANNEL_CREATE_POSTFIX_RE = new RegExp(
  `^#(${CHANNEL_TOKEN_PATTERN})[ \\t]+created(?:[ \\t]+by[ \\t]+(${CHANNEL_TOKEN_PATTERN}))?${CHANNEL_TOPIC_SUFFIX_PATTERN}$`,
  'i',
);
const CHANNEL_ARCHIVE_ACTOR_RE = new RegExp(
  `^(?:(?!archived\\b)([^\\s#()（）:：—]+)[ \\t]+)?archived[ \\t]+(?:#)?(${CHANNEL_TOKEN_PATTERN})(?:[ \\t]+by[ \\t]+(${CHANNEL_TOKEN_PATTERN}))?${CHANNEL_TOPIC_SUFFIX_PATTERN}$`,
  'i',
);
const CHANNEL_ARCHIVE_POSTFIX_RE = new RegExp(
  `^#(${CHANNEL_TOKEN_PATTERN})[ \\t]+archived(?:[ \\t]+by[ \\t]+(${CHANNEL_TOKEN_PATTERN}))?${CHANNEL_TOPIC_SUFFIX_PATTERN}$`,
  'i',
);
const CHANNEL_SUB_TAIL_RE = new RegExp(`(?<=\\S)[ \\t]+to[ \\t]+(?:#)?(${CHANNEL_TOKEN_PATTERN})$`, 'i');
const CHANNEL_SUB_VERB_PREFIX_RE = /^(?:subscribed|added)[ \t]+(\S[^\r\n]*)$/i;
const CHANNEL_SUB_ACTOR_PREFIX_RE = /^(\S+)[ \t]+(?:subscribed|added)[ \t]+(\S[^\r\n]*)$/i;
const CHANNEL_SUB_SUBJECT_TAIL_RE = /(?<=\S)[ \t]+subscribed$/i;
const CHANNEL_UNSUB_TAIL_RE = new RegExp(`(?<=\\S)[ \\t]+from[ \\t]+(?:#)?(${CHANNEL_TOKEN_PATTERN})$`, 'i');
const CHANNEL_UNSUB_VERB_PREFIX_RE = /^(?:unsubscribed|removed)[ \t]+(\S[^\r\n]*)$/i;
const CHANNEL_UNSUB_ACTOR_PREFIX_RE = /^(\S+)[ \t]+(?:unsubscribed|removed)[ \t]+(\S[^\r\n]*)$/i;
const CHANNEL_UNSUB_SUBJECT_TAIL_RE = /(?<=\S)[ \t]+unsubscribed$/i;
const CHANNEL_JOINED_RE = new RegExp(`^(\\S+)[ \\t]+joined[ \\t]+(?:#)?(${CHANNEL_TOKEN_PATTERN})$`, 'i');
const CHANNEL_LEFT_RE = new RegExp(`^(\\S+)[ \\t]+left[ \\t]+(?:#)?(${CHANNEL_TOKEN_PATTERN})$`, 'i');
const CHANNEL_RENAME_RE = new RegExp(
  `^(?:(?!renamed\\b)(\\S+)[ \\t]+)?renamed[ \\t]+(?:#)?(${CHANNEL_TOKEN_PATTERN})[ \\t]+(?:to|->|→)[ \\t]+(?:#)?(${CHANNEL_TOKEN_PATTERN})$`,
  'i',
);
const CHANNEL_TOPIC_OF_RE = new RegExp(
  `^(?:(?!(?:set|updated|changed)\\b)(\\S+)[ \\t]+)?(?:set|updated|changed)[ \\t]+(?:the[ \\t]+)?topic[ \\t]+(?:of|for)[ \\t]+(?:#)?(${CHANNEL_TOKEN_PATTERN})(?:[ \\t]+(?:to|as)|[ \\t]*[:：—])[ \\t]*(\\S[^\\r\\n]*)$`,
  'i',
);
const CHANNEL_TOPIC_CH_RE = new RegExp(
  `^(?:(?!(?:set|updated|changed)\\b)(\\S+)[ \\t]+)?(?:set|updated|changed)[ \\t]+(?:#)?(${CHANNEL_TOKEN_PATTERN})[ \\t]+topic(?:[ \\t]+(?:to|as)|[ \\t]*[:：—])[ \\t]*(\\S[^\\r\\n]*)$`,
  'i',
);
const CHANNEL_TOPIC_SHORT_RE = new RegExp(
  `^(?:(?!(?:set|updated|changed|topic)\\b)(\\S+)[ \\t]+)?#(${CHANNEL_TOKEN_PATTERN})[ \\t]+topic(?:[ \\t]+(?:to|as)|[ \\t]*[:：—])[ \\t]*(\\S[^\\r\\n]*)$`,
  'i',
);
const CHANNEL_TOPIC_COLON_RE = new RegExp(
  `^(?:(?!(?:set|updated|changed|topic)\\b)(\\S+)[ \\t]+)?topic[ \\t]+(?:of[ \\t]+|for[ \\t]+)?(?:#)?(${CHANNEL_TOKEN_PATTERN})[ \\t]*[:：—][ \\t]*(\\S[^\\r\\n]*)$`,
  'i',
);

function formatChannelTopicSuffix(colonTopic, dashTopic, parenTopic, cjkParenTopic) {
  if (colonTopic !== undefined) {
    const t = colonTopic.trim();
    return t ? `：${t}` : '';
  }
  if (dashTopic !== undefined) {
    const t = dashTopic.trim();
    return t ? `：${t}` : '';
  }
  const p = parenTopic !== undefined ? parenTopic : cjkParenTopic;
  if (p !== undefined) {
    const t = p.trim();
    return t ? `（${t}）` : '';
  }
  return '';
}

function translateChannelControlBody(body) {
  const b = body.trim();
  if (/[\r\n]/.test(b)) return { text: b, matched: false };
  let m;
  if (/\bcreated\b/i.test(b)) {
    if ((m = CHANNEL_CREATE_ACTOR_RE.exec(b))) {
      const [, actor, ch, by, colonT, dashT, parenT, cjkParenT] = m;
      let out = actor ? `${actor} 创建了频道 #${ch}` : by ? `由 ${by} 创建了频道 #${ch}` : `创建了频道 #${ch}`;
      out += formatChannelTopicSuffix(colonT, dashT, parenT, cjkParenT);
      return { text: out, matched: true };
    }
    if ((m = CHANNEL_CREATE_POSTFIX_RE.exec(b))) {
      const [, ch, by, colonT, dashT, parenT, cjkParenT] = m;
      let out = by ? `由 ${by} 创建了频道 #${ch}` : `创建了频道 #${ch}`;
      out += formatChannelTopicSuffix(colonT, dashT, parenT, cjkParenT);
      return { text: out, matched: true };
    }
  }
  if (/\barchived\b/i.test(b)) {
    if ((m = CHANNEL_ARCHIVE_ACTOR_RE.exec(b))) {
      const [, actor, ch, by, colonT, dashT, parenT, cjkParenT] = m;
      let out = actor ? `${actor} 归档了频道 #${ch}` : by ? `由 ${by} 归档了频道 #${ch}` : `归档了频道 #${ch}`;
      out += formatChannelTopicSuffix(colonT, dashT, parenT, cjkParenT);
      return { text: out, matched: true };
    }
    if ((m = CHANNEL_ARCHIVE_POSTFIX_RE.exec(b))) {
      const [, ch, by, colonT, dashT, parenT, cjkParenT] = m;
      let out = by ? `由 ${by} 归档了频道 #${ch}` : `归档了频道 #${ch}`;
      out += formatChannelTopicSuffix(colonT, dashT, parenT, cjkParenT);
      return { text: out, matched: true };
    }
  }
  if (/\b(?:subscribed|added)\b/i.test(b) && (m = CHANNEL_SUB_TAIL_RE.exec(b))) {
    const prefix = b.slice(0, m.index);
    const ch = m[1];
    if (!/[\r\n]/.test(prefix)) {
      let pm;
      if ((pm = CHANNEL_SUB_VERB_PREFIX_RE.exec(prefix))) {
        return { text: `将 ${pm[1].trim()} 订阅到频道 #${ch}`, matched: true };
      }
      if ((pm = CHANNEL_SUB_ACTOR_PREFIX_RE.exec(prefix))) {
        return { text: `${pm[1]} 将 ${pm[2].trim()} 订阅到频道 #${ch}`, matched: true };
      }
      if ((pm = CHANNEL_SUB_SUBJECT_TAIL_RE.exec(prefix))) {
        return { text: `${prefix.slice(0, pm.index)} 订阅了频道 #${ch}`, matched: true };
      }
    }
  }
  if (/\b(?:unsubscribed|removed)\b/i.test(b) && (m = CHANNEL_UNSUB_TAIL_RE.exec(b))) {
    const prefix = b.slice(0, m.index);
    const ch = m[1];
    if (!/[\r\n]/.test(prefix)) {
      let pm;
      if ((pm = CHANNEL_UNSUB_VERB_PREFIX_RE.exec(prefix))) {
        return { text: `将 ${pm[1].trim()} 移出频道 #${ch}`, matched: true };
      }
      if ((pm = CHANNEL_UNSUB_ACTOR_PREFIX_RE.exec(prefix))) {
        return { text: `${pm[1]} 将 ${pm[2].trim()} 移出频道 #${ch}`, matched: true };
      }
      if ((pm = CHANNEL_UNSUB_SUBJECT_TAIL_RE.exec(prefix))) {
        return { text: `${prefix.slice(0, pm.index)} 退出了频道 #${ch}`, matched: true };
      }
    }
  }
  if (/\bjoined\b/i.test(b) && (m = CHANNEL_JOINED_RE.exec(b))) {
    return { text: `${m[1]} 加入了频道 #${m[2]}`, matched: true };
  }
  if (/\bleft\b/i.test(b) && (m = CHANNEL_LEFT_RE.exec(b))) {
    return { text: `${m[1]} 退出了频道 #${m[2]}`, matched: true };
  }
  if (/\brenamed\b/i.test(b) && (m = CHANNEL_RENAME_RE.exec(b))) {
    const actor = m[1] ? `${m[1]} ` : '';
    return { text: `${actor}将频道 #${m[2]} 重命名为 #${m[3]}`, matched: true };
  }
  if (/\btopic\b/i.test(b)) {
    if ((m = CHANNEL_TOPIC_OF_RE.exec(b))) {
      const actor = m[1] ? `${m[1]} ` : '';
      return { text: `${actor}将频道 #${m[2]} 的主题更新为：${m[3].trim()}`, matched: true };
    }
    if ((m = CHANNEL_TOPIC_CH_RE.exec(b))) {
      const actor = m[1] ? `${m[1]} ` : '';
      return { text: `${actor}将频道 #${m[2]} 的主题更新为：${m[3].trim()}`, matched: true };
    }
    if ((m = CHANNEL_TOPIC_SHORT_RE.exec(b))) {
      const actor = m[1] ? `${m[1]} ` : '';
      return { text: `${actor}将频道 #${m[2]} 的主题更新为：${m[3].trim()}`, matched: true };
    }
    if ((m = CHANNEL_TOPIC_COLON_RE.exec(b))) {
      const actor = m[1] ? `${m[1]} ` : '';
      return { text: `${actor}将频道 #${m[2]} 的主题更新为：${m[3].trim()}`, matched: true };
    }
  }
  return { text: b, matched: false };
}

function applyClausePrefixes(text) {
  // Line-start / clause-start headers and verdict tokens (never mid-sentence)
  const HEADER_MAP = {
    verdict: '结论：',
    status: '状态：',
    summary: '摘要：',
    result: '结果：',
    decision: '决策：',
    'action required': '需要处理：',
    error: '错误：',
    warning: '警告：',
  };
  const VERDICT_MAP = {
    PASS: '通过',
    PASSED: '通过',
    '[PASS]': '[通过]',
    FAIL: '未通过',
    FAILED: '未通过',
    '[FAIL]': '[未通过]',
    APPROVE: '批准通过',
    APPROVED: '批准通过',
    REQUEST_CHANGES: '请求修改',
    CHANGES_REQUESTED: '请求修改',
    REJECTED: '已拒绝',
    PARTIAL: '部分通过',
    BLOCKED: '阻塞',
  };

  const leadPrefixRe =
    /^([ \t]*(?:(?:@#?[A-Za-z0-9_.-]+[,:]?\s+)|(?:\[(?:已完成|停滞告警|额度告警|阻塞|频道)\]\s*)|(?:\*\*|__|- |\* ))*)(Verdict|Status|Summary|Result|Decision|Action Required|Error|Warning)((?:\*\*|__)?)\s*:(.*)$/i;
  const leadVerdictRe =
    /^([ \t]*(?:(?:@#?[A-Za-z0-9_.-]+[,:]?\s+)|(?:\[(?:已完成|停滞告警|额度告警|阻塞|频道)\]\s*)|(?:(?:结论|状态|摘要|结果|决策|需要处理|错误|警告)(?:\*\*|__)?：\s*)|(?:\*\*|__|- |\* )\s*)*)(\[?(?:PASS|PASSED|FAIL|FAILED)\]?|APPROVE|APPROVED|REQUEST_CHANGES|CHANGES_REQUESTED|REJECTED|PARTIAL|BLOCKED)(?=\s*(?:[:：—–.,;!?()\[\]，。；！？（）【】]|$|\*\*|__))/;

  return text
    .split('\n')
    .map((line) => {
      let l = line;
      const hm = leadPrefixRe.exec(l);
      if (hm) {
        const mapped = HEADER_MAP[hm[2].toLowerCase()];
        if (mapped) {
          const boldClose = hm[3] || '';
          const headerText = boldClose ? `${mapped.replace(/：$/, '')}${boldClose}：` : mapped;
          l = `${hm[1]}${headerText}${hm[4].replace(/^[ \t]+/, '')}`;
        }
      }
      const vm = leadVerdictRe.exec(l);
      if (vm) {
        const mapped = VERDICT_MAP[vm[2]];
        if (mapped) {
          l = `${vm[1]}${mapped}${l.slice(vm[1].length + vm[2].length)}`;
        }
      }
      return l;
    })
    .join('\n');
}

function finalizeTier1(out, exactMatch) {
  if (exactMatch) return { text: out, fullyTranslated: true };
  if (!out.trim()) return { text: out, fullyTranslated: true };
  if (isPredominantlyChinese(out)) return { text: out, fullyTranslated: true };
  const { masked } = maskTechnicalLiterals(out);
  if (!needsLlmTranslation(masked)) return { text: out, fullyTranslated: true };
  return { text: out, fullyTranslated: false };
}

export function applyTier1Rules(text, kind = 'text') {
  if (text == null) return { text: '', fullyTranslated: true };
  const raw = String(text);
  const trimmed = raw.trim();
  if (!trimmed) return { text: raw, fullyTranslated: true };

  // 1. Exact string match
  if (EXACT_STRINGS.has(trimmed)) {
    return { text: EXACT_STRINGS.get(trimmed), fullyTranslated: true };
  }

  // 2. systemAttention & hive.js attention titles
  let m;
  if ((m = /^([^\s:]+):\s*last step failed\s*\((quota|error)\)$/i.exec(trimmed))) {
    const reason = m[2].toLowerCase() === 'quota' ? '额度耗尽' : '出错';
    return { text: `${m[1]}：上一步执行失败（${reason}）`, fullyTranslated: true };
  }
  if ((m = /^([^\s:]+):\s*no progress,\s*and not waiting on the board$/i.exec(trimmed))) {
    return { text: `${m[1]}：长时间无进展，且未在看板等待`, fullyTranslated: true };
  }
  if ((m = /^@([^\s]+)\s+ran out of quota$/i.exec(trimmed))) {
    return { text: `@${m[1]} 额度已耗尽`, fullyTranslated: true };
  }
  if ((m = /^@([^\s]+)\s+looks stuck$/i.exec(trimmed))) {
    return { text: `@${m[1]} 疑似停滞`, fullyTranslated: true };
  }
  if ((m = /^@([^\s]+)\s+hit an error$/i.exec(trimmed))) {
    return { text: `@${m[1]} 发生错误`, fullyTranslated: true };
  }

  // 3. Activity & describeToolCall rules
  if (kind === 'activity' || kind === 'text' || !kind) {
    if (BARE_TOOLS.has(trimmed)) {
      return { text: BARE_TOOLS.get(trimmed), fullyTranslated: true };
    }
    const lowerTrim = trimmed.toLowerCase();
    if (TOOL_SUMMARIES.has(lowerTrim)) {
      return { text: TOOL_SUMMARIES.get(lowerTrim), fullyTranslated: true };
    }
    if ((m = /^swarm[ \t]+(status|models|add|model|kill|title|channel)(?:[ \t]+(\S[^\r\n]*))?$/i.exec(trimmed))) {
      const act = SWARM_ACTIONS.get(m[1].toLowerCase());
      const rest = m[2] ? ` ${m[2].trim()}` : '';
      return { text: `${act}${rest}`, fullyTranslated: true };
    }
    if ((m = /^(Read|Write|Edit)[ \t]+(\S+)$/.exec(trimmed))) {
      const target = m[2].trim();
      const isSafeFileTarget =
        !/\s/.test(target) &&
        (kind === 'activity' ? /[./\\]/.test(target) || /^[A-Za-z0-9_.-]+$/.test(target) : /[./\\]/.test(target));
      if (isSafeFileTarget) {
        const verb = { Read: '读取', Write: '写入', Edit: '编辑' }[m[1]];
        return { text: `${verb} ${target}`, fullyTranslated: true };
      }
    }
    if (kind === 'activity' && (m = /^Search[ \t]+(\S[^\r\n]*)$/.exec(trimmed))) {
      return { text: `搜索 ${m[1].trim()}`, fullyTranslated: true };
    }
  }

  // 4. Failure rules (POSIX / HTTP / quota)
  if (kind === 'failure') {
    let f = trimmed;
    let changed = false;
    const errMap = [
      [/\bECONNREFUSED\b/g, '连接被拒绝 (ECONNREFUSED)'],
      [/\bETIMEDOUT\b/g, '请求超时 (ETIMEDOUT)'],
      [/\bENOENT\b/g, '文件或路径不存在 (ENOENT)'],
      [/\b(?:EPERM|EACCES)\b/g, (tok) => `权限不足 (${tok})`],
    ];
    for (const [re, rep] of errMap) {
      if (re.test(f)) {
        f = f.replace(re, rep);
        changed = true;
      }
    }
    if (QUOTA_ERR_RE.test(trimmed)) {
      if (!f.startsWith('额度耗尽')) {
        f = `额度耗尽或触发限流：${f}`;
      }
      // If remaining English words (outside known tokens) are short, treat as fully translated
      const remainingWords = trimmed
        .replace(/RESOURCE_EXHAUSTED|quota|429|HTTP|rate.?limit|error|status/gi, '')
        .match(/[A-Za-z]{2,}/g);
      return { text: f, fullyTranslated: !remainingWords || remainingWords.length <= 3 };
    }
    if (changed) return finalizeTier1(f, false);
  }

  // 5. Swarm control / protocol tags & resume
  let out = raw;

  // resume command
  if ((m = /^(\s*(?:@#?[A-Za-z0-9_.-]+[,:]?\s+)+)resume\b([.!]?)$/i.exec(trimmed))) {
    return { text: `${m[1].replace(/\s+/g, ' ').trimStart()}恢复运行${m[2]}`, fullyTranslated: true };
  }
  if ((m = /^resume\b([.!]?)$/i.exec(trimmed))) {
    return { text: `恢复运行${m[1]}`, fullyTranslated: true };
  }

  // Leading @mentions / @#channel + optional markdown wrapper + [done|stall|quota|blocked|channel]
  const tagRe = /^(\s*(?:@#?[A-Za-z0-9_.-]+[,:]?\s*)*)((?:\*\*|\*|`)?)\[(done|stall|quota|blocked|channel)\]((?:\*\*|\*|`)?)([\s\S]*)$/i;
  const tm = tagRe.exec(out);
  if (tm) {
    const lead = tm[1];
    const openFmt = tm[2];
    const tag = tm[3].toLowerCase();
    const closeFmt = tm[4];
    const rest = tm[5];

    const tagZhMap = {
      done: '[已完成]',
      stall: '[停滞告警]',
      quota: '[额度告警]',
      blocked: '[阻塞]',
      channel: '[频道]',
    };
    const tagZh = tagZhMap[tag];

    if (tag === 'channel' || kind === 'control') {
      const ctrl = translateChannelControlBody(rest);
      const formatted = `${lead}${openFmt}${tagZh}${closeFmt}${ctrl.text ? ' ' + ctrl.text : ''}`.trim();
      if (ctrl.matched || kind === 'control') {
        return finalizeTier1(formatted, ctrl.matched);
      }
      out = formatted;
    } else if (tag === 'stall') {
      const stallPing = /^\s*(#[1-9]\d{0,8})\s+is for you\.?\s*$/i.exec(rest);
      if (stallPing && lead.trim()) {
        return {
          text: `${lead.trim()} ${openFmt}${tagZh}${closeFmt} ${stallPing[1]} 是发给你的，请处理。`,
          fullyTranslated: true,
        };
      }
      out = `${lead}${openFmt}${tagZh}${closeFmt}${rest}`;
    } else {
      out = `${lead}${openFmt}${tagZh}${closeFmt}${rest}`;
    }
  } else if (kind === 'control') {
    const ctrl = translateChannelControlBody(trimmed);
    if (ctrl.matched) return { text: ctrl.text, fullyTranslated: true };
  }

  // Protect fenced code blocks from Screenshot: and line-start verdict/label mutations
  out = splitFencedSegments(out)
    .map((seg) => {
      if (seg.fenced) return seg.text;
      let part = seg.text.replace(/(?<=^|\n)([ \t]*(?:[-*][ \t]*)?)Screenshot:[ \t]*/gim, '$1截图：');
      part = applyClausePrefixes(part);
      return part;
    })
    .join('');

  return finalizeTier1(out, false);
}

// ---------------------------------------------------------------------------
// F3: Optional Explicit Async LLM Queue & Atomic LRU Cache (Offline by Default)
// ---------------------------------------------------------------------------

function splitMaskedIntoChunks(text, maxChars = LONG_MESSAGE_CHUNK_MAX_CHARS) {
  const s = String(text ?? '');
  if (s.length <= maxChars) return [{ text: s, sep: '' }];
  const rawTokens = s.split(/(\r?\n[ \t]*\r?\n+)/);
  const units = [];
  for (let i = 0; i < rawTokens.length; i += 2) {
    const part = rawTokens[i] || '';
    const sep = rawTokens[i + 1] || '';
    if (part.length <= maxChars) {
      units.push({ text: part, sep });
    } else {
      const lineTokens = part.split(/(\r?\n)/);
      for (let j = 0; j < lineTokens.length; j += 2) {
        const line = lineTokens[j] || '';
        const lSep = j + 2 < lineTokens.length ? (lineTokens[j + 1] || '') : sep;
        units.push({ text: line, sep: lSep });
      }
    }
  }
  const chunks = [];
  let hasCur = false;
  let curText = '';
  let curSep = '';
  for (const u of units) {
    if (!hasCur) {
      curText = u.text;
      curSep = u.sep;
      hasCur = true;
    } else if (curText.length + curSep.length + u.text.length <= maxChars) {
      curText += curSep + u.text;
      curSep = u.sep;
    } else {
      chunks.push({ text: curText, sep: curSep });
      curText = u.text;
      curSep = u.sep;
    }
  }
  if (hasCur) chunks.push({ text: curText, sep: curSep });
  return chunks.length ? chunks : [{ text: s, sep: '' }];
}

function normalizeAndValidateChunkPlaceholders(sourceChunk, translatedChunk, tokenCount) {
  let out = String(translatedChunk ?? '');
  if (out.includes('⟦')) out = out.replace(/⟦\s*[Pp]\s*(\d+)\s*⟧/g, '⟦P$1⟧');

  const expected = new Map();
  for (const m of String(sourceChunk ?? '').matchAll(/⟦P(\d+)⟧/g)) {
    const idx = Number(m[1]);
    expected.set(idx, (expected.get(idx) || 0) + 1);
  }
  if (expected.size > 0 && out.includes('【')) {
    const present = new Set();
    for (const m of out.matchAll(/⟦P(\d+)⟧/g)) present.add(Number(m[1]));
    const altCounts = new Map();
    for (const m of out.matchAll(/【\s*[Pp]\s*(\d+)\s*】/g)) {
      const idx = Number(m[1]);
      altCounts.set(idx, (altCounts.get(idx) || 0) + 1);
    }
    out = out.replace(/【\s*[Pp]\s*(\d+)\s*】/g, (full, idxStr) => {
      const idx = Number(idxStr);
      if (expected.has(idx) && !present.has(idx) && altCounts.get(idx) === expected.get(idx)) {
        return `⟦P${idx}⟧`;
      }
      return full;
    });
  }

  const actual = new Map();
  for (const m of out.matchAll(/⟦P(\d+)⟧/g)) {
    const idx = Number(m[1]);
    if (!Number.isInteger(idx) || idx < 0 || idx >= tokenCount) {
      return { text: out, intact: false };
    }
    actual.set(idx, (actual.get(idx) || 0) + 1);
  }
  if (actual.size !== expected.size) return { text: out, intact: false };
  for (const [idx, count] of expected.entries()) {
    if (actual.get(idx) !== count) return { text: out, intact: false };
  }
  return { text: out, intact: true };
}

function sha256(s) {
  return createHash('sha256').update(s, 'utf-8').digest('hex');
}

function makeCacheKey(text, kind = 'text') {
  const prefix = kind && kind !== 'text' ? `${kind}|` : '';
  return sha256(`${prefix}${String(text).trim()}|${PROMPT_VERSION}`);
}

function scrubSecrets(str, extraSecret = '') {
  let out = String(str ?? '');
  if (extraSecret) {
    out = out.split(extraSecret).join('[REDACTED]');
  }
  out = out.replace(/Bearer\s+\S+/gi, 'Bearer [REDACTED]');
  return out;
}

function resolveDefaultCachePath(options) {
  if (options.cachePath === null) return null;
  if (typeof options.cachePath === 'string' && options.cachePath) return options.cachePath;
  if (process.env.AGY_SWARM_TRANSLATE_CACHE_PATH) return process.env.AGY_SWARM_TRANSLATE_CACHE_PATH;
  if (process.env.ANTIGRAVITY_EXECUTABLE_DATA_DIR) {
    return join(process.env.ANTIGRAVITY_EXECUTABLE_DATA_DIR, 'translation_cache.json');
  }
  return join(homedir(), '.gemini', 'antigravity', 'sidecar_data', 'swarm', 'swarm_board', 'data', 'translation_cache.json');
}

function sleep(ms, signal) {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const t = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    t.unref?.();
    function onAbort() {
      clearTimeout(t);
      resolve();
    }
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

export function createTranslator(options = {}) {
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const logger = options.logger || null;
  const cachePath = resolveDefaultCachePath(options);
  const maxEntries = Number.isFinite(options.maxEntries) && options.maxEntries > 0 ? options.maxEntries : DEFAULT_MAX_ENTRIES;
  const concurrency = Math.max(1, Number.isFinite(options.concurrency) ? options.concurrency : DEFAULT_CONCURRENCY);
  const envTimeoutRaw = process.env.AGY_SWARM_TRANSLATE_TIMEOUT_MS;
  const envTimeout = envTimeoutRaw !== undefined && envTimeoutRaw !== '' ? Number(envTimeoutRaw) : NaN;
  const requestTimeoutMs = Number.isFinite(options.requestTimeoutMs) && options.requestTimeoutMs > 0
    ? options.requestTimeoutMs
    : (Number.isFinite(envTimeout) && envTimeout > 0 ? envTimeout : DEFAULT_TIMEOUT_MS);
  const envBackoffRaw = process.env.AGY_SWARM_TRANSLATE_BACKOFF_MS;
  const envBackoff = envBackoffRaw !== undefined && envBackoffRaw !== '' ? Number(envBackoffRaw) : NaN;
  const baseBackoffMs = Number.isFinite(options.baseBackoffMs) && options.baseBackoffMs >= 0
    ? options.baseBackoffMs
    : (Number.isFinite(envBackoff) && envBackoff >= 0 ? envBackoff : DEFAULT_BASE_BACKOFF_MS);
  const envCooldownRaw = process.env.AGY_SWARM_TRANSLATE_COOLDOWN_MS;
  const envCooldown = envCooldownRaw !== undefined && envCooldownRaw !== '' ? Number(envCooldownRaw) : NaN;
  const retryCooldownMs = Number.isFinite(options.retryCooldownMs) && options.retryCooldownMs >= 0
    ? options.retryCooldownMs
    : (Number.isFinite(envCooldown) && envCooldown >= 0 ? envCooldown : RETRY_COOLDOWN_MS);
  const debounceMs = Number.isFinite(options.debounceMs) && options.debounceMs >= 0
    ? options.debounceMs
    : DEFAULT_DEBOUNCE_MS;

  const isDisabled =
    options.disableLlm === true ||
    ['1', 'true'].includes(String(process.env.AGY_SWARM_TRANSLATE_DISABLED || '').trim().toLowerCase());

  // LRU cache: Map<hash, { zh: string, ts: number, origin: 'cache' | 'llm' }>
  const cache = new Map();
  let dirty = false;
  let flushTimer = null;

  // Version & queue tracking
  const swarmVersions = new Map(); // swarmId -> number
  const swarmNextRetryAt = new Map(); // swarmId -> earliest cooldown expiry ms
  const keySwarms = new Map(); // hash -> Set<swarmId>
  const queuedSet = new Set(); // hash
  const inFlightSet = new Set(); // hash
  const queue = []; // Array<{ key, text, priority }>
  const retryCooldowns = new Map(); // hash -> expiresAt
  const stats = {
    cached: 0,
    failed: 0,
    llmCalls: 0,
    llmSuccess: 0,
  };

  function recordSwarmCooldown(sid, expiresAt) {
    if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) return;
    const prev = swarmNextRetryAt.get(sid);
    if (!prev || expiresAt < prev) {
      swarmNextRetryAt.set(sid, expiresAt);
    }
  }

  function bumpSwarmVersion(sid) {
    swarmVersions.set(sid, (swarmVersions.get(sid) || 0) + 1);
  }

  function bumpSwarmsForKey(key, cooldownExpiresAt = 0) {
    const swarms = keySwarms.get(key);
    if (swarms) {
      for (const sid of swarms) {
        if (cooldownExpiresAt > 0) recordSwarmCooldown(sid, cooldownExpiresAt);
        bumpSwarmVersion(sid);
      }
      keySwarms.delete(key);
    }
  }

  let closed = false;
  const lifecycleAc = new AbortController();

  // Private provider state (apiKey NEVER leaves this closure; strictly explicit opt-in)
  let provider = null; // { baseUrl, apiKey, model, source }
  let staticProviderInit = false;

  function initStaticProvider() {
    if (staticProviderInit) return;
    staticProviderInit = true;
    if (isDisabled) return;

    if (options.providerConfig && options.providerConfig.baseUrl) {
      provider = {
        baseUrl: String(options.providerConfig.baseUrl).replace(/(?<!\/)\/+$/, ''),
        apiKey: String(options.providerConfig.apiKey || ''),
        model: String(options.providerConfig.model || ''),
        source: 'providerConfig',
      };
      return;
    }

    const envUrl = process.env.AGY_SWARM_TRANSLATE_BASE_URL;
    if (envUrl) {
      provider = {
        baseUrl: String(envUrl).replace(/(?<!\/)\/+$/, ''),
        apiKey: String(process.env.AGY_SWARM_TRANSLATE_API_KEY || ''),
        model: String(process.env.AGY_SWARM_TRANSLATE_MODEL || ''),
        source: 'env',
      };
    }
  }

  initStaticProvider();

  function loadCache() {
    if (!cachePath) return;
    try {
      if (!existsSync(cachePath)) return;
      const raw = readFileSync(cachePath, 'utf-8');
      if (!raw.trim()) return;
      const parsed = JSON.parse(raw);
      let entries = [];
      if (Array.isArray(parsed?.entries)) {
        entries = parsed.entries;
      } else if (parsed?.entries && typeof parsed.entries === 'object') {
        entries = Object.entries(parsed.entries);
      }
      for (const item of entries) {
        if (!Array.isArray(item) || item.length < 2) continue;
        const [k, v] = item;
        if (typeof k === 'string' && k && v && typeof v.zh === 'string') {
          cache.set(k, {
            zh: v.zh,
            ts: Number(v.ts) || Date.now(),
            origin: 'cache',
          });
        }
      }
      while (cache.size > maxEntries) {
        const oldest = cache.keys().next().value;
        cache.delete(oldest);
      }
      stats.cached = cache.size;
    } catch (err) {
      logger?.warn?.(`[translator] ignoring unreadable cache: ${scrubSecrets(err?.message || err)}`);
    }
  }

  loadCache();

  function cacheGet(key) {
    const hit = cache.get(key);
    if (!hit) return null;
    // Refresh LRU position
    cache.delete(key);
    cache.set(key, hit);
    return hit;
  }

  function cacheSet(key, zh, origin = 'llm') {
    if (cache.has(key)) cache.delete(key);
    cache.set(key, { zh, ts: Date.now(), origin });
    while (cache.size > maxEntries) {
      const oldest = cache.keys().next().value;
      cache.delete(oldest);
    }
    stats.cached = cache.size;
    dirty = true;
    scheduleFlush();
  }

  function scheduleFlush() {
    if (!cachePath || closed || flushTimer) return;
    flushTimer = setTimeout(() => {
      flushTimer = null;
      flushCache();
    }, debounceMs);
    flushTimer.unref?.();
  }

  function flushCache() {
    if (flushTimer) {
      clearTimeout(flushTimer);
      flushTimer = null;
    }
    if (!cachePath || !dirty) return;
    const tmp = `${cachePath}.tmp.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}`;
    try {
      mkdirSync(dirname(cachePath), { recursive: true });
      const serializable = [];
      for (const [k, v] of cache.entries()) {
        serializable.push([k, { zh: v.zh, ts: v.ts }]);
      }
      const payload = JSON.stringify({
        version: PROMPT_VERSION,
        updatedAt: Date.now(),
        entries: serializable,
      });
      writeFileSync(tmp, payload, 'utf-8');
      renameSync(tmp, cachePath);
      dirty = false;
    } catch (err) {
      try {
        if (existsSync(tmp)) unlinkSync(tmp);
      } catch {
        // ignore cleanup error
      }
      logger?.warn?.(`[translator] cache flush failed: ${scrubSecrets(err?.message || err)}`);
    }
  }

  async function probeModel(baseUrl, apiKey) {
    if (typeof fetchImpl !== 'function') return 'default';
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 3000);
    timer.unref?.();
    const onLifecycleAbort = () => ac.abort();
    lifecycleAc.signal.addEventListener('abort', onLifecycleAbort, { once: true });
    try {
      const headers = {};
      if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
      const res = await fetchImpl(`${baseUrl.replace(/(?<!\/)\/+$/, '')}/models`, {
        method: 'GET',
        headers,
        signal: ac.signal,
      });
      if (!res.ok) return 'default';
      const body = await res.json();
      const first = Array.isArray(body?.data) ? body.data.find((d) => typeof d?.id === 'string' && d.id) : null;
      return first?.id || 'default';
    } catch {
      return 'default';
    } finally {
      clearTimeout(timer);
      lifecycleAc.signal.removeEventListener('abort', onLifecycleAbort);
    }
  }

  async function ensureProvider() {
    if (isDisabled || closed || !provider) return null;
    if (!provider.model) {
      const probed = await probeModel(provider.baseUrl, provider.apiKey);
      if (closed || !provider) return null;
      provider.model = probed;
    }
    return provider;
  }

  async function callLlmOnce(prov, maskedText) {
    if (typeof fetchImpl !== 'function') {
      throw new Error('fetch unavailable');
    }
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(new Error('LLM request timeout')), requestTimeoutMs);
    timer.unref?.();
    const onLifecycleAbort = () => ac.abort(new Error('Translator closed'));
    lifecycleAc.signal.addEventListener('abort', onLifecycleAbort, { once: true });

    try {
      const headers = { 'Content-Type': 'application/json' };
      if (prov.apiKey) {
        headers.Authorization = `Bearer ${prov.apiKey}`;
      }
      const res = await fetchImpl(`${prov.baseUrl}/chat/completions`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          model: prov.model || 'default',
          temperature: 0.1,
          messages: [
            { role: 'system', content: SYSTEM_PROMPT },
            { role: 'user', content: maskedText },
          ],
        }),
        signal: ac.signal,
      });

      if (!res.ok) {
        const retryAfterRaw = res.headers?.get?.('retry-after');
        let retryAfterMs = null;
        if (retryAfterRaw != null && /^\d+(?:\.\d+)?$/.test(String(retryAfterRaw).trim())) {
          retryAfterMs = Math.min(30_000, Math.max(0, Number(retryAfterRaw) * 1000));
        }
        const errText = await res.text().catch(() => '');
        const err = new Error(scrubSecrets(`HTTP ${res.status}: ${errText.slice(0, 200)}`, prov.apiKey));
        err.status = res.status;
        err.retryAfterMs = retryAfterMs;
        throw err;
      }

      const data = await res.json();
      const content = data?.choices?.[0]?.message?.content;
      if (typeof content !== 'string') {
        const err = new Error('Empty LLM response content');
        err.nonRetriable = true;
        throw err;
      }
      return content.trim();
    } finally {
      clearTimeout(timer);
      lifecycleAc.signal.removeEventListener('abort', onLifecycleAbort);
    }
  }

  async function translateViaLlmWithRetry(rawText, tier1Text) {
    // Run Tier-1 first, then mask technical literals before sending to LLM
    const inputForMask = tier1Text || rawText;
    const { masked, tokens } = maskTechnicalLiterals(inputForMask);
    if (!needsLlmTranslation(masked)) {
      return { ok: true, text: inputForMask };
    }

    let prov = await ensureProvider();
    if (!prov) return { ok: false, skipped: true };

    const chunks =
      masked.length > LONG_MESSAGE_CHUNK_THRESHOLD
        ? splitMaskedIntoChunks(masked, LONG_MESSAGE_CHUNK_MAX_CHARS)
        : [{ text: masked, sep: '' }];
    const isMultiChunk = chunks.length > 1;

    async function callChunkWithRetry(chunkText) {
      const maxAttempts = 3; // initial + 2 retries for transient 429/5xx/timeout
      for (let attempt = 0; attempt < maxAttempts; attempt++) {
        if (closed) return { ok: false, skipped: true };
        stats.llmCalls++;
        try {
          const translatedMasked = await callLlmOnce(prov, chunkText);
          if (!translatedMasked) {
            const err = new Error('Empty translation');
            err.nonRetriable = true;
            throw err;
          }
          if (isMultiChunk) {
            const checked = normalizeAndValidateChunkPlaceholders(chunkText, translatedMasked, tokens.length);
            if (!checked.intact) {
              const err = new Error('Placeholder integrity check failed');
              err.nonRetriable = true;
              throw err;
            }
            return { ok: true, text: checked.text };
          }
          return { ok: true, text: translatedMasked };
        } catch (err) {
          if (closed) return { ok: false, skipped: true };
          const status = err?.status;

          // Non-retriable placeholder/empty failure or 4xx (except 429)
          const retriable =
            !err?.nonRetriable &&
            (status === 429 || (status >= 500 && status < 600) || (!status && err?.name !== 'AbortError'));
          if (!retriable && err?.message !== 'LLM request timeout') {
            return { ok: false, error: err };
          }
          if (attempt + 1 >= maxAttempts) {
            return { ok: false, error: err };
          }

          const backoff =
            err?.retryAfterMs != null
              ? err.retryAfterMs
              : baseBackoffMs * 2 ** attempt + Math.floor(Math.random() * Math.min(400, baseBackoffMs + 1));
          if (backoff > 0) await sleep(backoff, lifecycleAc.signal);
        }
      }
      return { ok: false };
    }

    const assembled = [];
    for (const chunk of chunks) {
      if (closed) return { ok: false, skipped: true };
      if (!needsLlmTranslation(chunk.text)) {
        assembled.push(chunk.text + chunk.sep);
        continue;
      }
      const res = await callChunkWithRetry(chunk.text);
      if (!res.ok) return res;
      assembled.push(res.text + chunk.sep);
    }

    const joinedMasked = assembled.join('');
    const restored = unmaskTechnicalLiterals(joinedMasked, tokens);
    if (!restored.intact) {
      return { ok: false, error: new Error('Placeholder integrity check failed') };
    }
    stats.llmSuccess++;
    return { ok: true, text: restored.text };
  }

  let activeWorkers = 0;
  function pumpQueue() {
    if (closed || isDisabled) return;
    while (activeWorkers < concurrency && queue.length > 0) {
      // Pick highest priority item
      let bestIdx = 0;
      for (let i = 1; i < queue.length; i++) {
        if (queue[i].priority > queue[bestIdx].priority) bestIdx = i;
      }
      const job = queue.splice(bestIdx, 1)[0];
      queuedSet.delete(job.key);
      if (cache.has(job.key)) {
        bumpSwarmsForKey(job.key);
        continue;
      }
      inFlightSet.add(job.key);
      activeWorkers++;

      (async () => {
        try {
          const res = await translateViaLlmWithRetry(job.rawText, job.tier1Text);
          if (res.ok && typeof res.text === 'string' && !closed) {
            cacheSet(job.key, res.text, 'llm');
            bumpSwarmsForKey(job.key);
          } else if (!res.skipped) {
            stats.failed++;
            const expiresAt = Date.now() + retryCooldownMs;
            retryCooldowns.set(job.key, expiresAt);
            bumpSwarmsForKey(job.key, expiresAt);
          } else {
            // Provider unavailable / disabled: don't spin failed stats aggressively
            const skipWindow = Date.now() + Math.min(5000, retryCooldownMs);
            retryCooldowns.set(job.key, skipWindow);
            bumpSwarmsForKey(job.key, skipWindow);
          }
        } catch (err) {
          stats.failed++;
          const expiresAt = Date.now() + retryCooldownMs;
          retryCooldowns.set(job.key, expiresAt);
          bumpSwarmsForKey(job.key, expiresAt);
          logger?.warn?.(`[translator] job failed: ${scrubSecrets(err?.message || err, provider?.apiKey)}`);
        } finally {
          inFlightSet.delete(job.key);
          activeWorkers--;
          if (queue.length === 0 && inFlightSet.size === 0 && dirty) {
            flushCache();
          }
          pumpQueue();
        }
      })();
    }
  }

  function enqueueJob(swarmId, rawText, tier1Text, priority, cacheKind = 'text') {
    if (isDisabled || closed || !provider) return false;
    const key = makeCacheKey(tier1Text || rawText, cacheKind);

    const cooldownUntil = retryCooldowns.get(key);
    if (cooldownUntil && Date.now() < cooldownUntil) {
      recordSwarmCooldown(swarmId, cooldownUntil);
      return false;
    }
    if (cooldownUntil) retryCooldowns.delete(key);

    if (inFlightSet.has(key) || queuedSet.has(key)) {
      if (!keySwarms.has(key)) keySwarms.set(key, new Set());
      keySwarms.get(key).add(swarmId);
      return true;
    }
    if (queue.length >= MAX_QUEUE_SIZE) {
      // Evict lowest priority item if new item has higher priority
      let minIdx = 0;
      for (let i = 1; i < queue.length; i++) {
        if (queue[i].priority < queue[minIdx].priority) minIdx = i;
      }
      if (priority <= queue[minIdx].priority) return false;
      const dropped = queue.splice(minIdx, 1)[0];
      queuedSet.delete(dropped.key);
      keySwarms.delete(dropped.key);
    }

    if (!keySwarms.has(key)) keySwarms.set(key, new Set());
    keySwarms.get(key).add(swarmId);
    queuedSet.add(key);
    queue.push({ key, rawText, tier1Text, priority });
    pumpQueue();
    return true;
  }

  /**
   * Synchronous non-blocking resolution of one text string.
   * Returns { text: string | null, pending: boolean, source: 'rule'|'llm'|'cache'|'cjk'|'none' }
   */
  function resolveTextSync(swarmId, rawText, { kind = 'text', priority = 10, allowLlm = true } = {}) {
    if (typeof rawText !== 'string' || !rawText.trim()) {
      return { text: '', pending: false, source: 'none' };
    }

    const t1 = applyTier1Rules(rawText, kind);
    const tier1Changed = t1.text.trim() !== rawText.trim();

    if (t1.fullyTranslated) {
      if (!tier1Changed && isPredominantlyChinese(rawText)) {
        return { text: rawText, pending: false, source: 'cjk' };
      }
      return { text: t1.text, pending: false, source: 'rule' };
    }

    const cacheKind =
      kind === 'failure' || kind === 'control' || kind === 'activity' || kind === 'attention' ? kind : 'text';
    const key = makeCacheKey(t1.text, cacheKind);
    const hit = cacheGet(key);
    if (hit) {
      return {
        text: hit.zh,
        pending: false,
        source: hit.origin === 'llm' ? 'llm' : 'cache',
      };
    }

    if (allowLlm) {
      const pending = enqueueJob(swarmId, rawText, t1.text, priority, cacheKind);
      if (!pending && tier1Changed) {
        return { text: t1.text, pending: false, source: 'rule' };
      }
      return { text: null, pending, source: 'none' };
    }

    return { text: tier1Changed ? t1.text : null, pending: false, source: tier1Changed ? 'rule' : 'none' };
  }

  function translateViewObject(swarmId, viewJson) {
    if (!viewJson || typeof viewJson !== 'object') return null;
    const cloned = structuredClone(viewJson);
    const trField = (obj, prop, priority = 50) => {
      if (obj && typeof obj[prop] === 'string' && obj[prop].trim()) {
        const res = resolveTextSync(swarmId, obj[prop], { kind: 'text', priority });
        if (res.text) obj[prop] = res.text;
      }
    };

    trField(cloned, 'headline', 80);
    trField(cloned, 'running_summary', 70);
    if (typeof cloned.goal === 'string') {
      trField(cloned, 'goal', 75);
    } else if (cloned.goal && typeof cloned.goal === 'object') {
      trField(cloned.goal, 'title', 75);
      trField(cloned.goal, 'line', 75);
    }
    if (cloned.phase && typeof cloned.phase === 'object') {
      trField(cloned.phase, 'label', 65);
    }
    if (cloned.feedback_ack && typeof cloned.feedback_ack === 'object') {
      trField(cloned.feedback_ack, 'text', 65);
    }

    const trActions = (actions) => {
      if (!Array.isArray(actions)) return;
      for (const a of actions) trField(a, 'label', 45);
    };

    if (Array.isArray(cloned.attention)) {
      for (const it of cloned.attention) {
        if (!it || typeof it !== 'object') continue;
        trField(it, 'title', 70);
        trField(it, 'why', 65);
        if (it.short && typeof it.short === 'object') {
          trField(it.short, 'title', 65);
          trField(it.short, 'line', 65);
        }
        trActions(it.actions);
      }
    }
    if (Array.isArray(cloned.workstreams)) {
      for (const w of cloned.workstreams) {
        if (!w || typeof w !== 'object') continue;
        trField(w, 'title', 60);
        trField(w, 'note', 55);
        if (w.short && typeof w.short === 'object') {
          trField(w.short, 'title', 55);
          trField(w.short, 'line', 55);
        }
        if (w.progress && typeof w.progress === 'object') {
          trField(w.progress, 'label', 50);
        }
        trActions(w.actions);
      }
    }
    if (Array.isArray(cloned.threads)) {
      for (const t of cloned.threads) {
        if (!t || typeof t !== 'object') continue;
        trField(t, 'title', 60);
        trField(t, 'goal', 55);
        trField(t, 'now', 55);
      }
    }
    if (Array.isArray(cloned.milestones)) {
      for (const m of cloned.milestones) trField(m, 'text', 55);
    }
    if (Array.isArray(cloned.risks)) {
      for (const r of cloned.risks) trField(r, 'text', 55);
    }
    if (cloned.now && typeof cloned.now === 'object' && !Array.isArray(cloned.now)) {
      for (const k of Object.keys(cloned.now)) {
        trField(cloned.now, k, 50);
      }
    }
    if (cloned.reel && Array.isArray(cloned.reel.frames)) {
      for (const f of cloned.reel.frames) trField(f, 'caption', 45);
    }
    return cloned;
  }

  function translatePlanObject(swarmId, plan) {
    if (!plan || typeof plan !== 'object') return null;
    const cloned = structuredClone(plan);
    const trField = (obj, prop, priority = 60) => {
      if (obj && typeof obj[prop] === 'string' && obj[prop].trim()) {
        const res = resolveTextSync(swarmId, obj[prop], { kind: 'text', priority });
        if (res.text) obj[prop] = res.text;
      }
    };

    if (typeof cloned.goal === 'string') {
      trField(cloned, 'goal', 75);
    } else if (cloned.goal && typeof cloned.goal === 'object') {
      trField(cloned.goal, 'title', 75);
      trField(cloned.goal, 'line', 75);
    }
    if (cloned.tasks && typeof cloned.tasks === 'object' && !Array.isArray(cloned.tasks)) {
      for (const memberName of Object.keys(cloned.tasks)) {
        trField(cloned.tasks, memberName, 60);
      }
    }
    if (Array.isArray(cloned.threads)) {
      for (const t of cloned.threads) {
        if (!t || typeof t !== 'object') continue;
        trField(t, 'title', 60);
        trField(t, 'goal', 55);
      }
    }
    return cloned;
  }

  function translateSnapshotFields(swarmId, rawSnapshot) {
    if (!rawSnapshot || typeof rawSnapshot !== 'object') return rawSnapshot;
    const sid = String(swarmId || rawSnapshot.id || 'default');

    // 1. title_zh
    let title_zh = null;
    if (typeof rawSnapshot.title === 'string' && rawSnapshot.title.trim()) {
      const tRes = resolveTextSync(sid, rawSnapshot.title, { kind: 'text', priority: 90 });
      title_zh = tRes.source === 'cjk' ? null : tRes.text;
    }

    // 2. messages[]
    const rawMsgs = Array.isArray(rawSnapshot.messages) ? rawSnapshot.messages : [];
    const msgCount = rawMsgs.length;
    const messages = rawMsgs.map((m, idx) => {
      if (!m || typeof m !== 'object') return m;
      const isControl = !!(m.control && typeof m.control === 'object');
      const seqPriority = Number.isFinite(Number(m.seq)) ? Number(m.seq) : idx + 1;
      const priority = 100 + seqPriority + (idx >= msgCount - 5 ? 500 : 0);
      const res = resolveTextSync(sid, String(m.text ?? ''), {
        kind: isControl ? 'control' : 'message',
        priority,
        allowLlm: true,
      });
      return {
        ...m,
        text_zh: res.text,
        text_zh_pending: res.pending,
        text_zh_source: res.source,
      };
    });

    // 3. members (Array in main.mjs; also tolerate Object map)
    const planTasks =
      rawSnapshot.plan && typeof rawSnapshot.plan.tasks === 'object' && rawSnapshot.plan.tasks
        ? rawSnapshot.plan.tasks
        : {};
    const enrichMember = (m, nameHint) => {
      if (!m || typeof m !== 'object') return m;
      const out = { ...m };
      if (typeof m.activity === 'string' && m.activity.trim()) {
        const aRes = resolveTextSync(sid, m.activity, { kind: 'activity', priority: 85 });
        if (aRes.text) out.activity_zh = aRes.text;
      }
      if (m.failure && typeof m.failure.text === 'string' && m.failure.text.trim()) {
        const fRes = resolveTextSync(sid, m.failure.text, { kind: 'failure', priority: 85 });
        if (fRes.text) out.failure_zh = fRes.text;
      }
      const memberName = m.name || nameHint;
      const taskBrief =
        memberName && Object.hasOwn(planTasks, memberName) && typeof planTasks[memberName] === 'string'
          ? planTasks[memberName]
          : '';
      if (taskBrief.trim()) {
        const bRes = resolveTextSync(sid, taskBrief, { kind: 'text', priority: 60 });
        if (bRes.text) out.title_zh = bRes.text;
      }
      return out;
    };

    let members = rawSnapshot.members;
    if (Array.isArray(rawSnapshot.members)) {
      members = rawSnapshot.members.map((m) => enrichMember(m));
    } else if (rawSnapshot.members && typeof rawSnapshot.members === 'object') {
      members = {};
      for (const [k, v] of Object.entries(rawSnapshot.members)) {
        Object.defineProperty(members, k, {
          value: enrichMember(v, k),
          enumerable: true,
          configurable: true,
          writable: true,
        });
      }
    }

    // 4. narrator
    let narrator = rawSnapshot.narrator;
    if (narrator && typeof narrator === 'object') {
      narrator = { ...narrator };
      if (typeof narrator.detail === 'string' && narrator.detail.trim()) {
        const dRes = resolveTextSync(sid, narrator.detail, { kind: 'failure', priority: 80 });
        if (dRes.text) narrator.detail_zh = dRes.text;
      }
    }

    // 5. frames[]
    let frames = rawSnapshot.frames;
    if (Array.isArray(rawSnapshot.frames)) {
      frames = rawSnapshot.frames.map((f) => {
        if (!f || typeof f !== 'object') return f;
        const cap = typeof f.caption === 'string' ? f.caption : '';
        if (!cap.trim()) return { ...f, caption_zh: '' };
        const cRes = resolveTextSync(sid, cap, { kind: 'frame', priority: 50 });
        return { ...f, ...(cRes.text != null ? { caption_zh: cRes.text } : {}) };
      });
    }

    // 6. systemAttention[] + systemAttention_zh
    let systemAttention = rawSnapshot.systemAttention;
    let systemAttention_zh;
    if (Array.isArray(rawSnapshot.systemAttention)) {
      systemAttention = rawSnapshot.systemAttention.map((it) => {
        if (!it || typeof it !== 'object') return it;
        const tRes = resolveTextSync(sid, String(it.text || ''), { kind: 'attention', priority: 95 });
        const dRes =
          typeof it.detail === 'string' && it.detail.trim()
            ? resolveTextSync(sid, it.detail, { kind: 'failure', priority: 85 })
            : null;
        return {
          ...it,
          text_zh: tRes.text || String(it.text || ''),
          ...(dRes?.text ? { detail_zh: dRes.text } : {}),
        };
      });
      systemAttention_zh = systemAttention.map((it) => ({
        kind: it.kind,
        member: it.member,
        text: it.text,
        text_zh: it.text_zh,
        ...(it.detail_zh !== undefined ? { detail_zh: it.detail_zh } : {}),
      }));
    }

    // 7. view_zh & plan_zh (deep-cloned, never mutates rawSnapshot.view or rawSnapshot.plan)
    const view_zh = rawSnapshot.view?.json ? translateViewObject(sid, rawSnapshot.view.json) : null;
    const plan_zh = rawSnapshot.plan ? translatePlanObject(sid, rawSnapshot.plan) : null;

    // 8. translationState
    const curStats = getStats();
    const translationState = {
      enabled: !isDisabled,
      provider: curStats.provider,
      pending: curStats.pending,
      cached: curStats.cached,
      failed: curStats.failed,
      version: getCacheVersion(sid),
    };

    return {
      ...rawSnapshot,
      title_zh,
      messages,
      members,
      narrator,
      ...(frames !== undefined ? { frames } : {}),
      ...(systemAttention !== undefined ? { systemAttention } : {}),
      ...(systemAttention_zh !== undefined ? { systemAttention_zh } : {}),
      view_zh,
      ...(rawSnapshot.plan !== undefined ? { plan_zh } : { plan_zh: null }),
      translationState,
    };
  }

  function getCacheVersion(swarmId) {
    const sid = String(swarmId || 'default');
    const nextRetry = swarmNextRetryAt.get(sid);
    if (nextRetry && Date.now() >= nextRetry) {
      swarmNextRetryAt.delete(sid);
      bumpSwarmVersion(sid);
    }
    return swarmVersions.get(sid) || 0;
  }

  function getStats() {
    let providerName = 'none';
    if (isDisabled) providerName = 'disabled';
    else if (provider) providerName = provider.source;

    return {
      enabled: !isDisabled,
      provider: providerName,
      pending: queue.length + inFlightSet.size,
      queued: queue.length,
      inFlight: inFlightSet.size,
      cached: cache.size,
      failed: stats.failed,
      llmCalls: stats.llmCalls,
      llmSuccess: stats.llmSuccess,
    };
  }

  async function close() {
    if (closed) return;
    closed = true;
    lifecycleAc.abort();
    flushCache();
    queue.length = 0;
    queuedSet.clear();
    keySwarms.clear();
    swarmNextRetryAt.clear();
    provider = null;
  }

  return {
    translateSnapshotFields,
    getCacheVersion,
    getStats,
    flushCache,
    close,
  };
}
