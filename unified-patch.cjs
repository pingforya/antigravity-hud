#!/usr/bin/env node
'use strict';

/**
 * Antigravity Unified Patcher (Chinese Localization & HUD Frontend/IPC + Plugin Sync)
 * Powered by the in-memory ASAR engine (fast-patch.cjs) — completes in ~0.1s with zero network or npx overhead.
 *
 * Scope:
 *   - Patches client `app.asar` frontend/IPC (`dist/preload.js`, `dist/ipcHandlers.js`, etc.) and syncs `agy-hud` plugin.
 *   - Does NOT patch the Go backend binary (`language_server` / `agy`); run `node cli.js patch-backend`
 *     (or `patch.bat` / `patch.ps1` on Windows) for the 1M context & rules budget binary patch.
 *
 * Note: Requires the target Antigravity client to be closed beforehand; for interactive process
 * detection and graceful shutdown prompts, run `patch.bat` / `patch.ps1` on Windows.
 */

const { fastPatchAsar } = require('./fast-patch.cjs');

function printHelp() {
  console.log([
    '用法: node unified-patch.cjs [选项]',
    '',
    '作用范围:',
    '  - 注入客户端 app.asar 前端/IPC (HUD 胶囊 + 新聊天角色选择器 + 可选中文汉化) 并部署 agy-hud 插件。',
    '  - 不包含 Go 后端 1M 上下文二进制补丁；如需修补后端请运行: node cli.js patch-backend',
    '',
    '选项:',
    '  --path <dir|app.asar>  指定 Antigravity 安装目录或 app.asar 文件路径',
    '  --hud-only             仅注入 HUD 胶囊与角色选择器，跳过中文汉化',
    '  --no-plugins           跳过同步全局插件目录',
    '  --no-bg-sync           跳过后台汉化词库更新检查',
    '  --skip-process-check   跳过运行中进程检查',
    '  -h, --help             显示此帮助信息'
  ].join('\n'));
}

function parseArgs(argv) {
  let customPath = null;
  let hudOnly = false;
  let skipPlugins = false;
  let skipBgSync = false;
  let skipProcessCheck = false;
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
    } else {
      throw new Error(`未知参数: ${arg} (使用 --help 查看帮助)`);
    }
  }
  return { help, customPath, hudOnly, skipPlugins, skipBgSync, skipProcessCheck };
}

if (require.main === module) {
  try {
    const opts = parseArgs(process.argv.slice(2));
    if (opts.help) {
      printHelp();
      process.exit(0);
    }
    fastPatchAsar({
      customPath: opts.customPath,
      hudOnly: opts.hudOnly,
      skipPlugins: opts.skipPlugins,
      skipBgSync: opts.skipBgSync,
      skipProcessCheck: opts.skipProcessCheck
    });
  } catch (err) {
    console.error(`[ERR] 一体化极速补丁执行失败: ${err.message}`);
    process.exit(1);
  }
}

module.exports = { parseArgs };
