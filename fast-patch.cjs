#!/usr/bin/env node
'use strict';

/**
 * Antigravity In-Memory ASAR Patcher (fast-patch.cjs)
 * - Zero npx / child_process overhead, zero full-archive extraction
 * - Dual-mode support:
 *   1) Chinese + HUD mode (when antigravity-chinese is present and --hud-only is not set)
 *   2) HUD-Only mode (when antigravity-chinese is absent or --hud-only is specified)
 * - Reads the pristine app.asar.bak (or app.asar) into memory, patches target files in dist/,
 *   injects dist/agyHudTelemetryParser.cjs, recomputes SHA256 integrity & Pickle header,
 *   then swaps app.asar atomically and verifies the result (rolling back on failure).
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const vm = require('vm');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const hudCli = require('./cli.js');
const P = require('./paths.cjs');

const CHINESE_ROOT = P.CHINESE_ROOT;
const DICT_PATH = P.DICT_PATH;
const I18N_RUNTIME_PATH = P.I18N_RUNTIME_PATH;
const PARSER_SRC_PATH = P.PARSER_SRC_PATH;

const CHINESE_MARKER = 'Antigravity Chinese Localization Injection';
const HUD_MARKER = 'Antigravity HUD Telemetry Injection';
const FUSE_SENTINEL = 'dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX';
const FUSE_ASAR_INTEGRITY_INDEX = 4; // EnableEmbeddedAsarIntegrityValidation (0-based index in fuse wire)

function readJsonSafe(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { return null; }
}

function resolveEffectiveChinesePaths(options = {}) {
  const explicitRoot = options.chineseRoot || process.env.AGY_CHINESE_ROOT;
  const base = explicitRoot ? P.resolveChinesePaths(explicitRoot) : P;
  return {
    chineseRoot: base.CHINESE_ROOT,
    dictPath: options.dictPath || base.DICT_PATH,
    runtimePath: options.runtimePath || base.I18N_RUNTIME_PATH,
    pkgPath: base.CHINESE_PKG_PATH
  };
}

function shouldEnableChinese(options = {}) {
  if (options.hudOnly === true) return false;
  if (options.dictPath || options.runtimePath) {
    return true;
  }
  const { dictPath, runtimePath } = resolveEffectiveChinesePaths(options);
  return fs.existsSync(dictPath) && fs.existsSync(runtimePath);
}

// --- Upstream (antigravity-chinese) transform delegation ---------------------------
let upstreamModule; // undefined = not loaded yet, null = unavailable/untrusted
let lastTrustCheckKey = '';

function readGitHeadSafe(chineseRoot) {
  try {
    return execFileSync('git', ['-C', chineseRoot, 'rev-parse', 'HEAD'], {
      encoding: 'utf8',
      timeout: 3000,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    }).trim();
  } catch (_) {
    return '';
  }
}

function verifyUpstreamHeadTrusted(options = {}) {
  const statusFile = options.syncStatusFile || process.env.AGY_SYNC_STATUS_FILE || P.SYNC_STATUS_FILE;
  const chineseRoot = options.chineseRoot || process.env.AGY_CHINESE_ROOT || CHINESE_ROOT;
  const status = readJsonSafe(statusFile);
  // Only an explicitly approved SHA counts: `head` is refreshed by every background fetch
  // to whatever the local checkout is, so it must never be treated as approval.
  const approvedHead = status && typeof status.approvedHead === 'string' ? status.approvedHead : null;
  let actualHead = '';
  try {
    actualHead = execFileSync('git', ['-C', chineseRoot, 'rev-parse', 'HEAD'], {
      encoding: 'utf8',
      timeout: 3000,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    }).trim();
  } catch (err) {
    console.warn(`   [WARN] 无法读取上游仓库 git HEAD，跳过加载上游 cli.js，改用内置本地规则: ${err.message}`);
    return { trusted: false, actualHead: '', approvedHead: approvedHead || '' };
  }
  if (!approvedHead || actualHead.toLowerCase() !== String(approvedHead).trim().toLowerCase()) {
    console.warn(`   [WARN] 上游仓库当前 HEAD (${actualHead.slice(0, 7)}) 与已确认版本 (${approvedHead ? String(approvedHead).slice(0, 7) : '未记录'}) 不一致，跳过加载上游 cli.js，改用内置本地规则`);
    return { trusted: false, actualHead, approvedHead: approvedHead || '' };
  }
  return { trusted: true, actualHead, approvedHead };
}

function getUpstream(options = {}) {
  const statusFile = options.syncStatusFile || process.env.AGY_SYNC_STATUS_FILE || P.SYNC_STATUS_FILE;
  const chineseRoot = options.chineseRoot || process.env.AGY_CHINESE_ROOT || CHINESE_ROOT;
  const statusMtime = fs.existsSync(statusFile) ? fs.statSync(statusFile).mtimeMs : 0;
  const gitHead = readGitHeadSafe(chineseRoot);
  const checkKey = `${statusFile}|${chineseRoot}|${statusMtime}|${gitHead}`;
  if (upstreamModule !== undefined && lastTrustCheckKey === checkKey && !options.forceRecheckUpstream) {
    return upstreamModule;
  }
  if (options.forceRecheckUpstream) options.forceRecheckUpstream = false;
  lastTrustCheckKey = checkKey;
  const trust = verifyUpstreamHeadTrusted(options);
  if (!trust.trusted) {
    upstreamModule = null;
    return null;
  }
  try {
    const cliPath = path.join(chineseRoot, 'cli.js');
    if (fs.existsSync(cliPath)) {
      delete require.cache[require.resolve(cliPath)];
      upstreamModule = require(cliPath);
    } else {
      upstreamModule = null;
    }
  } catch (err) {
    console.warn(`   [WARN] 无法加载上游 cli.js，改用内置替换规则: ${err.message}`);
    upstreamModule = null;
  }
  return upstreamModule;
}

/**
 * Run an upstream file-based transform (patchXxxFile(path)) on an in-memory string by
 * round-tripping through a private temp file. Falls back to the local implementation.
 */
function viaUpstream(fnName, content, fallback, options = {}) {
  const up = getUpstream(options);
  if (!up || typeof up[fnName] !== 'function') return fallback(content, options);
  const tmp = path.join(os.tmpdir(), `agy-fastpatch-${process.pid}-${crypto.randomBytes(6).toString('hex')}.js`);
  try {
    fs.writeFileSync(tmp, content, 'utf8');
    up[fnName](tmp);
    return fs.readFileSync(tmp, 'utf8');
  } catch (err) {
    console.warn(`   [WARN] 上游 ${fnName} 执行失败，改用内置规则: ${err.message}`);
    return fallback(content, options);
  } finally {
    try { fs.rmSync(tmp, { force: true }); } catch (_) {}
  }
}

const BLOCK_SIZE = 4 * 1024 * 1024; // 4MB Electron ASAR integrity block size

function computeIntegrity(buf) {
  const hash = crypto.createHash('sha256').update(buf).digest('hex');
  const blocks = [];
  if (buf.length === 0) {
    blocks.push(hash);
  } else {
    for (let offset = 0; offset < buf.length; offset += BLOCK_SIZE) {
      const chunk = buf.subarray(offset, Math.min(offset + BLOCK_SIZE, buf.length));
      blocks.push(crypto.createHash('sha256').update(chunk).digest('hex'));
    }
  }
  return {
    algorithm: 'SHA256',
    hash,
    blockSize: BLOCK_SIZE,
    blocks
  };
}

function getAsarFingerprintFromBuffer(buf) {
  return crypto.createHash('sha1').update(buf).digest('hex').slice(0, 16);
}

function isValidAsarBuffer(buf) {
  if (!buf || buf.length < 16) return false;
  if (buf.readUInt32LE(0) !== 4) return false;
  const headerPickleLen = buf.readUInt32LE(4);
  const headerPayloadLen = buf.readUInt32LE(8);
  const jsonLen = buf.readUInt32LE(12);
  if (headerPickleLen < 8 || headerPickleLen > buf.length - 8) return false;
  if (headerPayloadLen !== headerPickleLen - 4) return false;
  if (jsonLen < 2 || jsonLen > headerPayloadLen - 4) return false;
  return true;
}

/** Extract a single file's UTF-8 text from an in-memory ASAR buffer by relative path (e.g. 'dist/preload.js'). */
function extractAsarFileText(buf, relPath) {
  try {
    if (!isValidAsarBuffer(buf)) return null;
    const headerPickleLen = buf.readUInt32LE(4);
    const jsonLen = buf.readUInt32LE(12);
    const base = 8 + headerPickleLen;
    const root = JSON.parse(buf.subarray(16, 16 + jsonLen).toString('utf8'));
    let node = root;
    for (const part of String(relPath).split('/').filter(Boolean)) {
      if (!node || !node.files || !node.files[part]) return null;
      node = node.files[part];
    }
    if (!node || node.files || node.unpacked) return null;
    const start = base + Number(node.offset);
    const end = start + Number(node.size || 0);
    if (!Number.isFinite(start) || !Number.isFinite(end) || start < base || start < 0 || end < start || end > buf.length) return null;
    return buf.subarray(start, end).toString('utf8');
  } catch (_) {
    return null;
  }
}

/** Whether the buffer contains any Chinese or HUD marker anywhere (used to detect touched archives before backing up). */
function hasAnyPatchMarker(buf) {
  if (!buf) return false;
  return buf.includes(Buffer.from(CHINESE_MARKER)) || buf.includes(Buffer.from(HUD_MARKER));
}

/** Per-file check for Chinese localization markers across required target files. */
function isBufferPatched(buf) {
  const preload = extractAsarFileText(buf, 'dist/preload.js');
  const ipc = extractAsarFileText(buf, 'dist/ipcHandlers.js');
  if (!preload || !preload.includes(CHINESE_MARKER)) return false;
  if (!ipc) return false;
  if (ipc.includes('function buildContextMenuTemplate') && !ipc.includes('__AGY_CONTEXT_MENU_MAP__')) return false;
  return true;
}

