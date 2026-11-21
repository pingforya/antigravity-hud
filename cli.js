#!/usr/bin/env node
'use strict';

/**
 * Antigravity HUD & Thinking Inspector CLI Manager
 * - Deploys the official agy-hud plugin (Hooks + Telemetry Sidecar) to ~/.gemini/config/plugins/agy-hud
 * - Injects the Position A Composer Footer HUD Pill (.agy-composer-footer) and Chinese localization
 *   into the Antigravity client via the in-memory ASAR patcher (fast-patch.cjs).
 * - Note: `cli.js install` requires the target Antigravity client to be closed beforehand; for
 *   interactive process detection and graceful shutdown prompts, run `patch.bat` / `patch.ps1`.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const parser = require('./core/telemetry-parser.cjs');
const { pruneOldTimingFiles } = require('./plugins/agy-hud/scripts/hud-hook.cjs');

const PROJECT_ROOT = __dirname;
const RUNTIME_PATH = path.join(PROJECT_ROOT, 'core', 'hud-runtime.js');
const PLUGIN_SRC_DIR = path.join(PROJECT_ROOT, 'plugins', 'agy-hud');

const HUD_MARKER_START = '// --- Antigravity HUD Telemetry Injection Start ---';
const HUD_MARKER_END = '// --- Antigravity HUD Telemetry Injection End ---';

function getGlobalPluginTargetDir() {
  if (process.env.AGY_HUD_PLUGIN_DIR) return process.env.AGY_HUD_PLUGIN_DIR;
  return path.join(os.homedir(), '.gemini', 'config', 'plugins', 'agy-hud');
}

function getCandidateAsarPaths(platform = os.platform(), homedir = os.homedir()) {
  if (platform === 'win32') {
    const localAppData = process.env.LOCALAPPDATA || path.join(homedir, 'AppData', 'Local');
    const programFiles = process.env.ProgramFiles || 'C:\\Program Files';
    return [
      path.join(localAppData, 'Programs', 'antigravity', 'resources', 'app.asar'),
      path.join(programFiles, 'antigravity', 'resources', 'app.asar'),
      path.join(programFiles, 'Google Antigravity', 'resources', 'app.asar'),
      path.join(homedir, 'AppData', 'Roaming', 'antigravity', 'resources', 'app.asar')
    ];
  } else if (platform === 'darwin') {
    return [
      '/Applications/Antigravity.app/Contents/Resources/app.asar',
      path.join(homedir, 'Applications', 'Antigravity.app', 'Contents', 'Resources', 'app.asar')
    ];
  }
  return [
    '/opt/antigravity/resources/app.asar',
    '/usr/lib/antigravity/resources/app.asar',
    path.join(homedir, '.local', 'share', 'antigravity', 'resources', 'app.asar')
  ];
}

function findAsarPath(customPath) {
  if (customPath) {
    const resolved = path.resolve(customPath);
    if (fs.existsSync(resolved) && fs.statSync(resolved).isDirectory()) {
      const candidates = [
        path.join(resolved, 'resources', 'app.asar'),
        path.join(resolved, 'Contents', 'Resources', 'app.asar'),
        path.join(resolved, 'app.asar')
      ];
      return candidates.find((p) => fs.existsSync(p)) || null;
    }
    return fs.existsSync(resolved) ? resolved : null;
  }
  for (const p of getCandidateAsarPaths()) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

function getHudBundleScript() {
  const runtimeCode = fs.readFileSync(RUNTIME_PATH, 'utf8');
  const personaCode = fs.readFileSync(path.join(PROJECT_ROOT, 'core', 'new-chat-persona.js'), 'utf8');
  const personaInjection = "\n(function() {\n  var injected = false;\n  try {\n    if (electron_1.contextBridge && typeof electron_1.contextBridge.executeInMainWorld === 'function') {\n      electron_1.contextBridge.executeInMainWorld({ func: function () {\n" + personaCode + "\n      } });\n      injected = true;\n    }\n  } catch (_) {}\n  if (!injected) {\n    try {\n      if (electron_1.webFrame && typeof electron_1.webFrame.executeJavaScript === 'function') {\n        electron_1.webFrame.executeJavaScript(" + JSON.stringify(personaCode) + ").catch(function(e) { console.error('[AGY-PERSONA]', e); });\n      }\n    } catch (e) { console.error('[AGY-PERSONA]', e); }\n  }\n})();\n";
  return `\n${HUD_MARKER_START}\n(function() {\n  try {\n    if (typeof window !== 'undefined' && window.top && window.top !== window.self) return;\n    if (typeof process !== 'undefined' && Array.isArray(process.argv) && process.argv.some(function(a) { return String(a).indexOf('--agy-backend=ssh') === 0; })) return;\n    if (typeof electron_1 !== 'undefined' && electron_1.ipcRenderer && typeof window !== 'undefined') {\n      window.__AGY_HUD_FETCH__ = function(convId) {\n        return electron_1.ipcRenderer.invoke('agy-hud:get-telemetry', convId);\n      };\n      var personaBridge = {\n        getDefault: function() { return electron_1.ipcRenderer.invoke('agy-hud:persona', { action: 'getDefault' }); },\n        getMode: function(convId) { return electron_1.ipcRenderer.invoke('agy-hud:persona', { action: 'get', conversationId: convId }); },\n        setMode: function(convId, mode) { return electron_1.ipcRenderer.invoke('agy-hud:persona', { action: 'set', conversationId: convId, mode: mode }); },\n        stageNew: function(mode, token) { return electron_1.ipcRenderer.invoke('agy-hud:persona', { action: 'stageNew', mode: mode, token: token }); },\n        commitNew: function(convId, mode, token) { return electron_1.ipcRenderer.invoke('agy-hud:persona', { action: 'commitNew', conversationId: convId, mode: mode, token: token }); },\n        cancelNew: function(token) { return electron_1.ipcRenderer.invoke('agy-hud:persona', { action: 'cancelNew', token: token }); }\n      };\n      window.__AGY_PERSONA_BRIDGE__ = personaBridge;\n      try {\n        if (electron_1.contextBridge && typeof electron_1.contextBridge.exposeInMainWorld === 'function') {\n          electron_1.contextBridge.exposeInMainWorld('__AGY_PERSONA_BRIDGE__', personaBridge);\n        }\n      } catch (_) {}\n    }\n${runtimeCode}\n${personaInjection}\n  } catch (e) {\n    console.error('[AGY-HUD] Injection error:', e);\n  }\n})();\n${HUD_MARKER_END}\n`;
}

function getMainIpcScript() {
  // Main-process handler: prefers hot-reloading the live plugin parser from
  // AGY_HUD_PLUGIN_DIR (or ~/.gemini/config/plugins/agy-hud) when updated on disk,
  // falling back to the embedded ./agyHudTelemetryParser.cjs inside app.asar.
  // On Windows, also wraps ./languageServer.killLanguageServer so taskkill /PID <lsPid> /T /F
  // runs BEFORE language_server.exe is terminated, cleaning up all child cmd.exe (agy-node.cmd)
  // and Antigravity.exe (ELECTRON_RUN_AS_NODE=1) sidecar processes.
  return `\n${HUD_MARKER_START}\n(function() {\n  try {\n    const fs = require('fs');\n    const path = require('path');\n    const os = require('os');\n    if (process.platform === 'win32') {\n      try {\n        const lsMod = require('./languageServer');\n        if (lsMod && typeof lsMod.killLanguageServer === 'function' && !lsMod.killLanguageServer.__agyTreeCleanupWrapped) {\n          const origKillLs = lsMod.killLanguageServer;\n          const wrappedKillLs = async function(...args) {\n            try {\n              if (typeof lsMod.setIntentionalTermination === 'function') {\n                lsMod.setIntentionalTermination(true);\n              }\n              const lsProc = typeof lsMod.getLsProcess === 'function' ? lsMod.getLsProcess() : null;\n              const pid = (lsProc && Number.isInteger(lsProc.pid))\n                ? lsProc.pid\n                : (typeof lsMod.getLanguageServerPid === 'function' ? lsMod.getLanguageServerPid() : null);\n              if (Number.isInteger(pid) && pid > 0) {\n                const taskkillBin = process.env\n                  ? path.join(process.env.SystemRoot || 'C:\\\\Windows', 'System32', 'taskkill.exe')\n                  : 'taskkill';\n                // taskkill /PID <pid> /T /F\n                require('child_process').execFileSync(taskkillBin, ['/PID', String(pid), '/T', '/F'], {\n                  windowsHide: true,\n                  timeout: 5000,\n                  stdio: 'ignore'\n                });\n              }\n            } catch (_) {}\n            return origKillLs.apply(this, args);\n          };\n          wrappedKillLs.__agyTreeCleanupWrapped = true;\n          lsMod.killLanguageServer = wrappedKillLs;\n        }\n      } catch (_) {}\n    }\n    const pluginDir = (typeof process !== 'undefined' && process.env && process.env.AGY_HUD_PLUGIN_DIR)\n      ? process.env.AGY_HUD_PLUGIN_DIR\n      : path.join(os.homedir(), '.gemini', 'config', 'plugins', 'agy-hud');\n    const extPath = path.join(pluginDir, 'scripts', 'telemetry-parser.cjs');\n    let hudParser = require('./agyHudTelemetryParser.cjs');\n    let loadedMtime = 0;\n    const getHudParser = function() {\n      try {\n        const mtime = fs.statSync(extPath).mtimeMs;\n        if (mtime !== loadedMtime) {\n          const resolvedExt = require.resolve(extPath);\n          delete require.cache[resolvedExt];\n          const mod = require(resolvedExt);\n          if (mod && typeof mod.parseConversationTelemetry === 'function') {\n            hudParser = mod;\n            loadedMtime = mtime;\n          }\n        }\n      } catch (_) {}\n      return hudParser;\n    };\n    const personaExtPath = path.join(pluginDir, 'scripts', 'persona-mode.cjs');\n    let personaMod = null;\n    let personaMtime = 0;\n    const getPersonaMod = function() {\n      try {\n        const mtime = fs.statSync(personaExtPath).mtimeMs;\n        if (mtime !== personaMtime || !personaMod) {\n          const resolvedPersona = require.resolve(personaExtPath);\n          delete require.cache[resolvedPersona];\n          const mod = require(resolvedPersona);\n          if (mod && typeof mod.getMode === 'function') {\n            personaMod = mod;\n            personaMtime = mtime;\n          }\n        }\n      } catch (_) {}\n      return personaMod;\n    };\n    const isTrustedTopSender = function(ev) {\n      if (!ev || !ev.sender || !ev.senderFrame) return false;\n      if (typeof ev.sender.getType !== 'function' || ev.sender.getType() !== 'window') return false;\n      if (ev.senderFrame.parent) return false;\n      if (!ev.sender.mainFrame || ev.senderFrame !== ev.sender.mainFrame) return false;\n      return true;\n    };\n    const defaultPersona = function() {\n      const envVal = String((typeof process !== 'undefined' && process.env && process.env.AGY_HUD_DEFAULT_PERSONA) || '').trim().toLowerCase();\n      return (envVal === 'hakimi' || envVal === 'normal') ? envVal : 'hakimi';\n    };\n    const fallbackPersonaDir = function() {\n      return (typeof process !== 'undefined' && process.env && process.env.AGY_HUD_DATA_DIR)\n        || path.join(os.homedir(), '.gemini', 'antigravity', 'sidecar_data', 'agy-hud', 'telemetry', 'data');\n    };\n    const schedTimeout = typeof setTimeout === 'function' ? setTimeout : require('timers').setTimeout;\n    const fallbackWriteAtomic = async function(file, obj) {\n      await fs.promises.mkdir(path.dirname(file), { recursive: true });\n      const tmp = file + '.tmp-' + process.pid + '-' + Date.now() + '-' + Math.random().toString(16).slice(2);\n      try {\n        await fs.promises.writeFile(tmp, JSON.stringify(obj) + '\\n', 'utf8');\n        for (let attempt = 0; attempt < 4; attempt++) {\n          try { await fs.promises.rename(tmp, file); break; }\n          catch (e) {\n            if (attempt === 3 || !e || !['EPERM', 'EACCES', 'EBUSY'].includes(e.code)) throw e;\n            await new Promise((r) => schedTimeout(r, 5 * (attempt + 1)));\n          }\n        }\n      } finally { if (fs.existsSync(tmp)) { try { await fs.promises.unlink(tmp); } catch (_) {} } }\n    };\n    const registerHudIpc = function() {\n      try {\n        electron_1.ipcMain.removeHandler('agy-hud:get-telemetry');\n      } catch (_) {}\n      electron_1.ipcMain.handle('agy-hud:get-telemetry', function(_event, convId) {\n        try {\n          if (!isTrustedTopSender(_event)) return { error: 'forbidden_sender' };\n          if (!convId || typeof convId !== 'string' || (convId !== '__HOME__' && convId !== '__DAILY__' && !/^[0-9a-f-]{36}$/i.test(convId))) {\n            return { error: 'no_conversation' };\n          }\n          const activeParser = getHudParser();\n          const bp = typeof activeParser.getBackendPatchStatus === 'function' ? activeParser.getBackendPatchStatus() : null;\n          const defaultLim = (bp && bp.patched && bp.contextLimit) ? bp.contextLimit : 256000;\n          const getDaily = () => typeof activeParser.getDailyModelUsage === 'function' ? activeParser.getDailyModelUsage() : null;\n          if (convId === '__HOME__' || convId === '__DAILY__') {\n            return { conversationId: convId, contextLimit: defaultLim, backendPatch: bp, dailyUsage: getDaily(), stepCount: 0, plannerStepCount: 0, topConsumers: [] };\n          }\n          const targetId = convId;\n          const t = activeParser.parseConversationTelemetry(targetId);\n          if (!t) return { conversationId: targetId, contextLimit: defaultLim, backendPatch: bp, dailyUsage: getDaily(), stepCount: 0, plannerStepCount: 0, topConsumers: [] };\n          return typeof activeParser.summarizeTelemetry === 'function' ? activeParser.summarizeTelemetry(t) : t;\n        } catch (err) {\n          return { error: String((err && err.message) || err) };\n        }\n      });\n      try {\n        electron_1.ipcMain.removeHandler('agy-hud:persona');\n      } catch (_) {}\n      electron_1.ipcMain.handle('agy-hud:persona', async function(_event, req) {\n        try {\n          if (!isTrustedTopSender(_event)) return { ok: false, error: 'forbidden_sender' };\n          const r = req && typeof req === 'object' ? req : {};\n          const action = String(r.action || '');\n          const idOk = typeof r.conversationId === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(r.conversationId);\n          const modeOk = r.mode === 'hakimi' || r.mode === 'normal';\n          const pm = getPersonaMod();\n          if (action === 'getDefault') {\n            return { ok: true, mode: (pm && typeof pm.defaultPersonaMode === 'function') ? pm.defaultPersonaMode() : defaultPersona() };\n          }\n          if (action === 'get') {\n            if (!idOk) return { ok: false, error: 'invalid_conversation_id' };\n            if (pm && typeof pm.getModeAsync === 'function') return { ok: true, mode: await pm.getModeAsync(r.conversationId) };\n            if (pm && typeof pm.getMode === 'function') return { ok: true, mode: pm.getMode(r.conversationId) };\n            const fPath = path.join(fallbackPersonaDir(), 'persona_' + r.conversationId.toLowerCase() + '.json');\n            try {\n              const s = JSON.parse(await fs.promises.readFile(fPath, 'utf8'));\n              if (!s || (s.mode !== 'hakimi' && s.mode !== 'normal')) return { ok: false, error: 'corrupted_persona_state' };\n              return { ok: true, mode: s.mode };\n            } catch (e) {\n              if (e && e.code === 'ENOENT') return { ok: true, mode: defaultPersona() };\n              return { ok: false, error: String((e && e.message) || e) };\n            }\n          }\n          if (action === 'set') {\n            if (!idOk || !modeOk) return { ok: false, error: 'invalid_args' };\n            if (pm && typeof pm.setModeAsync === 'function') return { ok: true, mode: await pm.setModeAsync(r.conversationId, r.mode) };\n            if (pm && typeof pm.setMode === 'function') return { ok: true, mode: pm.setMode(r.conversationId, r.mode) };\n            await fallbackWriteAtomic(path.join(fallbackPersonaDir(), 'persona_' + r.conversationId.toLowerCase() + '.json'), { mode: r.mode });\n            return { ok: true, mode: r.mode };\n          }\n          if (action === 'stageNew') {\n            if (!modeOk) return { ok: false, error: 'invalid_mode' };\n            if (pm && typeof pm.stagePendingNewChatAsync === 'function') {\n              const res = await pm.stagePendingNewChatAsync(r.mode, r.token);\n              return { ok: true, token: res.token, mode: res.mode };\n            }\n            if (pm && typeof pm.stagePendingNewChat === 'function') {\n              const res = pm.stagePendingNewChat(r.mode, r.token);\n              return { ok: true, token: res.token, mode: res.mode };\n            }\n            if (r.token !== undefined && r.token !== null && (typeof r.token !== 'string' || /[\\r\\n\\0]/.test(r.token))) {\n              return { ok: false, error: 'invalid_token' };\n            }\n            const tok = (typeof r.token === 'string' && r.token.trim()) ? r.token.trim().slice(0, 80) : String(Date.now());\n            const pFile = path.join(fallbackPersonaDir(), 'pending_new_chats.json');\n            let items = [];\n            try {\n              const raw = JSON.parse(await fs.promises.readFile(pFile, 'utf8'));\n              items = (Array.isArray(raw && raw.items) ? raw.items : []).filter(x => x && Date.now() - x.createdAtMs <= 45000 && x.token !== tok);\n            } catch (_) {}\n            items.push({ token: tok, mode: r.mode, createdAtMs: Date.now(), claimedBy: null });\n            await fallbackWriteAtomic(pFile, { items: items.slice(-12) });\n            return { ok: true, token: tok, mode: r.mode };\n          }\n          if (action === 'commitNew') {\n            if (!idOk || !modeOk) return { ok: false, error: 'invalid_args' };\n            if (pm && typeof pm.commitPendingNewChatAsync === 'function') {\n              return { ok: true, mode: await pm.commitPendingNewChatAsync(r.conversationId, r.mode, r.token) };\n            }\n            if (pm && typeof pm.commitPendingNewChat === 'function') {\n              return { ok: true, mode: pm.commitPendingNewChat(r.conversationId, r.mode, r.token) };\n            }\n            const normId = r.conversationId.toLowerCase();\n            await fallbackWriteAtomic(path.join(fallbackPersonaDir(), 'persona_' + normId + '.json'), { mode: r.mode });\n            const cleanTok = (typeof r.token === 'string' && !/[\\r\\n\\0]/.test(r.token)) ? r.token.trim().slice(0, 80) : '';\n            const pFile = path.join(fallbackPersonaDir(), 'pending_new_chats.json');\n            try {\n              const raw = JSON.parse(await fs.promises.readFile(pFile, 'utf8'));\n              const prevItems = Array.isArray(raw && raw.items) ? raw.items : [];\n              const nextItems = prevItems.filter(x => x && Date.now() - x.createdAtMs <= 45000 && (!cleanTok || x.token !== cleanTok) && x.claimedBy !== normId);\n              if (nextItems.length !== prevItems.length) await fallbackWriteAtomic(pFile, { items: nextItems });\n            } catch (_) {}\n            return { ok: true, mode: r.mode };\n          }\n          if (action === 'cancelNew') {\n            if (pm && typeof pm.cancelPendingNewChatAsync === 'function') {\n              await pm.cancelPendingNewChatAsync(r.token);\n              return { ok: true };\n            }\n            if (pm && typeof pm.cancelPendingNewChat === 'function') {\n              pm.cancelPendingNewChat(r.token);\n              return { ok: true };\n            }\n            const cleanTok = (typeof r.token === 'string' && r.token.trim() && !/[\\r\\n\\0]/.test(r.token)) ? r.token.trim().slice(0, 80) : '';\n            if (cleanTok) {\n              const pFile = path.join(fallbackPersonaDir(), 'pending_new_chats.json');\n              try {\n                const raw = JSON.parse(await fs.promises.readFile(pFile, 'utf8'));\n                const prevItems = Array.isArray(raw && raw.items) ? raw.items : [];\n                const nextItems = prevItems.filter(x => x && Date.now() - x.createdAtMs <= 45000 && x.token !== cleanTok);\n                if (nextItems.length !== prevItems.length) await fallbackWriteAtomic(pFile, { items: nextItems });\n              } catch (_) {}\n            }\n            return { ok: true };\n          }\n          return { ok: false, error: 'unknown_action' };\n        } catch (err) {\n          return { ok: false, error: String((err && err.message) || err) };\n        }\n      });\n    };\n    if (electron_1 && electron_1.ipcMain) {\n      registerHudIpc();\n    } else if (electron_1 && electron_1.app && typeof electron_1.app.whenReady === 'function') {\n      electron_1.app.whenReady().then(registerHudIpc);\n    }\n  } catch (e) {\n    console.error('[AGY-HUD] Main IPC injection error:', e);\n  }\n})();\n${HUD_MARKER_END}\n`;
}

/**
 * Remove legacy snapshot files written by older hook versions
 * (live_telemetry.json / conv_<id>.json duplicated full thinking text on disk)
 * as well as stale timing_*.jsonl and *.tmp* files.
 */
