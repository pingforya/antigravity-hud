#!/usr/bin/env node
'use strict';

const cli = require('./cli.js');
const { fastPatchAsar, ensureTargetNotRunning } = require('./fast-patch.cjs');

function parseArgs(argv) {
  let customPath = null;
  let hudOnly = false;
  let help = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      help = true;
    } else if (arg === '--path') {
      if (i + 1 >= argv.length || !argv[i + 1] || argv[i + 1].startsWith('-')) {
        throw new Error('参数 --path 缺少目标路径 (<dir|app.asar>)');
      }
      customPath = argv[++i];
    } else if (arg === '--hud-only') {
      hudOnly = true;
    } else {
      throw new Error(`未知参数: ${arg} (使用 --help 查看帮助)`);
    }
  }
  return { help, customPath, hudOnly };
}

function apply(customPath, options = {}) {
  const asarPath = cli.findAsarPath(customPath);
  if (!asarPath) {
    throw new Error(`未找到目标 app.asar: ${customPath || 'Antigravity 安装目录下的 resources/app.asar'}`);
  }
  ensureTargetNotRunning(asarPath);
  cli.installPlugin();
  fastPatchAsar({
    customPath: asarPath,
    hudOnly: Boolean(options.hudOnly),
    skipPlugins: true,
    skipBgSync: true,
    skipProcessCheck: true
  });
  console.log('[OK] 新聊天角色选择器与 HUD 修复已注入完成，重新打开 Antigravity 即可生效。');
}

if (require.main === module) {
  try {
    const opts = parseArgs(process.argv.slice(2));
    if (opts.help) {
      console.log('用法: node apply-new-chat-persona.cjs [--path <dir|app.asar>] [--hud-only]');
      process.exit(0);
    }
    apply(opts.customPath, { hudOnly: opts.hudOnly });
  } catch (error) {
    console.error(`[ERR] ${error.message}`);
    process.exit(1);
  }
}

module.exports = { apply };