/** Per-file check for HUD telemetry markers across preload.js, ipcHandlers.js, and agyHudTelemetryParser.cjs. */
function isBufferHudPatched(buf) {
  const preload = extractAsarFileText(buf, 'dist/preload.js');
  const ipc = extractAsarFileText(buf, 'dist/ipcHandlers.js');
  const parserText = extractAsarFileText(buf, 'dist/agyHudTelemetryParser.cjs');
  if (!preload || !preload.includes(HUD_MARKER)) return false;
  if (!ipc || !ipc.includes(HUD_MARKER)) return false;
  if (!parserText || !parserText.includes('summarizeTelemetry')) return false;
  return true;
}

/** Detailed per-file verification; throws a descriptive error if any target file is missing its expected injection. */
function verifyPatchedAsarIntegrity(buf, options = {}) {
  const expectChinese = options.expectChinese !== false;
  if (!isValidAsarBuffer(buf)) throw new Error('ASAR 归档头部格式无效');
  const preload = extractAsarFileText(buf, 'dist/preload.js');
  if (!preload) throw new Error('ASAR 缺少必需文件 dist/preload.js');
  if (expectChinese && !preload.includes(CHINESE_MARKER)) throw new Error('dist/preload.js 缺少中文注入标记');
  if (!preload.includes(HUD_MARKER)) throw new Error('dist/preload.js 缺少 HUD 注入标记');

  const ipc = extractAsarFileText(buf, 'dist/ipcHandlers.js');
  if (!ipc) throw new Error('ASAR 缺少必需文件 dist/ipcHandlers.js');
  if (!ipc.includes(HUD_MARKER)) throw new Error('dist/ipcHandlers.js 缺少 HUD 注入标记');
  if (expectChinese && ipc.includes('function buildContextMenuTemplate') && !ipc.includes('__AGY_CONTEXT_MENU_MAP__')) {
    throw new Error('dist/ipcHandlers.js 缺少右键菜单汉化映射 (__AGY_CONTEXT_MENU_MAP__)');
  }

  const parserText = extractAsarFileText(buf, 'dist/agyHudTelemetryParser.cjs');
  if (!parserText || !parserText.includes('summarizeTelemetry')) {
    throw new Error('dist/agyHudTelemetryParser.cjs 缺失或内容不完整');
  }
  return true;
}

// --- Antigravity Chinese v3.3.37 In-Memory Patch Functions ---

function parseAndSerializeDict(dictPath = DICT_PATH) {
  const raw = fs.readFileSync(dictPath, 'utf-8');
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`汉化词库 JSON 校验失败 (${dictPath}): ${err.message}`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`汉化词库顶层结构必须是 JSON 对象 (${dictPath})`);
  }
  return { parsed, json: JSON.stringify(parsed) };
}