function cleanupLegacyTelemetrySnapshots() {
  let removed = 0;
  try {
    const dataDir = parser.getTelemetryDataDir();
    if (!fs.existsSync(dataDir)) return 0;
    for (const name of fs.readdirSync(dataDir)) {
      if (name === 'live_telemetry.json' || /^conv_[0-9a-f-]{36}\.json$/i.test(name)) {
        try { fs.rmSync(path.join(dataDir, name), { force: true }); removed++; } catch (_) {}
      }
    }
    removed += pruneOldTimingFiles(dataDir);
  } catch (_) {}
  return removed;
}

const PRESERVED_PLUGIN_REL_PATHS = new Set(['assets/hakimi-memory.local.md']);

function pruneStalePluginEntries(srcDir, dstDir, relPrefix = '') {
  if (!fs.existsSync(dstDir)) return;
  for (const entry of fs.readdirSync(dstDir)) {
    const rel = relPrefix ? `${relPrefix}/${entry}` : entry;
    if (PRESERVED_PLUGIN_REL_PATHS.has(rel)) continue;
    const srcEntry = path.join(srcDir, entry);
    const dstEntry = path.join(dstDir, entry);
    const srcExists = fs.existsSync(srcEntry);
    const dstStat = fs.lstatSync(dstEntry);
    const srcStat = srcExists ? fs.lstatSync(srcEntry) : null;
    if (!srcExists || dstStat.isDirectory() !== srcStat.isDirectory()) {
      const hasPreservedChild = dstStat.isDirectory() && Array.from(PRESERVED_PLUGIN_REL_PATHS).some((p) => p.startsWith(`${rel}/`));
      if (hasPreservedChild) {
        pruneStalePluginEntries(srcEntry, dstEntry, rel);
      } else {
        try { fs.rmSync(dstEntry, { recursive: true, force: true }); } catch (_) {}
      }
    } else if (dstStat.isDirectory()) {
      pruneStalePluginEntries(srcEntry, dstEntry, rel);
    }
  }
}

function copyFileAtomic(srcPath, dstPath) {
  fs.mkdirSync(path.dirname(dstPath), { recursive: true });
  const tmpPath = `${dstPath}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  try {
    fs.copyFileSync(srcPath, tmpPath);
    fs.renameSync(tmpPath, dstPath);
  } finally {
    try {
      if (fs.existsSync(tmpPath)) fs.rmSync(tmpPath, { force: true });
    } catch (_) {}
  }
}

function filesDiffer(fileA, fileB) {
  if (!fs.existsSync(fileB)) return true;
  try {
    return !fs.readFileSync(fileA).equals(fs.readFileSync(fileB));
  } catch (_) {
    return true;
  }
}

function syncPluginFiles(srcDir, dstDir, relPrefix = '') {
  fs.mkdirSync(dstDir, { recursive: true });
  for (const entry of fs.readdirSync(srcDir, { withFileTypes: true })) {
    const rel = relPrefix ? `${relPrefix}/${entry.name}` : entry.name;
    const srcEntry = path.join(srcDir, entry.name);
    const dstEntry = path.join(dstDir, entry.name);
    if (entry.isDirectory()) {
      syncPluginFiles(srcEntry, dstEntry, rel);
    } else if (entry.isFile()) {
      if (PRESERVED_PLUGIN_REL_PATHS.has(rel) && fs.existsSync(dstEntry)) {
        continue;
      }
      if (filesDiffer(srcEntry, dstEntry)) {
        copyFileAtomic(srcEntry, dstEntry);
      }
    }
  }
}

function installPlugin() {
  // Best-effort keep plugin's internal telemetry-parser.cjs in sync when repo is writable;
  // tolerate read-only global installs (e.g. npm install -g) and copy atomically to targetDir below.
  const coreParserPath = path.join(PROJECT_ROOT, 'core', 'telemetry-parser.cjs');
  const pluginParserPath = path.join(PLUGIN_SRC_DIR, 'scripts', 'telemetry-parser.cjs');
  if (fs.existsSync(coreParserPath)) {
    try {
      if (filesDiffer(coreParserPath, pluginParserPath)) {
        copyFileAtomic(coreParserPath, pluginParserPath);
      }
    } catch (_) {}
  }

  const targetDir = getGlobalPluginTargetDir();
  fs.mkdirSync(targetDir, { recursive: true });
  pruneStalePluginEntries(PLUGIN_SRC_DIR, targetDir);
  syncPluginFiles(PLUGIN_SRC_DIR, targetDir);

  if (fs.existsSync(coreParserPath)) {
    const targetParserPath = path.join(targetDir, 'scripts', 'telemetry-parser.cjs');
    if (filesDiffer(coreParserPath, targetParserPath)) {
      copyFileAtomic(coreParserPath, targetParserPath);
    }
  }

  const removed = cleanupLegacyTelemetrySnapshots();

  console.log('[OK] [1/2] 已部署插件 (计时 Hook + 遥测侧边栏):');
  console.log(`   - 全局目录: ${targetDir}`);
  if (removed > 0) console.log(`   - 已清理旧版/过期遥测文件 ${removed} 个`);
  return targetDir;
}

function readAsarHeader(fd, fileSize) {
  const pre = Buffer.alloc(16);
  if (fs.readSync(fd, pre, 0, 16, 0) !== 16) return null;
  if (pre.readUInt32LE(0) !== 4) return null;
  const headerPickleLen = pre.readUInt32LE(4);
  const headerPayloadLen = pre.readUInt32LE(8);
  const jsonLen = pre.readUInt32LE(12);
  if (headerPickleLen < 8 || headerPickleLen > fileSize - 8) return null;
  if (headerPayloadLen !== headerPickleLen - 4 || jsonLen < 2 || jsonLen > headerPayloadLen - 4) return null;
  const jsonBuf = Buffer.alloc(jsonLen);
  if (fs.readSync(fd, jsonBuf, 0, jsonLen, 16) !== jsonLen) return null;
  return { base: 8 + headerPickleLen, root: JSON.parse(jsonBuf.toString('utf8')) };
}

function readAsarEntryFromFd(fd, fileSize, header, relPath) {
  let node = header.root;
  for (const part of String(relPath).split('/').filter(Boolean)) {
    if (!node || !node.files || !node.files[part]) return null;
    node = node.files[part];
  }
  if (!node || node.files || node.unpacked) return null;
  const size = Number(node.size || 0);
  const start = header.base + Number(node.offset);
  const end = start + size;
  if (!Number.isFinite(start) || !Number.isFinite(end) || start < header.base || end < start || end > fileSize) {
    return null;
  }
  const buf = Buffer.alloc(size);
  if (size > 0 && fs.readSync(fd, buf, 0, size, start) !== size) return null;
  return buf.toString('utf8');
}

function isAsarHudPatched(asarPath) {
  if (!asarPath || !fs.existsSync(asarPath)) return false;
  let fd;
  try {
    const stat = fs.statSync(asarPath);
    if (!stat.isFile() || stat.size < 16) return false;
    fd = fs.openSync(asarPath, 'r');
    const header = readAsarHeader(fd, stat.size);
    if (!header) return false;
    const preload = readAsarEntryFromFd(fd, stat.size, header, 'dist/preload.js');
    if (!preload || !preload.includes('Antigravity HUD Telemetry Injection')) return false;
    const ipc = readAsarEntryFromFd(fd, stat.size, header, 'dist/ipcHandlers.js');
    if (!ipc || !ipc.includes('Antigravity HUD Telemetry Injection')) return false;
    const parserText = readAsarEntryFromFd(fd, stat.size, header, 'dist/agyHudTelemetryParser.cjs');
    if (!parserText || !parserText.includes('summarizeTelemetry')) return false;
    return true;
  } catch (_) {
    return false;
  } finally {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch (_) {}
    }
  }
}

/**
 * Patch the client through the single in-memory engine (fast-patch.cjs), which preserves the
 * official app.asar.unpacked layout, keeps a pristine backup and swaps atomically.
 * (The old npx extract/pack path dropped all `unpacked` entries and deleted app.asar before
 * renaming, so it has been removed.)
 */
function patchClientAsar(customPath, options = {}) {
  const { fastPatchAsar } = require('./fast-patch.cjs'); // lazy: fast-patch requires this module
  const res = fastPatchAsar({
    customPath,
    hudOnly: Boolean(options.hudOnly),
    skipPlugins: true
  });
  const desc = res && res.enableChinese === false
    ? '客户端输入框底栏 HUD 胶囊 + 角色选择器注入完成 (HUD-Only 模式)！'
    : '客户端汉化 + 输入框底栏 HUD 胶囊注入完成！';
  console.log(`[OK] [2/2] ${desc}`);
  return res;
}

function formatCompactTokens(n) {
  const num = Number(n || 0);
  if (num >= 1000000) return `${(num / 1000000).toFixed(2)}M`;
  if (num >= 1000) return `${(num / 1000).toFixed(1)}k`;
  return String(num);
}

function printDailyReport(options = {}) {
  if (typeof parser.getDailyModelUsage !== 'function') return null;
  const usage = parser.getDailyModelUsage(options);
  if (!usage) return null;

  const targetDate = options.date || usage.todayKey;
  const day = (usage.days && usage.days[targetDate]) || usage.today || {
    date: targetDate,
    totalTokens: 0,
    inputTokens: 0,
    cacheReadTokens: 0,
    outputTokens: 0,
    thinkingTokens: 0,
    mainTokens: 0,
    subagentTokens: 0,
    turnCount: 0,
    sessionCount: 0,
    cacheHitRate: 0,
    models: []
  };

  console.log('============================================================');
  console.log(`[DAILY] 每日各模型 Token 消耗统计 (${day.date}${day.date === usage.todayKey ? ' · 今日' : ''})`);
  console.log('============================================================');
  console.log(`• 当日总消耗:     Σ ${day.totalTokens.toLocaleString()} (${formatCompactTokens(day.totalTokens)}) | ${day.sessionCount} 个会话 · ${day.turnCount} 轮推理`);
  console.log(`• 输入/缓存/输出: 新增 +${day.inputTokens.toLocaleString()} | 缓存命中 ${day.cacheReadTokens.toLocaleString()} (${day.cacheHitRate}%) | 输出 ${day.outputTokens.toLocaleString()} (思考 ${day.thinkingTokens.toLocaleString()})`);
  if (day.subagentTokens > 0) {
    console.log(`• 主会话/子代理:  主会话 ${formatCompactTokens(day.mainTokens)} | 子代理 ${formatCompactTokens(day.subagentTokens)}`);
  }
  if (usage.weekly) {
    const w = usage.weekly;
    console.log(`• 近 7 天汇总:    Σ ${w.totalTokens.toLocaleString()} (${formatCompactTokens(w.totalTokens)}) (${w.dayCount} 天活跃 · ${w.sessionCount} 会话 · ${w.turnCount} 轮 · 缓存 ${w.cacheHitRate}%)`);
  }
  if (usage.grandTotal) {
    const g = usage.grandTotal;
    console.log(`• 历史累计总计:   Σ ${g.totalTokens.toLocaleString()} (${formatCompactTokens(g.totalTokens)}) (${g.dayCount} 天活跃 · ${g.sessionCount} 会话 · ${g.turnCount} 轮 · 缓存 ${g.cacheHitRate}%)`);
  }

  if (day.models && day.models.length > 0) {
    console.log('\n[MODELS] 按模型拆分明细:');
    for (const [idx, m] of day.models.entries()) {
      console.log(
        `  ${idx + 1}. ${m.modelName.padEnd(28, ' ')} Σ ${formatCompactTokens(m.totalTokens).padStart(8, ' ')} (${String(m.sharePct).padStart(5, ' ')}%) | ` +
        `入:${formatCompactTokens(m.inputTokens)} 缓:${formatCompactTokens(m.cacheReadTokens)}(${m.cacheHitRate}%) 出:${formatCompactTokens(m.outputTokens)} | ${m.turnCount}轮/${m.sessionCount}会话`
      );
    }
  } else {
    console.log('\n  (当日暂无模型调用记录)');
  }

  const showDays = Number(options.days || 0);
  if (showDays > 1 && Array.isArray(usage.availableDates)) {
    const datesToShow = usage.availableDates.slice(-showDays).reverse();
    console.log(`\n[RECENT] 最近 ${datesToShow.length} 个有记录日期汇总:`);
    for (const dKey of datesToShow) {
      const dObj = usage.days[dKey];
      if (!dObj) continue;
      const topSummary = (dObj.models || []).slice(0, 3).map(m => `${m.shortLabel} ${formatCompactTokens(m.totalTokens)}`).join(', ');
      console.log(`  • ${dKey}: Σ ${formatCompactTokens(dObj.totalTokens).padStart(8, ' ')} (${dObj.turnCount}轮/${dObj.sessionCount}会话) ${topSummary ? `[${topSummary}]` : ''}`);
    }
  }
  console.log('============================================================');
  return usage;
}

function inspectLive(convIdArg) {
  const convId = convIdArg || parser.findLatestConversationId();
  if (!convId) {
    console.log('[INFO] 未找到本地会话记录。');
    printDailyReport();
    return;
  }
  const t = parser.parseConversationTelemetry(convId);
  if (!t) {
    console.log(`[INFO] 无法解析会话: ${convId}`);
    printDailyReport();
    return;
  }
  console.log('============================================================');
  console.log(`[LIVE] Antigravity 实时遥测快照 (会话: ${t.conversationId})`);
  console.log('============================================================');
  const peakInfo = (t.peakContext > t.currentContext + 10000 || t.compactionCount > 0)
    ? ` [峰值: ${t.peakContext.toLocaleString()}${t.compactionCount > 0 ? `, 已压缩 ${t.compactionCount} 次` : ''}]`
    : '';
  console.log(`• 当前模型:       ${t.modelName}`);
  console.log(`• 上下文总水位:   ${t.currentContext.toLocaleString()} / ${t.contextLimit.toLocaleString()} (${t.contextUsagePct}%)${peakInfo}`);
  console.log(`• 缓存命中率:     ${t.latestCacheHitRate}% (命中 ${t.latestCacheReadTokens.toLocaleString()} | 新增 +${t.latestInputTokens.toLocaleString()})`);
  console.log(`• 最新生成速率:   ${t.latestTokPerSec} tok/s (本步输出 ${t.latestOutputTokens} tok / ${t.latestDurationSec}s)`);
  console.log(`• 会话平均速率:   ${t.avgTokPerSec} tok/s (累计输出 ${t.totalOutputTokens.toLocaleString()} tok)`);
  console.log(`• 耗时拆分:       模型推理 ${t.totalModelSec}s | 工具执行 ${t.totalToolSec}s`);
  if (t.dbMeta) {
    console.log(`• 数据库记录窗口: Request=${t.dbMeta.genMaxContextTokens.toLocaleString()} tok (turn #${t.dbMeta.genIdx}, 状态=${t.dbMeta.state})`);
  }
  if (t.backendPatch && t.backendPatch.patched) {
    console.log(`• 后端 1M 补丁:   [ON] 已生效 (阈值 ${t.backendPatch.contextLimit.toLocaleString()} tok, 规则 1MiB / 131k tok)`);
  }
  console.log('\n[TOP] 吃上下文最多的前 5 步:');
  for (const [idx, c] of t.topConsumers.slice(0, 5).entries()) {
    console.log(`  ${idx + 1}. Step #${c.stepIndex} (+${c.deltaTokens.toLocaleString()} tok) <- ${c.label}`);
  }
  console.log('============================================================');
  printDailyReport();
}