function applyRuntimePerformanceHotfix(runtimeContent) {
  if (typeof runtimeContent !== 'string' || !runtimeContent.includes('createI18nEngine')) {
    return runtimeContent;
  }

  let patched = runtimeContent;

  // 1. Ignore lowercase SVG/MathML tags and KaTeX math containers so 40k+ formula DOM nodes are skipped in O(1)
  if (!patched.includes("'math': 1")) {
    patched = patched.replace(
      "'SVG': 1, 'PATH': 1, 'CANVAS': 1,",
      "'SVG': 1, 'svg': 1, 'PATH': 1, 'path': 1, 'MATH': 1, 'math': 1, 'SEMANTICS': 1, 'semantics': 1, 'ANNOTATION': 1, 'annotation': 1, 'CANVAS': 1,"
    );
  }
  if (!patched.includes("'katex'")) {
    patched = patched.replace(
      /'code-block',\r?\n(\s*)'editor-instance'/,
      "'code-block',\n$1'editor-instance',\n$1'katex',\n$1'katex-mathml',\n$1'katex-html',\n$1'math-inline',\n$1'math-display'"
    );
  }

  // 2. Split shouldIgnoreSelf vs shouldIgnoreElement so top-down recursion does not re-walk 30 ancestors per child
  if (!patched.includes('function shouldIgnoreSelf(el)')) {
    if (patched.includes('function isProtectedBoundary(el)')) {
      patched = patched.replace(
        'function isProtectedBoundary(el) {',
        'function shouldIgnoreSelf(el) { return isProtectedBoundary(el); }\n  function isProtectedBoundary(el) {'
      );
    }
    const origIgnoreRe = /function shouldIgnoreElement\(el\) \{[\s\S]*?return false;\r?\n  \}/;
    const newIgnoreCode = [
      'function shouldIgnoreSelf(el) {',
      '    if (!el || el.nodeType !== 1) return false;',
      '    if (IGNORED_TAGS[el.tagName]) return true;',
      "    if (el.isContentEditable || el.getAttribute('contenteditable') === '' ||",
      "        el.getAttribute('contenteditable') === 'true' || el.getAttribute('contenteditable') === 'plaintext-only') return true;",
      '    if (isModelSelectorBoundary(el)) return true;',
      "    var className = typeof el.className === 'string' ? el.className : '';",
      '    if (className) {',
      '      for (var i = 0; i < IGNORED_CLASSES.length; i++) {',
      '        if (className.indexOf(IGNORED_CLASSES[i]) !== -1) return true;',
      '      }',
      '    }',
      '    return false;',
      '  }',
      '',
      '  function shouldIgnoreElement(el) {',
      '    if (shouldIgnoreSelf(el)) return true;',
      '    var ancestor = el ? el.parentElement : null;',
      '    while (ancestor) {',
      '      if (shouldIgnoreSelf(ancestor)) return true;',
      '      ancestor = ancestor.parentElement;',
      '    }',
      '    return false;',
      '  }'
    ].join('\n');

    if (origIgnoreRe.test(patched)) {
      patched = patched.replace(origIgnoreRe, newIgnoreCode);
      patched = patched.replace(
        /function translateTextNode\(node\) \{\r?\n\s*if \(!node \|\| node\.nodeType !== 3\) return;\r?\n\s*var parent = node\.parentElement \|\| node\.parentNode;\r?\n\s*if \(parent && \(shouldIgnoreElement\(parent\) \|\| parent\.tagName === 'INPUT' \|\| parent\.tagName === 'TEXTAREA'\)\) return;/,
        [
          'function translateTextNode(node, parentChecked) {',
          '    if (!node || node.nodeType !== 3) return;',
          '    var parent = node.parentElement || node.parentNode;',
          "    if (parent && (parent.tagName === 'INPUT' || parent.tagName === 'TEXTAREA' || (!parentChecked && shouldIgnoreElement(parent)))) return;"
        ].join('\n')
      );
      patched = patched.replace(
        /function translateElement\(el, scanId\) \{\r?\n\s*if \(!el \|\| el\.nodeType !== 1\) return;\r?\n\s*if \(shouldIgnoreElement\(el\)\) return;/,
        [
          'function translateElement(el, scanId, ancestorChecked) {',
          '    if (!el || el.nodeType !== 1) return;',
          '    if (ancestorChecked ? shouldIgnoreSelf(el) : shouldIgnoreElement(el)) return;'
        ].join('\n')
      );
      patched = patched.replace(
        /if \(child\.nodeType === 3\) \{\r?\n\s*translateTextNode\(child\);\r?\n\s*\} else if \(child\.nodeType === 1\) \{\r?\n\s*translateElement\(child, scanId\);\r?\n\s*\}/,
        [
          'if (child.nodeType === 3) {',
          '        translateTextNode(child, true);',
          '      } else if (child.nodeType === 1) {',
          '        translateElement(child, scanId, true);',
          '      }'
        ].join('\n')
      );
    }
  }

  // 3. Pass incrementing scanId in safeTranslateNodes and scanFloatingContainers to deduplicate nested batch subtrees
  patched = patched.replace(
    /function safeTranslateNodes\(nodes\) \{\r?\n\s*disconnectObserver\(\);\r?\n\s*try \{\r?\n\s*for \(var i = 0; i < nodes\.length; i\+\+\) \{\r?\n\s*var node = nodes\[i\];\r?\n\s*if \(node\.nodeType === 1\) \{\r?\n\s*translateElement\(node\);/,
    [
      'function safeTranslateNodes(nodes) {',
      '    currentScanId++;',
      '    var scanId = currentScanId;',
      '    disconnectObserver();',
      '    try {',
      '      for (var i = 0; i < nodes.length; i++) {',
      '        var node = nodes[i];',
      '        if (node.nodeType === 1) {',
      '          translateElement(node, scanId);'
    ].join('\n')
  );

  patched = patched.replace(
    /function scanFloatingContainers\(\) \{\r?\n\s*if \(!doc \|\| !doc\.body\) return;\r?\n\s*disconnectObserver\(\);\r?\n\s*try \{\r?\n\s*\/\/[^\r\n]*\r?\n\s*var last = doc\.body\.lastElementChild;\r?\n\s*if \(last && isFloatingElement\(last\)\) \{\r?\n\s*translateElement\(last\);\r?\n\s*\}\r?\n\s*if \(last && last\.previousElementSibling && isFloatingElement\(last\.previousElementSibling\)\) \{\r?\n\s*translateElement\(last\.previousElementSibling\);\r?\n\s*\}\r?\n\s*var tooltips = ([^\r\n]+)\r?\n\s*if \(tooltips && tooltips\.length > 0\) \{\r?\n\s*for \(var tIdx = 0; tIdx < tooltips\.length; tIdx\+\+\) \{\r?\n\s*translateElement\(tooltips\[tIdx\]\);\r?\n\s*\}\r?\n\s*\}/,
    [
      'function scanFloatingContainers() {',
      '        if (!doc || !doc.body) return;',
      '        currentScanId++;',
      '        var fScanId = currentScanId;',
      '        disconnectObserver();',
      '        try {',
      '          var last = doc.body.lastElementChild;',
      '          if (last && isFloatingElement(last)) {',
      '            translateElement(last, fScanId);',
      '          }',
      '          if (last && last.previousElementSibling && isFloatingElement(last.previousElementSibling)) {',
      '            translateElement(last.previousElementSibling, fScanId);',
      '          }',
      '          var tooltips = $1',
      '          if (tooltips && tooltips.length > 0) {',
      '            for (var tIdx = 0; tIdx < tooltips.length; tIdx++) {',
      '              translateElement(tooltips[tIdx], fScanId);',
      '            }',
      '          }'
    ].join('\n')
  );

  // 4. Guard isWorkbenchOrRoot & onHoverAction against deep-scanning conversation/prose/katex containers on pointerenter
  patched = patched.replace(
    /function isWorkbenchOrRoot\(el\) \{[\s\S]*?return false;\r?\n  \}/,
    [
      'function isWorkbenchOrRoot(el) {',
      '    if (!el || el.nodeType !== 1) return true;',
      '    if (doc && (el === doc.body || el === doc.documentElement)) return true;',
      "    if (el.id === 'workbench' || el.id === 'app-root' || el.id === 'root') return true;",
      "    var testId = el.getAttribute ? el.getAttribute('data-testid') : '';",
      "    if (testId === 'conversation-view' || testId === 'agent-input-box') return true;",
      "    var cls = typeof el.className === 'string' ? el.className : '';",
      "    if (cls && (cls.indexOf('monaco-workbench') !== -1 || cls.indexOf('prose') !== -1 || cls.indexOf('chat-messages') !== -1)) return true;",
      '    if (el.children && el.children.length > 10) return true;',
      '    if (el.firstElementChild && el.firstElementChild.children && el.firstElementChild.children.length > 10) return true;',
      '    if (el.querySelector && el.querySelector(\'.katex, .prose, [data-testid="conversation-view"]\') !== null) return true;',
      '    return false;',
      '  }'
    ].join('\n')
  );

  patched = patched.replace(
    /var onHoverAction = function \(e\) \{[\s\S]*?hoverScanTimer = setTimeout\(function \(\) \{\r?\n\s*hoverScanTimer = null;\r?\n\s*scanFloatingContainers\(\);\r?\n\s*\}, 50\);\r?\n\s*\};/,
    [
      'var onHoverAction = function (e) {',
      '        var target = e.target;',
      '        if (!target || target.nodeType !== 1) return;',
      '',
      '        if (hoverScanTimer) clearTimeout(hoverScanTimer);',
      '        hoverScanTimer = setTimeout(function () {',
      '          hoverScanTimer = null;',
      '          scanFloatingContainers();',
      '        }, 50);',
      '',
      '        if (isWorkbenchOrRoot(target)) return;',
      '',
      '        var now = Date.now ? Date.now() : (+new Date());',
      '        if (now - lastHoverTime < 120) return;',
      '        lastHoverTime = now;',
      '',
      '        disconnectObserver();',
      '        try {',
      '          currentScanId++;',
      '          var hScanId = currentScanId;',
      '          translateElement(target, hScanId);',
      '          if (target.parentElement && !isWorkbenchOrRoot(target.parentElement)) {',
      '            translateElement(target.parentElement, hScanId);',
      '          }',
      '        } catch (e) {}',
      '        reconnectObserver();',
      '      };'
    ].join('\n')
  );

  if (patched !== runtimeContent) {
    try {
      new vm.Script(patched, { filename: 'i18n-runtime-hotfix.js' });
      return patched;
    } catch (_) {
      return runtimeContent;
    }
  }
  return runtimeContent;
}

function getChineseBundleScript(options = {}) {
  const { dictPath, runtimePath } = resolveEffectiveChinesePaths(options);
  const { json: safeDictJson } = parseAndSerializeDict(dictPath);
  const rawRuntimeContent = fs.readFileSync(runtimePath, 'utf-8');
  const runtimeContent = applyRuntimePerformanceHotfix(rawRuntimeContent);
  return '\n// --- Antigravity Chinese Localization Injection Start ---\n(function() {\n  try {\n    window.__AGY_I18N_DATA__ = ' + safeDictJson + ';\n    ' + runtimeContent + '\n  } catch(e) {\n    console.error(\'[AGY-i18n] Runtime Injection Error:\', e);\n  }\n})();\n// --- Antigravity Chinese Localization Injection End ---\n';
}

function transformPreload(content, options = {}, enableChinese = true) {
  if (content.includes('Antigravity Chinese Localization Injection')) {
    const regex = /\/\/ --- Antigravity Chinese Localization Injection Start ---[\s\S]*?\/\/ --- Antigravity Chinese Localization Injection End ---/g;
    content = content.replace(regex, '');
  }
  content = stripHudBlocks(content);
  if (!/\belectron_1\b/.test(content)) {
    throw new Error('dist/preload.js 缺少预期的 electron_1 绑定，拒绝注入');
  }
  if (enableChinese) {
    content += '\n' + getChineseBundleScript(options);
  }
  content += hudCli.getHudBundleScript();
  return content;
}

function localTransformMenu(content) {
  const replacements = [
    { from: "'New Window'", to: "'新建窗口'" },
    { from: '"New Window"', to: '"新建窗口"' },
    { from: "'Docs'", to: "'官方文档'" },
    { from: '"Docs"', to: '"官方文档"' },
    { from: "'Command Palette'", to: "'命令面板'" },
    { from: '"Command Palette"', to: '"命令面板"' },
    { from: "'Maximize'", to: "'最大化'" },
    { from: '"Maximize"', to: '"最大化"' },
    { from: "'Minimize'", to: "'最小化'" },
    { from: '"Minimize"', to: '"最小化"' },
    { from: "'Close Window'", to: "'关闭窗口'" },
    { from: '"Close Window"', to: '"关闭窗口"' },
    { from: "'Toggle Full Screen'", to: "'切换全屏'" },
    { from: '"Toggle Full Screen"', to: '"切换全屏"' },
    { from: "'Zoom In'", to: "'放大'" },
    { from: '"Zoom In"', to: '"放大"' },
    { from: "'Zoom Out'", to: "'缩小'" },
    { from: '"Zoom Out"', to: '"缩小"' },
    { from: "'Reset Zoom'", to: "'重置缩放'" },
    { from: '"Reset Zoom"', to: '"重置缩放"' },
    { from: "'Toggle Developer Tools'", to: "'切换开发者工具'" },
    { from: '"Toggle Developer Tools"', to: '"切换开发者工具"' },
    { from: 'updater_1.MenuUpdateStep.CheckForUpdates', to: '"检查更新"' },
    { from: "'Connect to WSL'", to: "'连接到 WSL'" },
    { from: '"Connect to WSL"', to: '"连接到 WSL"' },
    { from: "'Reopen Locally'", to: "'在本地重新打开'" },
    { from: '"Reopen Locally"', to: '"在本地重新打开"' },
  ];
  for (const r of replacements) {
    content = content.split(r.from).join(r.to);
  }
  return content;
}

function localTransformIpcI18n(content, options = {}) {
  const replacements = [
    { from: "'Open workspace'", to: "'打开工作区'" },
    { from: '"Open workspace"', to: '"打开工作区"' },
    { from: "'Open workspaces'", to: "'打开多个工作区'" },
    { from: '"Open workspaces"', to: '"打开多个工作区"' },
    { from: "'Folder is on the Windows filesystem'", to: "'文件夹位于 Windows 文件系统上'" },
    { from: '"Folder is on the Windows filesystem"', to: '"文件夹位于 Windows 文件系统上"' }
  ];
  for (const r of replacements) {
    content = content.split(r.from).join(r.to);
  }

  const contextMenuHeader = 'function buildContextMenuTemplate(items, onSelect) {';
  if (content.includes(contextMenuHeader)) {
    const baseMenuMap = {
      'Cut': '剪切',
      'Copy': '复制',
      'Paste': '粘贴',
      'Select All': '全选',
      'Undo': '撤销',
      'Redo': '重做',
      'Rename': '重命名',
      'Mark Unread': '标记为未读',
      'Mark Read': '标记为已读',
      'Split': '拆分',
      'Fork': '分支',
      'Archive': '归档',
      'Delete': '删除',
      'View Debug': '查看调试信息',
      'Share': '分享',
      'Pin': '置顶',
      'Unpin': '取消置顶',
      'Duplicate': '创建副本',
      'Conversation Name': '会话名称',
      'Conversation ID': '会话 ID',
      'Project Name': '项目名称',
      'Project ID': '项目 ID',
      'File Path': '文件路径',
      'Relative Path': '相对路径',
      'Branch Name': '分支名称',
      'Commit Hash': '提交哈希',
      'Copy Path': '复制路径',
      'Copy Relative Path': '复制相对路径',
      'Copy Link': '复制链接',
      'Copy Markdown': '复制 Markdown',
      'Copy Content': '复制内容',
      'Split Right': '向右拆分',
      'Split Down': '向下拆分',
      'Split Up': '向上拆分',
      'Split Left': '向左拆分',
      'Replace With New': '替换为新会话',
      'Replace with New': '替换为新会话',
      'Replace with new': '替换为新会话',
      'Move to Group': '移动到分组',
      'Move to group': '移动到分组',
      'Close': '关闭',
      'Close Others': '关闭其他',
      'Close to the Right': '关闭右侧',
      'Close Saved': '关闭已保存',
      'Close All': '全部关闭',
      'Open in New Window': '在新窗口中打开',
      'Open in Browser': '在浏览器中打开',
      'Show in File Explorer': '在文件资源管理器中显示',
      'Show in Explorer': '在文件资源管理器中显示',
      'Reveal in File Explorer': '在文件资源管理器中显示',
      'Open in File Explorer': '在文件资源管理器中打开',
      'Show in Finder': '在访达中显示',
      'Reveal in Finder': '在访达中显示',
      'Show in File Manager': '在文件管理器中显示'
    };

    const mergedMap = {};
    const { dictPath } = resolveEffectiveChinesePaths(options);
    if (fs.existsSync(dictPath)) {
      const { parsed: d } = parseAndSerializeDict(dictPath);
      if (d && d.exact) {
        for (const [k, v] of Object.entries(d.exact)) {
          if (k.length > 0 && k.length <= 40 && typeof v === 'string') {
            mergedMap[k] = v;
          }
        }
      }
    }
    Object.assign(mergedMap, baseMenuMap);

    const injection = '\nconst __AGY_CONTEXT_MENU_MAP__ = ' + JSON.stringify(mergedMap) + ';\nfunction __agyTranslateContextLabel__(lbl) {\n  if (!lbl || typeof lbl !== \'string\') return lbl;\n  return __AGY_CONTEXT_MENU_MAP__[lbl] || lbl;\n}\n';
    const existingInjectionRegex = /\n?const __AGY_CONTEXT_MENU_MAP__ = [\s\S]*?function __agyTranslateContextLabel__[\s\S]*?\n}\n/g;
    if (existingInjectionRegex.test(content)) {
      content = content.replace(existingInjectionRegex, '');
    }
    content = injection + content;
    content = content.split("label: item.label ?? ''").join("label: __agyTranslateContextLabel__(item.label ?? '')");
  }

  return content;
}

function escapeRegExp(str) {
  return String(str).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function stripHudBlocks(content) {
  if (content.includes(hudCli.HUD_MARKER_START)) {
    const startRe = escapeRegExp(hudCli.HUD_MARKER_START);
    const endRe = escapeRegExp(hudCli.HUD_MARKER_END);
    const re = new RegExp(`${startRe}[\\s\\S]*?${endRe}`, 'g');
    content = content.replace(re, '');
  }
  return content;
}

function transformIpcHandlers(content, options = {}, enableChinese = true) {
  content = stripHudBlocks(content);
  if (!/\belectron_1\b/.test(content)) {
    throw new Error('dist/ipcHandlers.js 缺少预期的 electron_1 绑定，拒绝注入');
  }
  if (enableChinese) {
    if (options.dictPath) {
      content = localTransformIpcI18n(content, options);
    } else {
      content = viaUpstream('patchIpcHandlersFile', content, localTransformIpcI18n, options);
    }
  }
  content += hudCli.getMainIpcScript();
  return content;
}

const transformMenu = (c, opts) => viaUpstream('patchMenuFile', c, localTransformMenu, opts);
const transformMain = (c, opts) => viaUpstream('patchMainFile', c, localTransformMain, opts);
const transformTray = (c, opts) => viaUpstream('patchTrayFile', c, localTransformTray, opts);
const transformWsl = (c, opts) => viaUpstream('patchWslFile', c, localTransformWsl, opts);
const transformProvisionSplash = (c, opts) => viaUpstream('patchProvisionSplashFile', c, localTransformProvisionSplash, opts);

function transformIdeWizard(content) {
  const replacements = [
    { from: 'Welcome to Antigravity', to: '欢迎使用 Antigravity' },
    { from: 'Setting up…', to: '正在准备…' },
    { from: 'Welcome to the new Antigravity!', to: '欢迎体验全新的 Antigravity！' },
    { from: "Antigravity has been redesigned to put agents first with new capabilities. If you'd still like a code editor, you can download it as a separate app named <b>Antigravity IDE</b>.", to: 'Antigravity 经过全面重构，以强大的智能体为核心。如果您仍需要代码编辑器，可下载独立的 <b>Antigravity IDE</b> 应用。' },
    { from: 'Download the Antigravity IDE', to: '下载 Antigravity IDE' },
    { from: 'Explore the new Antigravity', to: '开始探索全新 Antigravity' }
  ];
  for (const r of replacements) {
    content = content.split(r.from).join(r.to);
  }
  return content;
}

function transformUpdater(content) {
  const replacements = [
    { from: "title: 'Check for Updates'", to: "title: '检查更新'" },
    { from: 'title: "Check for Updates"', to: 'title: "检查更新"' },
    { from: "message: 'No updates available'", to: "message: '暂无可用更新'" },
    { from: 'message: "No updates available"', to: 'message: "暂无可用更新"' },
    { from: "buttons: ['OK']", to: "buttons: ['确定']" },
    { from: 'buttons: ["OK"]', to: 'buttons: ["确定"]' },
    { from: 'MenuUpdateStep["CheckForUpdates"] = "Check for Updates"', to: 'MenuUpdateStep["CheckForUpdates"] = "检查更新"' },
    { from: 'MenuUpdateStep["CheckingForUpdates"] = "Checking for Updates..."', to: 'MenuUpdateStep["CheckingForUpdates"] = "正在检查更新..."' },
    { from: 'MenuUpdateStep["DownloadingUpdate"] = "Downloading Update..."', to: 'MenuUpdateStep["DownloadingUpdate"] = "正在下载更新..."' },
    { from: 'MenuUpdateStep["RestartToUpdate"] = "Restart to Update"', to: 'MenuUpdateStep["RestartToUpdate"] = "重启以应用更新"' }
  ];
  for (const r of replacements) {
    content = content.split(r.from).join(r.to);
  }
  return content;
}

function localTransformMain(content) {
  content = content.replace(/label:\s*['"]No agents running['"]/g, "label: '无正在运行的智能体'");
  content = content.replace(/label:\s*`Open \$\{([^\}]+)\}`/g, "label: `打开 ${$1}`");
  content = content.replace(/label:\s*['"]Open ['"]\s*\+\s*([a-zA-Z0-9_\.]+\.getName\(\))/g, "label: '打开 ' + $1");
  content = content.replace(/label:\s*['"]Quit['"]/g, "label: '退出'");
  content = content.replace(/title:\s*['"]Confirm Quit['"]/g, "title: '确认退出'");
  content = content.replace(/message:\s*['"]Are you sure you want to quit\?['"]/g, "message: '您确定要退出吗？'");
  content = content.replace(/detail:\s*['"]There may be agents or background tasks running\.['"]/g, "detail: '可能仍有正在运行的智能体或后台任务。'");
  content = content.replace(/buttons:\s*\[\s*['"]Cancel['"]\s*,\s*['"]Quit['"]\s*\]/g, "buttons: ['取消', '退出']");
  content = content.replace(/['"]Binary not found['"]/g, "'未找到二进制文件'");
  content = content.replace(/['"]Startup failed['"]/g, "'启动失败'");
  content = content.replace(/label:\s*['"]New Window['"]/g, "label: '新建窗口'");
  content = content.replace(/title:\s*['"]WSL distro not found['"]/g, "title: '未找到 WSL 发行版'");
  content = content.replace(/['"]WSL distro not found['"]/g, "'未找到 WSL 发行版'");
  content = content.replace(/['"]Antigravity opened on Windows instead\.['"]/g, "'Antigravity 已改为在 Windows 本地打开。'");
  return content;
}

function localTransformWsl(content) {
  content = content.replace(/This folder is on the Windows filesystem\. Accessing it from WSL \(via \/mnt\) can be slow — for best performance keep projects inside the WSL filesystem\./g, '此文件夹位于 Windows 文件系统上。从 WSL 访问该目录（通过 /mnt）可能会较慢 —— 为获得最佳性能，建议将项目保留在 WSL 文件系统内。');
  content = content.replace(/This location cannot be opened in WSL:/g, '此位置无法在 WSL 中打开：');
  content = content.replace(/Downloading the Antigravity binary(?:\u2026|\\u2026|\.{3})/g, '正在下载 Antigravity 二进制组件…');
  content = content.replace(/Installing into \$\{distro\}(?:\u2026|\\u2026|\.{3})/g, '正在安装至 ${distro}…');
  return content;
}

function localTransformProvisionSplash(content) {
  content = content.replace(/Setting up WSL:\s*\$\{escapeHtml\(distro\)\}/g, '正在准备 WSL 环境：${escapeHtml(distro)}');
  return content;
}

function localTransformTray(content) {
  const dynamicRegex = /\(count\s*>\s*0\s*\?\s*`\$\{count\}`\s*:\s*['"]No['"]\)\s*\+\s*['"] agent['"]\s*\+\s*\(count\s*===\s*1\s*\?\s*['"]['"]\s*:\s*['"]s['"]\)\s*\+\s*['"] running['"]/g;
  if (dynamicRegex.test(content)) {
    content = content.replace(dynamicRegex, "(count > 0 ? `${count} 个正在运行的智能体` : '无正在运行的智能体')");
  } else {
    content = content.split("' agent' + (count === 1 ? '' : 's') + ' running'").join("' 个正在运行的智能体'");
    content = content.split('" agent" + (count === 1 ? "" : "s") + " running"').join('" 个正在运行的智能体"');
    content = content.split("'No agents running'").join("'无正在运行的智能体'");
    content = content.split('"No agents running"').join('"无正在运行的智能体"');
  }
  return content;
}

/**
 * Core In-Memory ASAR Patching Engine
 * Takes an unpatched (or previously patched) ASAR Buffer and returns a freshly patched ASAR Buffer.
 */
function patchAsarBufferInMemory(sourceBuf, options = {}) {
  if (!isValidAsarBuffer(sourceBuf)) {
    throw new Error('Invalid ASAR header format');
  }

  const headerPickleLen = sourceBuf.readUInt32LE(4);
  const jsonLen = sourceBuf.readUInt32LE(12);
  const origDataBase = 8 + headerPickleLen;
  const root = JSON.parse(sourceBuf.subarray(16, 16 + jsonLen).toString('utf8'));

  if (!root.files || !root.files.dist || !root.files.dist.files) {
    throw new Error('ASAR missing dist/ directory in header');
  }

  const distFiles = root.files.dist.files;
  const modifiedBuffers = new Map();

  function readNodeText(node) {
    const size = Number(node.size || 0);
    const start = origDataBase + Number(node.offset);
    const end = start + size;
    if (!Number.isFinite(start) || !Number.isFinite(end) || start < origDataBase || start < 0 || end < start || end > sourceBuf.length) {
      throw new Error(`ASAR 节点读取越界 (offset=${node.offset}, size=${node.size}, length=${sourceBuf.length})`);
    }
    return sourceBuf.subarray(start, end).toString('utf8');
  }

  function applyTransform(node, transformFn, filename = 'unknown.js') {
    if (!node || node.files || node.unpacked) return;
    const origText = readNodeText(node);
    const newText = transformFn(origText);
    if (filename.endsWith('.js') || filename.endsWith('.cjs')) {
      try {
        new vm.Script(newText, { filename });
      } catch (err) {
        throw new Error(`JS 语法校验失败 (${filename}): ${err.message}`);
      }
    }
    const newBuf = Buffer.from(newText, 'utf8');
    modifiedBuffers.set(node, newBuf);
  }

  // 1. Validate required files & transform target files in dist/
  if (!distFiles['preload.js'] || distFiles['preload.js'].files || distFiles['preload.js'].unpacked) {
    throw new Error('ASAR missing required dist/preload.js');
  }
  if (!distFiles['ipcHandlers.js'] || distFiles['ipcHandlers.js'].files || distFiles['ipcHandlers.js'].unpacked) {
    throw new Error('ASAR missing required dist/ipcHandlers.js');
  }

  const enableChinese = shouldEnableChinese(options);

  applyTransform(distFiles['preload.js'], c => transformPreload(c, options, enableChinese), 'dist/preload.js');
  applyTransform(distFiles['ipcHandlers.js'], c => transformIpcHandlers(c, options, enableChinese), 'dist/ipcHandlers.js');
  if (enableChinese) {
    applyTransform(distFiles['menu.js'], c => transformMenu(c, options), 'dist/menu.js');
    if (distFiles['ideInstall'] && distFiles['ideInstall'].files) {
      applyTransform(distFiles['ideInstall'].files['wizardHtml.js'], transformIdeWizard, 'dist/ideInstall/wizardHtml.js');
    }
    applyTransform(distFiles['updater.js'], transformUpdater, 'dist/updater.js');
    applyTransform(distFiles['main.js'], c => transformMain(c, options), 'dist/main.js');
    applyTransform(distFiles['tray.js'], c => transformTray(c, options), 'dist/tray.js');
    applyTransform(distFiles['wsl.js'], c => transformWsl(c, options), 'dist/wsl.js');
    applyTransform(distFiles['provisionSplash.js'], c => transformProvisionSplash(c, options), 'dist/provisionSplash.js');
  }

  // 2. Inject dist/agyHudTelemetryParser.cjs in alphabetical key order inside dist.files
  const parserBuf = fs.readFileSync(PARSER_SRC_PATH);
  new vm.Script(parserBuf.toString('utf8'), { filename: 'dist/agyHudTelemetryParser.cjs' });
  const parserNode = {
    size: parserBuf.length,
    offset: '0',
    integrity: computeIntegrity(parserBuf)
  };
  modifiedBuffers.set(parserNode, parserBuf);

  const newDistFiles = {};
  const allDistKeys = Array.from(new Set([...Object.keys(distFiles), 'agyHudTelemetryParser.cjs'])).sort();
  for (const k of allDistKeys) {
    newDistFiles[k] = k === 'agyHudTelemetryParser.cjs' ? parserNode : distFiles[k];
  }
  root.files.dist.files = newDistFiles;

  // 3. Recompute offsets & integrity for modified nodes and collect sequential data chunks
  const dataChunks = [];
  let currentOffset = 0;

  function walkAndCollect(node) {
    if (node.files) {
      for (const child of Object.values(node.files)) {
        walkAndCollect(child);
      }
      return;
    }
    if (node.unpacked || node.link !== undefined) {
      // unpacked files live in app.asar.unpacked; symlink nodes carry no data
      return;
    }

    let fileBuf;
    if (modifiedBuffers.has(node)) {
      fileBuf = modifiedBuffers.get(node);
      node.size = fileBuf.length;
      node.integrity = computeIntegrity(fileBuf);
    } else {
      const size = Number(node.size || 0);
      const start = origDataBase + Number(node.offset);
      const end = start + size;
      if (!Number.isFinite(start) || !Number.isFinite(end) || start < origDataBase || start < 0 || end < start || end > sourceBuf.length) {
        throw new Error(`ASAR 数据块切片越界 (offset=${node.offset}, size=${node.size}, length=${sourceBuf.length})`);
      }
      fileBuf = sourceBuf.subarray(start, end);
    }

    node.offset = String(currentOffset);
    dataChunks.push(fileBuf);
    currentOffset += fileBuf.length;
  }

  walkAndCollect(root);

  // 4. Rebuild Chromium Pickle + JSON header and concatenate with dataChunks
  const newJsonBuf = Buffer.from(JSON.stringify(root), 'utf8');
  const newJsonLen = newJsonBuf.length;
  const paddedJsonLen = Math.ceil(newJsonLen / 4) * 4;
  const headerPayloadSize = 4 + paddedJsonLen;
  const newHeaderPickleLen = 4 + headerPayloadSize;

  const headerBuf = Buffer.alloc(8 + newHeaderPickleLen, 0);
  headerBuf.writeUInt32LE(4, 0);
  headerBuf.writeUInt32LE(newHeaderPickleLen, 4);
  headerBuf.writeUInt32LE(headerPayloadSize, 8);
  headerBuf.writeUInt32LE(newJsonLen, 12);
  newJsonBuf.copy(headerBuf, 16);

  const outBuf = Buffer.concat([headerBuf, ...dataChunks], headerBuf.length + currentOffset);
  verifyPatchedAsarIntegrity(outBuf, { expectChinese: enableChinese });
  return outBuf;
}

function getI18nVersion(options = {}) {
  const { pkgPath } = resolveEffectiveChinesePaths(options);
  const pkg = readJsonSafe(pkgPath);
  return (pkg && pkg.version) || 'unknown';
}

/** Read "version" from the archive's root package.json (used to detect stale backups). */
function readAsarAppVersion(buf) {
  try {
    if (!isValidAsarBuffer(buf)) return null;
    const headerPickleLen = buf.readUInt32LE(4);
    const jsonLen = buf.readUInt32LE(12);
    const base = 8 + headerPickleLen;
    const root = JSON.parse(buf.subarray(16, 16 + jsonLen).toString('utf8'));
    const node = root.files && root.files['package.json'];
    if (!node || node.unpacked || node.files) return null;
    const start = base + Number(node.offset);
    const end = start + Number(node.size || 0);
    if (!Number.isFinite(start) || !Number.isFinite(end) || start < base || start < 0 || end < start || end > buf.length) return null;
    const pkg = JSON.parse(buf.subarray(start, end).toString('utf8'));
    return pkg.version || null;
  } catch (_) {
    return null;
  }
}

function writeFileSyncWithFsync(filePath, data) {
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(String(data), 'utf8');
  const fd = fs.openSync(filePath, 'w');
  try {
    let offset = 0;
    while (offset < buf.length) {
      offset += fs.writeSync(fd, buf, offset, buf.length - offset);
    }
    fs.fsyncSync(fd);
  } finally {
    try { fs.closeSync(fd); } catch (_) {}
  }
}

function writeFileAtomic(file, data) {
  const tmp = `${file}.tmp-${process.pid}`;
  try {
    writeFileSyncWithFsync(tmp, data);
    fs.renameSync(tmp, file);
  } finally {
    try {
      if (fs.existsSync(tmp)) fs.rmSync(tmp, { force: true });
    } catch (_) {}
  }
}

function sleepMs(ms) {
  try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); } catch (_) {}
}

// Crash recovery: an interrupted swap may leave only app.asar.swap-old behind.
function tryRecoverSwappedAsar(asarPath) {
  if (!asarPath) return false;
  const swapOld = path.join(path.dirname(asarPath), 'app.asar.swap-old');
  if (!fs.existsSync(asarPath) && fs.existsSync(swapOld)) {
    fs.renameSync(swapOld, asarPath);
    console.log(`   [INFO] 检测到上次中断遗留的 ${swapOld}，已恢复为 app.asar`);
    return true;
  }
  return false;
}

function resolveTargetAsar(customPath) {
  const candidates = [];
  if (customPath) {
    const resolved = path.resolve(customPath);
    if (fs.existsSync(resolved) && fs.statSync(resolved).isDirectory()) {
      candidates.push(
        path.join(resolved, 'resources', 'app.asar'),
        path.join(resolved, 'Contents', 'Resources', 'app.asar'),
        path.join(resolved, 'app.asar')
      );
    } else {
      candidates.push(resolved);
    }
  } else {
    const defaultCandidates = typeof hudCli.getCandidateAsarPaths === 'function'
      ? hudCli.getCandidateAsarPaths()
      : [path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'Programs', 'antigravity', 'resources', 'app.asar')];
    candidates.push(...defaultCandidates);
  }
  for (const c of candidates) {
    try { tryRecoverSwappedAsar(c); } catch (_) {}
  }
  return hudCli.findAsarPath(customPath);
}

function findExeForAsar(asarPath, customExePath) {
  if (customExePath && fs.existsSync(customExePath)) return customExePath;
  if (!asarPath) return null;
  const resDir = path.dirname(asarPath);
  const candidates = [
    path.join(resDir, '..', 'Antigravity.exe'),
    path.join(resDir, 'Antigravity.exe'),
    path.join(resDir, '..', 'Frameworks', 'Electron Framework.framework', 'Electron Framework'),
    path.join(resDir, '..', 'MacOS', 'Antigravity'),
    path.join(resDir, '..', 'antigravity'),
    path.join(resDir, 'antigravity')
  ];
  for (const c of candidates) {
    try {
      if (fs.existsSync(c) && fs.statSync(c).isFile()) return c;
    } catch (_) {}
  }
  return null;
}

/**
 * Inspect Electron Fuses in the client binary for sentinel dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX.
 * Fuse byte at index 4 is EnableEmbeddedAsarIntegrityValidation (currently '0' in '101100011').
 * If it is '1', modifying app.asar without re-embedding the binary resource hash will brick launch.
 */
function checkElectronAsarFuse(asarPath, options = {}) {
  const exePath = findExeForAsar(asarPath, options.exePath);
  if (!exePath) return { checked: false, exePath: null };
  const buf = fs.readFileSync(exePath);
  const sentinelBuf = Buffer.from(FUSE_SENTINEL, 'ascii');
  const idx = buf.indexOf(sentinelBuf);
  if (idx === -1 || idx + 34 >= buf.length) {
    return { checked: false, exePath, reason: 'sentinel_not_found' };
  }
  const version = buf[idx + 32];
  const wireLen = buf[idx + 33];
  if (idx + 34 + wireLen > buf.length || wireLen <= FUSE_ASAR_INTEGRITY_INDEX) {
    return { checked: false, exePath, reason: 'invalid_wire_length' };
  }
  const wire = buf.subarray(idx + 34, idx + 34 + wireLen).toString('ascii');
  const integrityBit = wire[FUSE_ASAR_INTEGRITY_INDEX];
  if (integrityBit === '1') {
    throw new Error(
      `检测到 ${path.basename(exePath)} 已启用 EnableEmbeddedAsarIntegrityValidation (Fuse 第 4 位为 '1', wire=${wire})，直接修改 app.asar 会导致客户端拒绝启动，已中止补丁`
    );
  }
  return { checked: true, exePath, version, wire, integrityBit };
}

const SIDECAR_CMDLINE_RE = /sidecar_sdk[\\/]register_loader\.js|(?:^|[\s"\\/])sidecars[\\/]|mcp_entry\.cjs/i;

/**
 * Classify running Antigravity processes for an installation directory.
 * Returns { activeCount, orphanSidecarPids, orphanParentCmdPids }.
 * Fail-safe: any process without a sidecar command line (or when language_server is alive,
 * or any process has a window handle, or command line is unreadable) is treated as active.
 */
function classifyInstallProcesses(antigravityProcs, lsCount = 0, cmdProcsMap = new Map()) {
  const list = Array.isArray(antigravityProcs) ? antigravityProcs : [];
  if (list.length === 0) {
    return { activeCount: 0, orphanSidecarPids: [], orphanParentCmdPids: [] };
  }
  if (lsCount > 0) {
    return { activeCount: list.length, orphanSidecarPids: [], orphanParentCmdPids: [] };
  }
  for (const p of list) {
    if (p.hasWindow) {
      return { activeCount: list.length, orphanSidecarPids: [], orphanParentCmdPids: [] };
    }
    const cmd = typeof p.commandLine === 'string' ? p.commandLine.trim() : '';
    if (!cmd || /--type=/i.test(cmd) || !SIDECAR_CMDLINE_RE.test(cmd)) {
      return { activeCount: list.length, orphanSidecarPids: [], orphanParentCmdPids: [] };
    }
  }
  const orphanSidecarPids = list.map(p => Number(p.pid)).filter(id => Number.isInteger(id) && id > 0);
  const orphanParentCmdPids = [];
  for (const p of list) {
    const ppid = Number(p.parentPid);
    if (Number.isInteger(ppid) && ppid > 0 && cmdProcsMap.has(ppid)) {
      const parentCmd = String(cmdProcsMap.get(ppid) || '');
      if (/agy-node\.cmd/i.test(parentCmd) && !orphanParentCmdPids.includes(ppid)) {
        orphanParentCmdPids.push(ppid);
      }
    }
  }
  return { activeCount: 0, orphanSidecarPids, orphanParentCmdPids };
}

function isProtectedAgentEnv() {
  return Boolean(
    process.env.ANTIGRAVITY_AGENT ||
    process.env.ANTIGRAVITY_CONVERSATION_ID ||
    process.env.ANTIGRAVITY_AGENTAPI_EXE ||
    process.env.AGY_NO_KILL === '1'
  );
}

function resolveInstallRootFromAsar(asarPath) {
  const resDir = path.dirname(asarPath);
  if (path.basename(resDir).toLowerCase() === 'resources') {
    const parentDir = path.dirname(resDir);
    if (path.basename(parentDir).toLowerCase() === 'contents' && path.dirname(parentDir).toLowerCase().endsWith('.app')) {
      return path.dirname(parentDir).replace(/[\\/]+$/, '');
    }
    return parentDir.replace(/[\\/]+$/, '');
  }
  return resDir.replace(/[\\/]+$/, '');
}

function ensureTargetNotRunning(asarPath) {
  const installDir = resolveInstallRootFromAsar(asarPath);
  if (!fs.existsSync(installDir)) return;
  const rerunHint = process.platform === 'win32' ? 'patch.bat' : 'node cli.js install';
  if (process.platform === 'win32') {
    try {
      const updaterDir = path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'antigravity-updater').replace(/[\\/]+$/, '');
      const psScript = [
        '[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false);',
        `$d = '${installDir.replace(/'/g, "''")}';`,
        `$u = '${updaterDir.replace(/'/g, "''")}';`,
        '$de = [WildcardPattern]::Escape($d);',
        '$ue = [WildcardPattern]::Escape($u);',
        `$skip = @('Antigravity.exe','powershell.exe','pwsh.exe','cmd.exe','conhost.exe','node.exe','git.exe','rg.exe');`,
        `$ag = @(Get-Process -Name 'Antigravity' -ErrorAction SilentlyContinue | Where-Object { $_.Path -and ($_.Path -like "$de\\*") });`,
        `$ls = @(Get-Process -Name 'language_server*' -ErrorAction SilentlyContinue | Where-Object { $_.Path -and ($_.Path -like "$de\\*") }).Count;`,
        `$cim = @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue);`,
        `$map = @{}; foreach ($c in $cim) { $map[[int]$c.ProcessId] = $c };`,
        `$agList = foreach ($p in $ag) { $c = $map[[int]$p.Id]; [PSCustomObject]@{ pid = [int]$p.Id; hasWindow = ($p.MainWindowHandle -ne [IntPtr]::Zero); parentPid = if ($c) { [int]$c.ParentProcessId } else { 0 }; commandLine = if ($c) { [string]$c.CommandLine } else { '' } } };`,
        `$cmdList = foreach ($c in $cim) { if ($c.Name -ieq 'cmd.exe') { [PSCustomObject]@{ pid = [int]$c.ProcessId; commandLine = [string]$c.CommandLine } } };`,
        `$upd = @(foreach ($c in $cim) { if ([int]$c.ProcessId -eq $PID) { continue }; $n = [string]$c.Name; if (($n -in $skip) -or ($n -like 'language_server*')) { continue }; $e = [string]$c.ExecutablePath; $m = [string]$c.CommandLine; if (($e -and (($e -like "$ue\\*") -or ($e -like "$de\\Uninstall*"))) -or ($m -and (($m -like '*antigravity-updater*') -or ($m -like '*Uninstall Antigravity*') -or ($m -like "*_?=$de*"))) -or ($n -ieq 'installer.exe' -and $m -like '*--updated*')) { [int]$c.ProcessId } }).Count;`,
        `[PSCustomObject]@{ ls = $ls; upd = $upd; ag = @($agList); cmd = @($cmdList) } | ConvertTo-Json -Compress -Depth 4`
      ].join(' ');
      const out = execFileSync('powershell', ['-NoLogo', '-NoProfile', '-Command', psScript], {
        encoding: 'utf8', timeout: 5000, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe']
      }).trim();
      const parsed = JSON.parse(out || '{"ls":0,"upd":0,"ag":[],"cmd":[]}');
      if (Number(parsed.upd) > 0) {
        throw new Error(`检测到 Antigravity 官方自动更新安装程序正在运行，请等待更新完成后再运行 ${rerunHint}`);
      }
      const cmdMap = new Map((parsed.cmd || []).map(c => [Number(c.pid), String(c.commandLine || '')]));
      const classified = classifyInstallProcesses(parsed.ag || [], Number(parsed.ls) || 0, cmdMap);
      if (classified.activeCount > 0) {
        throw new Error(`检测到目标目录 (${installDir}) 下有 ${classified.activeCount} 个 Antigravity 进程正在运行，请先退出客户端后再运行 ${rerunHint}`);
      }
      if (classified.orphanSidecarPids.length > 0 && !isProtectedAgentEnv()) {
        const pidsToKill = [...classified.orphanParentCmdPids, ...classified.orphanSidecarPids];
        for (const pid of pidsToKill) {
          try { process.kill(pid, 'SIGKILL'); } catch (_) {}
        }
        sleepMs(200);
        console.log(`   [INFO] 已自动清理 ${classified.orphanSidecarPids.length} 个上次退出残留的插件 Sidecar 进程。`);
      }
    } catch (err) {
      if (err.message && err.message.includes('正在运行')) throw err;
    }
  } else {
    try {
      const out = execFileSync('ps', ['-ax', '-o', 'pid=,args='], {
        encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'pipe']
      });
      const prefixPlain = `${installDir}/`;
      const prefixQuoted = `"${installDir}/`;
      let lsCount = 0;
      const appProcs = [];
      for (const rawLine of out.split(/\r?\n/)) {
        const m = rawLine.trim().match(/^(\d+)\s+(.+)$/);
        if (!m) continue;
        const pid = Number(m[1]);
        const argsStr = m[2].trim();
        if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid || pid === process.ppid) continue;
        if (!argsStr.startsWith(prefixPlain) && !argsStr.startsWith(prefixQuoted)) continue;
        if (/(?:^|\/)language_server(?:_[a-z0-9_]+)?(?:\s|"|$)/i.test(argsStr)) {
          lsCount++;
        } else {
          appProcs.push({ pid, hasWindow: false, parentPid: 0, commandLine: argsStr });
        }
      }
      const classified = classifyInstallProcesses(appProcs, lsCount, new Map());
      if (classified.activeCount > 0 || lsCount > 0) {
        const runningTotal = classified.activeCount || lsCount;
        throw new Error(`检测到目标目录 (${installDir}) 下有 ${runningTotal} 个 Antigravity 进程正在运行，请先退出客户端后再运行 ${rerunHint}`);
      }
      if (classified.orphanSidecarPids.length > 0 && !isProtectedAgentEnv()) {
        for (const pid of classified.orphanSidecarPids) {
          try { process.kill(pid, 'SIGKILL'); } catch (_) {}
        }
        sleepMs(200);
        console.log(`   [INFO] 已自动清理 ${classified.orphanSidecarPids.length} 个上次退出残留的插件 Sidecar 进程。`);
      }
    } catch (err) {
      if (err.message && err.message.includes('正在运行')) throw err;
    }
  }
}

function verifyAppliedAsar(asarPath, expectedFp, verifyOpts = {}) {
  const buf = fs.readFileSync(asarPath);
  verifyPatchedAsarIntegrity(buf, verifyOpts);
  const fp = getAsarFingerprintFromBuffer(buf);
  if (fp !== expectedFp) throw new Error(`写入后的 app.asar 指纹不一致 (${fp} != ${expectedFp})`);
}

function fastPatchAsar(options = {}) {
  const startTime = Date.now();
  const asarPath = resolveTargetAsar(options.customPath);
  if (!asarPath || !fs.existsSync(asarPath)) {
    throw new Error(`未找到目标 app.asar: ${options.customPath || '(默认安装路径)'}`);
  }

  const enableChinese = shouldEnableChinese(options);
  const resourcesDir = path.dirname(asarPath);
  const backupPath = path.join(resourcesDir, 'app.asar.bak');
  const backupFpPath = path.join(resourcesDir, 'app.asar.bak.fingerprint');
  const patchedCachePath = path.join(resourcesDir, 'app.asar.patched');
  const patchedCacheMetaPath = patchedCachePath + '.json';
  const metaPath = path.join(resourcesDir, '.antigravity_chinese_meta.json');

  if (!options.skipProcessCheck) {
    ensureTargetNotRunning(asarPath);
  }

  // Fuse check before touching anything
  checkElectronAsarFuse(asarPath, options);

  // 1. Deploy global plugin unless explicitly skipped
  if (!options.skipPlugins) {
    hudCli.installPlugin();
  }

  const currentAsarBuf = fs.readFileSync(asarPath);
  if (!isValidAsarBuffer(currentAsarBuf)) {
    let recoveryHint = '';
    try {
      if (fs.existsSync(backupPath)) {
        const bakBuf = fs.readFileSync(backupPath);
        if (isValidAsarBuffer(bakBuf)) {
          const bakFp = getAsarFingerprintFromBuffer(bakBuf);
          const meta = readJsonSafe(metaPath);
          const recordedFp = (meta && meta.sourceFingerprint) ||
            (fs.existsSync(backupFpPath) ? fs.readFileSync(backupFpPath, 'utf8').trim() : null);
          if (recordedFp && bakFp === recordedFp) {
            recoveryHint = `（检测到有效且指纹与元数据一致的纯净备份，请手动将 "${backupPath}" 复制为 "${asarPath}" 进行恢复）`;
          }
        }
      }
    } catch (_) {}
    // Never fall back to copying a prebuilt cache: it may come from another app version.
    throw new Error(`目标文件不是有效的 ASAR 归档，已中止${recoveryHint}`);
  }

  // 2. Maintain pristine upstream backup (app.asar.bak) — single source of truth for backups
  const currentIsPatched = hasAnyPatchMarker(currentAsarBuf);
  const currentFp = getAsarFingerprintFromBuffer(currentAsarBuf);
  let prevFp = null;
  if (fs.existsSync(backupFpPath)) {
    try { prevFp = fs.readFileSync(backupFpPath, 'utf8').trim(); } catch (_) {}
  }

  if (!currentIsPatched) {
    if (!fs.existsSync(backupPath) || currentFp !== prevFp) {
      writeFileAtomic(backupPath, currentAsarBuf);
      fs.writeFileSync(backupFpPath, currentFp, 'utf8');
      console.log(`   [OK] 已创建/更新官方纯净基准备份: ${backupPath} (指纹: ${currentFp})`);
    } else {
      console.log(`   [INFO] 官方纯净备份已是最新 (指纹: ${currentFp})`);
    }
  } else {
    console.log('   [INFO] 当前 app.asar 已处于补丁状态，保留现有纯净备份');
  }

  // 3. Select clean source buffer: prefer the pristine backup ONLY if both versions are readable and identical.
  let sourceBuf = currentAsarBuf;
  let sourceLabel = 'app.asar';
  if (currentIsPatched) {
    let bakBuf = null;
    try { bakBuf = fs.existsSync(backupPath) ? fs.readFileSync(backupPath) : null; } catch (_) {}
    if (bakBuf && isValidAsarBuffer(bakBuf) && !hasAnyPatchMarker(bakBuf)) {
      const curVer = readAsarAppVersion(currentAsarBuf);
      const bakVer = readAsarAppVersion(bakBuf);
      if (curVer && bakVer && curVer === bakVer) {
        sourceBuf = bakBuf;
        sourceLabel = 'app.asar.bak';
      } else if (!curVer || !bakVer) {
        console.warn(`   [WARN] 无法读取版本号 (当前: ${curVer || '未知'}, 备份: ${bakVer || '未知'})，不使用 app.asar.bak，改为基于当前文件重新补丁`);
      } else {
        console.warn(`   [WARN] 纯净备份版本 (${bakVer}) 与当前客户端版本 (${curVer}) 不一致，改为基于当前文件重新补丁`);
      }
    } else {
      console.warn('   [WARN] 未找到可用的纯净备份，将基于当前（已补丁）文件重新补丁');
    }
  }
  const sourceFp = getAsarFingerprintFromBuffer(sourceBuf);

  // 4. Patch in memory and self-check
  const patchedBuf = patchAsarBufferInMemory(sourceBuf, options);
  verifyPatchedAsarIntegrity(patchedBuf, { expectChinese: enableChinese });
  const newFp = getAsarFingerprintFromBuffer(patchedBuf);

  // Remove stale prebuilt caches so nothing can ever copy an outdated archive over a newer app.
  for (const f of [patchedCachePath, patchedCacheMetaPath]) {
    try { if (fs.existsSync(f)) fs.rmSync(f, { force: true }); } catch (_) {}
  }

  // 5. Atomically apply patchedBuf to asarPath:
  //    - Write app.asar.new with open + write + fsync + close
  //    - Copy current app.asar to app.asar.swap-old first
  //    - Directly renameSync(app.asar.new, app.asar) (overwriting target on Windows to minimize missing-asar window)
  const swapOldAsar = path.join(resourcesDir, 'app.asar.swap-old');
  const tempNewAsar = path.join(resourcesDir, 'app.asar.new');
  writeFileSyncWithFsync(tempNewAsar, patchedBuf);

  try {
    fs.copyFileSync(asarPath, swapOldAsar);
  } catch (copyErr) {
    try { fs.rmSync(tempNewAsar, { force: true }); } catch (_) {}
    throw new Error(`创建替换前临时备份 (${swapOldAsar}) 失败，未修改 app.asar: ${copyErr.message}`);
  }

  let replaceSuccess = false;
  let lastErr = null;

  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      fs.renameSync(tempNewAsar, asarPath);
      replaceSuccess = true;
      break;
    } catch (err) {
      lastErr = err;
      if (attempt < 4) sleepMs(200);
    }
  }

  const rollback = () => {
    let rolledBack = false;
    let rollbackErr = null;
    if (fs.existsSync(swapOldAsar)) {
      try {
        fs.renameSync(swapOldAsar, asarPath);
        rolledBack = true;
      } catch (err1) {
        try {
          fs.copyFileSync(swapOldAsar, asarPath);
          fs.rmSync(swapOldAsar, { force: true });
          rolledBack = true;
        } catch (err2) {
          rollbackErr = err2 || err1;
        }
      }
    }
    if (fs.existsSync(tempNewAsar)) {
      try { fs.rmSync(tempNewAsar, { force: true }); } catch (_) {}
    }
    return { rolledBack, rollbackErr };
  };

  if (!replaceSuccess) {
    const rb = rollback();
    const errMsg = lastErr ? lastErr.message : 'unknown';
    if (rb.rolledBack) {
      throw new Error(`替换 app.asar 失败 (文件可能仍被占用)，已回滚: ${errMsg}`);
    }
    throw new Error(
      `替换 app.asar 失败 (${errMsg})，且自动回滚失败 (${rb.rollbackErr ? rb.rollbackErr.message : '未知错误'})！请手动将 "${swapOldAsar}" 或 "${backupPath}" 复制为 "${asarPath}" 进行恢复`
    );
  }

  // 6. Post-condition verification BEFORE discarding the previous archive
  try {
    if (typeof options.afterSwapHook === 'function') {
      options.afterSwapHook(asarPath, swapOldAsar);
    }
    verifyAppliedAsar(asarPath, newFp, { expectChinese: enableChinese });
  } catch (err) {
    const rb = rollback();
    if (rb.rolledBack) {
      throw new Error(`补丁终检失败，已回滚到补丁前状态: ${err.message}`);
    }
    throw new Error(
      `补丁终检失败 (${err.message})，且自动回滚失败 (${rb.rollbackErr ? rb.rollbackErr.message : '未找到备份文件'})！请手动将 "${swapOldAsar}" 或 "${backupPath}" 复制为 "${asarPath}" 进行恢复`
    );
  }

  if (fs.existsSync(swapOldAsar)) {
    try { fs.rmSync(swapOldAsar, { force: true }); } catch (_) {}
  }

  const i18nVersion = enableChinese ? getI18nVersion(options) : 'hud-only';
  try {
    writeFileAtomic(metaPath, JSON.stringify({
      patched: true,
      patchedFingerprint: newFp,
      sourceFingerprint: sourceFp,
      appVersion: readAsarAppVersion(sourceBuf),
      i18nVersion,
      timestamp: Date.now()
    }, null, 2));
  } catch (metaErr) {
    console.warn(`   [WARN] 补丁已成功写入并生效（未回滚），但元数据记录写入失败 (${metaPath}): ${metaErr.message}`);
  }

  // 7. Fetch-only background update check when Chinese localization is active
  if (enableChinese && !options.skipBgSync) {
    try {
      const { spawnDetachedBackgroundSync } = require('./bg-sync-i18n.cjs');
      spawnDetachedBackgroundSync();
    } catch (_) {}
  }

  // 8. Patch Swarm sidecar UI/translator unless skipped or running on an isolated tmp ASAR without explicit target
  let swarmResult = null;
  const hasExplicitSwarmTarget = Boolean(
    options.swarmTargetDir ||
    process.env.ANTIGRAVITY_SWARM_BOARD_DIR ||
    process.env.AGY_SWARM_BOARD_DIR
  );
  if (!options.skipSwarm && !options.skipPlugins && !options.hudOnly && (hasExplicitSwarmTarget || !isPathInTmpDir(asarPath))) {
    try {
      const swarmZhPatch = require('./core/swarm-zh-patch.cjs');
      swarmResult = swarmZhPatch.patch({
        targetDir: options.swarmTargetDir || undefined,
        backupDir: options.swarmBackupDir || undefined,
        assetDir: options.swarmAssetDir || undefined,
        force: Boolean(options.force),
        allowMissing: !options.swarmTargetDir
      });
      if (swarmResult && swarmResult.status === 'skippedMissing') {
        console.log(`   [INFO] 未发现 Swarm 面板目录 (${swarmResult.targetDir})，已跳过 Swarm 汉化补丁`);
      } else if (swarmResult && swarmResult.status === 'alreadyPatched') {
        console.log(`   [INFO] Swarm 面板中文补丁已是最新 (${swarmResult.targetDir})`);
      } else if (swarmResult && swarmResult.status === 'patched') {
        console.log(`   [OK] Swarm 面板中文补丁已应用 (更新 ${swarmResult.updatedFiles.length} 个文件)`);
      }
    } catch (swarmErr) {
      console.warn(`   [WARN] Swarm 面板中文补丁跳过/失败: ${swarmErr.message}`);
    }
  }

  const elapsedMs = Date.now() - startTime;
  const modeLabel = enableChinese ? `中文汉化 (v${i18nVersion}) + HUD 补丁` : 'HUD 补丁 (HUD-Only 模式)';
  console.log(`   [OK] ${modeLabel}注入并终检通过 (源: ${sourceLabel})！耗时: ${elapsedMs} ms (${(patchedBuf.length / 1024 / 1024).toFixed(2)} MB)`);
  return {
    asarPath,
    elapsedMs,
    mode: 'applied',
    enableChinese,
    i18nVersion,
    sourceLabel,
    patchedFingerprint: newFp,
    swarmResult
  };
}

function isPathInTmpDir(targetPath) {
  if (!targetPath) return false;
  const resolvedTarget = path.resolve(targetPath);
  const resolvedTmp = path.resolve(os.tmpdir());
  if (process.platform === 'win32') {
    const a = resolvedTarget.toLowerCase();
    const b = resolvedTmp.toLowerCase();
    return a === b || a.startsWith(b + path.sep);
  }
  return resolvedTarget === resolvedTmp || resolvedTarget.startsWith(resolvedTmp + path.sep);
}

function printCliHelp() {
  console.log([
    '用法: node fast-patch.cjs [选项]',
    '',
    '功能: Antigravity 内存级 ASAR 补丁引擎 (支持 Chinese+HUD 双模式、HUD-Only 模式与 Swarm 面板汉化)',
    '',
    '选项:',
    '  --path <dir|app.asar>      指定 Antigravity 安装目录 (.app / 目录) 或 app.asar 路径',
    '  --hud-only                 仅注入 HUD 遥测胶囊与角色选择器，跳过中文汉化',
    '  --no-plugins               跳过同步全局 agy-hud 插件目录与 Swarm 面板汉化',
    '  --no-bg-sync               跳过后台汉化词库更新检查',
    '  --skip-process-check       跳过运行中客户端进程检测',
    '  --swarm-only               仅修补 Swarm 协作面板 (不检测客户端进程、不读写 app.asar)',
    '  --no-swarm                 跳过 Swarm 协作面板汉化补丁',
    '  --swarm-target <dir>       指定 Swarm 面板目标目录 (swarm_board)',
    '  --swarm-backup-dir <dir>   指定 Swarm 面板外部备份目录',
    '  --dry-run                  仅预览操作 (--swarm-only 时不写入磁盘)',
    '  --force                    强制重写 Swarm 面板汉化文件',
    '  -h, --help                 显示此帮助信息'
  ].join('\n'));
}

function parseFastPatchArgs(argv) {
  let customPath = null;
  let hudOnly = false;
  let skipPlugins = false;
  let skipBgSync = false;
  let skipProcessCheck = false;
  let swarmOnly = false;
  let skipSwarm = false;
  let swarmTargetDir = null;
  let swarmBackupDir = null;
  let dryRun = false;
  let force = false;
  let help = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '-h' || arg === '--help') {
      help = true;
    } else if (arg === '--path') {
      if (i + 1 >= argv.length || !argv[i + 1] || argv[i + 1].startsWith('-')) {
        throw new Error('参数 --path 缺少目标路径 (<dir|app.asar>)');
      }
      customPath = argv[++i];
    } else if (arg === '--hud-only') {
      hudOnly = true;
    } else if (arg === '--no-plugins') {
      skipPlugins = true;
    } else if (arg === '--no-bg-sync') {
      skipBgSync = true;
    } else if (arg === '--skip-process-check') {
      skipProcessCheck = true;
    } else if (arg === '--swarm-only') {
      swarmOnly = true;
    } else if (arg === '--no-swarm') {
      skipSwarm = true;
    } else if (arg === '--swarm-target') {
      if (i + 1 >= argv.length || !argv[i + 1] || argv[i + 1].startsWith('-')) {
        throw new Error('参数 --swarm-target 缺少目标目录 (<dir>)');
      }
      swarmTargetDir = argv[++i];
    } else if (arg === '--swarm-backup-dir') {
      if (i + 1 >= argv.length || !argv[i + 1] || argv[i + 1].startsWith('-')) {
        throw new Error('参数 --swarm-backup-dir 缺少目录路径 (<dir>)');
      }
      swarmBackupDir = argv[++i];
    } else if (arg === '--dry-run') {
      dryRun = true;
    } else if (arg === '--force') {
      force = true;
    } else {
      throw new Error(`未知参数: ${arg} (使用 --help 查看帮助)`);
    }
  }
  return {
    help,
    customPath,
    hudOnly,
    skipPlugins,
    skipBgSync,
    skipProcessCheck,
    swarmOnly,
    skipSwarm,
    swarmTargetDir,
    swarmBackupDir,
    dryRun,
    force
  };
}

if (require.main === module) {
  let cliOpts;
  try {
    cliOpts = parseFastPatchArgs(process.argv.slice(2));
  } catch (err) {
    console.error(`[ERR] ${err.message}`);
    process.exit(1);
  }

  if (cliOpts.help) {
    printCliHelp();
    process.exit(0);
  }

  try {
    if (cliOpts.swarmOnly) {
      const swarmZhPatch = require('./core/swarm-zh-patch.cjs');
      const res = swarmZhPatch.patch({
        targetDir: cliOpts.swarmTargetDir || undefined,
        backupDir: cliOpts.swarmBackupDir || undefined,
        dryRun: cliOpts.dryRun,
        force: cliOpts.force
      });
      if (res.status === 'alreadyPatched') {
        console.log(`[OK] Swarm 面板已处于最新汉化状态 (${res.targetDir})`);
      } else if (res.status === 'dryRun') {
        console.log(`[DRY-RUN] 计划更新 ${res.plannedUpdates.length} 个文件: ${res.plannedUpdates.join(', ') || '(无)'}`);
      } else {
        console.log(`[OK] Swarm 面板中文补丁完成 (${res.status}): 更新 ${res.updatedFiles.length} 个文件 -> ${res.targetDir}`);
      }
    } else {
      fastPatchAsar({
        customPath: cliOpts.customPath,
        hudOnly: cliOpts.hudOnly,
        skipPlugins: cliOpts.skipPlugins,
        skipBgSync: cliOpts.skipBgSync,
        skipProcessCheck: cliOpts.skipProcessCheck,
        skipSwarm: cliOpts.skipSwarm,
        swarmTargetDir: cliOpts.swarmTargetDir,
        swarmBackupDir: cliOpts.swarmBackupDir,
        force: cliOpts.force
      });
    }
  } catch (err) {
    console.error(`[ERR] 补丁执行失败: ${err.message}`);
    process.exit(1);
  }
}

module.exports = {
  fastPatchAsar,
  shouldEnableChinese,
  ensureTargetNotRunning,
  patchAsarBufferInMemory,
  applyRuntimePerformanceHotfix,
  classifyInstallProcesses,
  isValidAsarBuffer,
  isBufferPatched,
  isBufferHudPatched,
  hasAnyPatchMarker,
  extractAsarFileText,
  verifyPatchedAsarIntegrity,
  checkElectronAsarFuse,
  verifyUpstreamHeadTrusted,
  computeIntegrity,
  readAsarAppVersion,
  getAsarFingerprintFromBuffer,
  isPathInTmpDir,
  parseFastPatchArgs,
  FUSE_SENTINEL
};