function printUsage() {
  console.log([
    '用法: node cli.js [命令] [选项]',
    '',
    '命令:',
    '  inspect [convId]   查看插件、客户端、后端补丁状态与会话实时遥测 (默认)',
    '  status [convId]    inspect 的别名',
    '  daily              打印每日各模型 Token 消耗统计',
    '  install-plugin     仅部署/更新 agy-hud 全局插件 (Hooks + Telemetry Sidecar)',
    '  install            部署插件并注入客户端 app.asar (HUD 胶囊 + 角色选择器 + 可选中文汉化)',
    '  patch-backend      修补 Go 后端二进制以启用 1M 上下文与规则预算 (默认 512000)',
    '  restore-backend    从备份恢复原版 Go 后端二进制',
    '  patch-swarm        注入或更新 Swarm 协作面板中文补丁 (支持幂等与外部备份)',
    '  verify-swarm       只读校验 Swarm 面板汉化状态 (0=已注入, 2=未注入/漂移, 1=缺失/异常)',
    '  restore-swarm      从外部备份恢复原版 Swarm 面板文件并移除 translator.mjs',
    '  sync-swarm         将目标 Swarm 面板的已汉化修改同步回仓库打包资源',
    '  help               显示此帮助信息',
    '',
    '选项 (顺序无关):',
    '  --path <val>             指定目标安装目录、app.asar 或后端二进制路径',
    '  --target, --swarm-dir <dir>  指定 Swarm 面板目标目录 (swarm_board)',
    '  --backup-dir <dir>       指定 Swarm 面板外部备份目录',
    '  --asset-dir <dir>        指定 Swarm 汉化打包资源目录 (plugins/swarm-zh)',
    '  --hud-only               install 时仅注入 HUD 胶囊与角色选择器，跳过中文汉化',
    '  --no-swarm               install 时跳过 Swarm 面板中文补丁',
    '  --dry-run, --check       仅预览 Swarm 补丁/同步/恢复操作，不写入磁盘',
    '  --json                   以 JSON 格式输出 Swarm 命令结果',
    '  --force                  强制重新写入 Swarm 补丁文件',
    '  --context-limit <n>      后端自动压缩阈值 (256001..1048576, 默认 512000)',
    '  --days <n>               daily 命令展示最近 N 天汇总 (正整数, 默认 7)',
    '  --date <YYYY-MM-DD>      daily 命令查看指定日期明细',
    '  -h, --help               显示此帮助信息'
  ].join('\n'));
}

function parseCliArgs(argv) {
  const opts = {
    cmd: null,
    positionals: [],
    customPath: null,
    swarmTargetDir: null,
    swarmBackupDir: null,
    swarmAssetDir: null,
    hudOnly: false,
    noSwarm: false,
    dryRun: false,
    json: false,
    force: false,
    contextLimit: null,
    days: 7,
    date: undefined,
    help: false
  };

  function requireValue(flag, idx) {
    const val = argv[idx + 1];
    if (idx + 1 >= argv.length || !val || val.startsWith('-')) {
      throw new Error(`参数 ${flag} 缺少值`);
    }
    return val;
  }

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-h' || a === '--help') {
      opts.help = true;
    } else if (a === '--hud-only') {
      opts.hudOnly = true;
    } else if (a === '--no-swarm') {
      opts.noSwarm = true;
    } else if (a === '--dry-run' || a === '--check') {
      opts.dryRun = true;
    } else if (a === '--json') {
      opts.json = true;
    } else if (a === '--force') {
      opts.force = true;
    } else if (a === '--path') {
      opts.customPath = requireValue('--path', i);
      i++;
    } else if (a === '--target' || a === '--swarm-dir') {
      opts.swarmTargetDir = requireValue(a, i);
      i++;
    } else if (a === '--backup-dir') {
      opts.swarmBackupDir = requireValue('--backup-dir', i);
      i++;
    } else if (a === '--asset-dir') {
      opts.swarmAssetDir = requireValue('--asset-dir', i);
      i++;
    } else if (a === '--context-limit') {
      opts.contextLimit = requireValue('--context-limit', i);
      i++;
    } else if (a === '--days') {
      const raw = requireValue('--days', i);
      i++;
      const parsed = Number(raw);
      if (!Number.isInteger(parsed) || parsed < 1) {
        throw new Error(`参数 --days 必须是正整数，收到: ${raw}`);
      }
      opts.days = parsed;
    } else if (a === '--date') {
      const raw = requireValue('--date', i);
      i++;
      if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
        throw new Error(`参数 --date 格式必须为 YYYY-MM-DD，收到: ${raw}`);
      }
      opts.date = raw;
    } else if (a.startsWith('-')) {
      throw new Error(`未知参数: ${a} (使用 --help 查看帮助)`);
    } else if (!opts.cmd) {
      opts.cmd = a;
    } else {
      opts.positionals.push(a);
    }
  }
  opts.cmd = opts.cmd || 'inspect';
  return opts;
}

function resolveInspectBackendTargets(customPath, asarPath, backendPatcher) {
  const bp = backendPatcher || require('./core/backend-patcher.cjs');
  if (!customPath) return bp.discoverDefaultTargets();
  const resolved = path.resolve(customPath);
  if (fs.existsSync(resolved) && fs.statSync(resolved).isFile() && !resolved.toLowerCase().endsWith('.asar')) {
    return [resolved];
  }
  const effectiveAsar = asarPath !== undefined ? asarPath : findAsarPath(customPath);
  const binaryNames = process.platform === 'win32'
    ? ['language_server_windows_x64.exe', 'language_server_windows_arm64.exe', 'language_server.exe', 'agy.exe']
    : (process.platform === 'darwin'
      ? ['language_server_macos_arm', 'language_server_macos_arm64', 'language_server_macos_x64', 'language_server_macos', 'language_server', 'agy']
      : ['language_server_linux_x64', 'language_server_linux_arm64', 'language_server_linux_arm', 'language_server', 'agy']);
  const bases = [];
  if (effectiveAsar) {
    const resDir = path.dirname(effectiveAsar);
    bases.push(
      resDir,
      path.dirname(resDir),
      path.join(resDir, 'app'),
      path.join(resDir, 'app.asar.unpacked'),
      path.join(resDir, 'app', 'extensions', 'antigravity'),
      path.join(resDir, 'app.asar.unpacked', 'extensions', 'antigravity'),
      path.join(resDir, 'app', 'extensions', 'agy'),
      path.join(resDir, 'app.asar.unpacked', 'extensions', 'agy')
    );
  }
  if (fs.existsSync(resolved) && fs.statSync(resolved).isDirectory()) {
    for (const resRoot of [path.join(resolved, 'resources'), path.join(resolved, 'Contents', 'Resources')]) {
      bases.push(
        resRoot,
        path.join(resRoot, 'app'),
        path.join(resRoot, 'app.asar.unpacked'),
        path.join(resRoot, 'app', 'extensions', 'antigravity'),
        path.join(resRoot, 'app.asar.unpacked', 'extensions', 'antigravity'),
        path.join(resRoot, 'app', 'extensions', 'agy'),
        path.join(resRoot, 'app.asar.unpacked', 'extensions', 'agy')
      );
    }
    bases.push(resolved);
  }
  const found = [];
  for (const base of bases) {
    for (const name of binaryNames) {
      for (const candidate of [path.join(base, 'bin', name), path.join(base, name)]) {
        if (fs.existsSync(candidate) && fs.statSync(candidate).isFile() && !found.includes(candidate)) {
          found.push(candidate);
        }
      }
    }
  }
  return found;
}

module.exports = {
  getCandidateAsarPaths,
  findAsarPath,
  resolveInspectBackendTargets,
  parseCliArgs,
  installPlugin,
  cleanupLegacyTelemetrySnapshots,
  getHudBundleScript,
  getMainIpcScript,
  isAsarHudPatched,
  patchClientAsar,
  printDailyReport,
  HUD_MARKER_START,
  HUD_MARKER_END
};

if (require.main === module) {
  let opts;
  try {
    opts = parseCliArgs(process.argv.slice(2));
  } catch (err) {
    console.error(`[ERR] ${err.message}`);
    process.exit(1);
  }

  if (opts.help || opts.cmd === 'help') {
    printUsage();
    process.exit(0);
  }

  const cmd = opts.cmd;
  const backendPatcher = require('./core/backend-patcher.cjs');
  const buildSwarmOpts = (o, extra = {}) => ({
    targetDir: o.swarmTargetDir || extra.fallbackTarget || undefined,
    backupDir: o.swarmBackupDir || undefined,
    assetDir: o.swarmAssetDir || undefined,
    dryRun: o.dryRun,
    force: o.force,
    ...extra
  });

  if (cmd === 'install-plugin') {
    installPlugin();
  } else if (cmd === 'install') {
    installPlugin();
    try {
      patchClientAsar(opts.customPath, { hudOnly: opts.hudOnly });
    } catch (err) {
      console.error(`[ERR] 客户端补丁失败: ${err.message}`);
      process.exit(1);
    }
    if (!opts.hudOnly && !opts.noSwarm) {
      try {
        const swarmPatcher = require('./core/swarm-zh-patch.cjs');
        const swarmRes = swarmPatcher.patch(buildSwarmOpts(opts, { allowMissing: true }));
        if (swarmRes.status === 'skippedMissing') {
          console.log(`[INFO] [3/3] 未发现 Swarm 面板目录 (${swarmRes.targetDir})，已跳过 Swarm 汉化补丁`);
        } else if (swarmRes.status === 'alreadyPatched') {
          console.log(`[OK] [3/3] Swarm 面板中文补丁已是最新 (${swarmRes.targetDir})`);
        } else if (swarmRes.status === 'dryRun') {
          const planned = Array.isArray(swarmRes.plannedUpdates) ? swarmRes.plannedUpdates : [];
          console.log(`[DRY-RUN] [3/3] 计划应用 Swarm 面板中文补丁 (${planned.length} 个文件): ${planned.join(', ') || '(无)'}`);
        } else {
          const updated = Array.isArray(swarmRes.updatedFiles) ? swarmRes.updatedFiles : [];
          console.log(`[OK] [3/3] Swarm 面板中文补丁已应用 (更新 ${updated.length} 个文件)`);
        }
      } catch (err) {
        console.error(`[ERR] Swarm 面板补丁失败: ${err.message}`);
        process.exit(1);
      }
    }
  } else if (cmd === 'patch-swarm' || cmd === 'verify-swarm' || cmd === 'restore-swarm' || cmd === 'sync-swarm') {
    const swarmPatcher = require('./core/swarm-zh-patch.cjs');
    const swarmOpts = buildSwarmOpts(opts, { fallbackTarget: opts.customPath });
    try {
      if (cmd === 'verify-swarm') {
        const res = swarmPatcher.verify(swarmOpts);
        if (opts.json) {
          console.log(JSON.stringify(res, null, 2));
        } else {
          console.log(`[${res.status.toUpperCase()}] ${res.summary}`);
          console.log(`  目标目录: ${res.targetDir}`);
          if (res.changedFiles.length > 0) {
            console.log(`  差异文件: ${res.changedFiles.join(', ')}`);
          }
          console.log(`  外部备份: ${res.hasBackup ? res.targetBackupDir : '暂无完整上游备份'}`);
        }
        process.exit(swarmPatcher.getVerifyExitCode(res));
      } else if (cmd === 'patch-swarm') {
        const res = swarmPatcher.patch(swarmOpts);
        if (opts.json) {
          console.log(JSON.stringify(res, null, 2));
        } else if (res.status === 'alreadyPatched') {
          console.log(`[OK] Swarm 面板已处于最新汉化状态 (${res.targetDir})`);
        } else if (res.status === 'dryRun') {
          console.log(`[DRY-RUN] 计划更新 ${res.plannedUpdates.length} 个文件: ${res.plannedUpdates.join(', ') || '(无)'}`);
        } else {
          console.log(`[OK] Swarm 面板中文补丁完成 (${res.status}): 更新 ${res.updatedFiles.length} 个文件 -> ${res.targetDir}`);
        }
      } else if (cmd === 'sync-swarm') {
        const res = swarmPatcher.sync(swarmOpts);
        if (opts.json) {
          console.log(JSON.stringify(res, null, 2));
        } else if (res.status === 'dryRun') {
          console.log(`[DRY-RUN] 计划同步 ${res.updatedFiles.length} 个文件: ${res.updatedFiles.join(', ') || '(无)'}`);
        } else if (res.status === 'upToDate') {
          console.log(`[OK] 仓库内 plugins/swarm-zh 已与目标一致 (${res.assetDir})`);
        } else {
          console.log(`[OK] 已同步 ${res.updatedFiles.length} 个 Swarm 汉化文件到 ${res.assetDir}: ${res.updatedFiles.join(', ')}`);
        }
      } else if (cmd === 'restore-swarm') {
        const res = swarmPatcher.restore(swarmOpts);
        if (opts.json) {
          console.log(JSON.stringify(res, null, 2));
        } else if (res.status === 'dryRun') {
          console.log(`[DRY-RUN] 计划恢复 ${res.restoredFiles.length} 个文件，移除: ${res.removedFiles.join(', ') || '(无)'}`);
        } else {
          console.log(`[OK] 已恢复原版 Swarm 面板 (${res.restoredFiles.length} 个文件): ${res.targetDir}`);
        }
      }
    } catch (err) {
      if (opts.json) {
        console.log(JSON.stringify({ status: 'error', error: err.message }, null, 2));
      } else {
        console.error(`[ERR] Swarm 操作失败 (${cmd}): ${err.message}`);
      }
      process.exit(1);
    }
  } else if (cmd === 'patch-backend' || cmd === 'restore-backend') {
    try {
      const contextLimit = opts.contextLimit !== null
        ? backendPatcher.parseContextLimit(opts.contextLimit)
        : backendPatcher.DEFAULT_CONTEXT_LIMIT;
      let targets;
      if (!opts.customPath) {
        targets = backendPatcher.discoverDefaultTargets();
      } else {
        const resolvedCustom = path.resolve(opts.customPath);
        if ((fs.existsSync(resolvedCustom) && fs.statSync(resolvedCustom).isDirectory()) || resolvedCustom.toLowerCase().endsWith('.asar')) {
          targets = resolveInspectBackendTargets(opts.customPath, undefined, backendPatcher);
        } else {
          targets = [resolvedCustom];
        }
      }
      if (targets.length === 0) {
        console.error('[ERR] 未发现可处理的后端二进制 (language_server / agy)，可使用 --path <可执行文件路径> 手动指定。');
        process.exit(1);
      }
      for (const t of targets) {
        if (cmd === 'restore-backend') {
          const res = backendPatcher.restoreTarget(t);
          console.log(`[OK] 已恢复原版后端: ${res.path} (${res.restored_sha256.slice(0, 16)}..)`);
        } else {
          const res = backendPatcher.patchTarget(t, { contextLimit });
          console.log(`[OK] 后端 1M 补丁完成 (${res.status}): ${res.path} | 阈值=${res.context_limit.toLocaleString()} tokens`);
        }
      }
      if (cmd === 'patch-backend') {
        backendPatcher.pruneOldBackups(backendPatcher.DEFAULT_BACKUP_DIR, targets);
      }
    } catch (err) {
      console.error(`[ERR] 后端操作失败: ${err.message}`);
      process.exit(1);
    }
  } else if (cmd === 'daily') {
    printDailyReport({ days: opts.days, date: opts.date });
  } else if (cmd === 'inspect' || cmd === 'status') {
    const asarPath = findAsarPath(opts.customPath);
    const pluginInstalled = fs.existsSync(path.join(getGlobalPluginTargetDir(), 'plugin.json'));
    const patchHint = process.platform === 'win32' ? 'patch.bat' : 'node cli.js install';
    console.log(`• 官方插件状态 (agy-hud):   ${pluginInstalled ? '[ON] 已安装' : '[OFF] 未安装'}`);
    console.log(`• 客户端输入框 HUD 补丁:    ${isAsarHudPatched(asarPath) ? '[ON] 已注入' : `[OFF] 未注入 (退出客户端后运行 ${patchHint} 即可注入)`}`);
    try {
      const swarmPatcher = require('./core/swarm-zh-patch.cjs');
      const sInfo = swarmPatcher.verify(buildSwarmOpts(opts));
      let swarmBadge;
      if (sInfo.status === 'patched') {
        swarmBadge = '[ON] 已注入 (7/7 文件校验通过)';
      } else if (sInfo.status === 'missing') {
        swarmBadge = '[INFO] 未发现 Swarm 面板目录';
      } else if (sInfo.status === 'unpatched') {
        swarmBadge = '[OFF] 未注入 (运行 node cli.js patch-swarm 即可注入)';
      } else if (sInfo.status === 'drifted') {
        swarmBadge = `[WARN] 检测到本地汉化变更 (${sInfo.driftedFiles.length} 个文件与包不一致，可运行 sync-swarm 或 patch-swarm)`;
      } else if (sInfo.status === 'partial') {
        swarmBadge = `[WARN] 部分被更新覆盖/缺失 (${sInfo.changedFiles.length} 个文件待处理，运行 patch-swarm 修复)`;
      } else {
        swarmBadge = `[WARN] 资源校验异常: ${sInfo.assetsError || sInfo.status}`;
      }
      console.log(`• Swarm 面板中文补丁:       ${swarmBadge}`);
    } catch (err) {
      console.log(`• Swarm 面板中文补丁:       [WARN] 检查失败: ${err.message}`);
    }
    const targets = resolveInspectBackendTargets(opts.customPath, asarPath, backendPatcher);
    if (targets.length === 0) {
      console.log('• 后端 1M 上下文补丁:       [WARN] 未发现后端二进制 (language_server / agy)');
    }
    for (const t of targets) {
      try {
        const bInfo = backendPatcher.analyzeBinary(t);
        const badge = bInfo.status === 'ALREADY_PATCHED'
          ? `[ON] 已打补丁 (阈值 ${bInfo.context_limit.toLocaleString()} tok, 宿主 ${bInfo.functions.trampolineHost.symbol.split('.').pop()})`
          : `[OFF] 未打补丁 (可打补丁 -> 默认 ${bInfo.context_limit.toLocaleString()} tok)`;
        console.log(`• 后端 1M 上下文补丁 (${path.basename(t)}): ${badge}`);
      } catch (err) {
        console.log(`• 后端 1M 上下文补丁 (${path.basename(t)}): [WARN] ${err.message}`);
      }
    }
    const convArg = opts.positionals.find(a => /^[0-9a-f-]{36}$/i.test(a));
    inspectLive(convArg);
  } else {
    console.error(`[ERR] 未知命令: ${cmd} (使用 --help 查看可用命令)`);
    process.exit(1);
  }
}
