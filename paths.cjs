'use strict';

/**
 * Shared path resolution for the Antigravity HUD + optional Chinese localization toolchain.
 * - AGY_CHINESE_ROOT overrides the location of the optional antigravity-chinese checkout.
 * - Upstream repository: https://github.com/yiheng8023/antigravity-chinese.git
 * - Default: sibling directory `../antigravity-chinese` (or `../1/antigravity-chinese` when
 *   present on disk), resolved relative to this repository root.
 */

const fs = require('fs');
const path = require('path');

const PROJECT_ROOT = __dirname;

function resolveDefaultChineseRoot() {
  if (process.env.AGY_CHINESE_ROOT) {
    return path.resolve(process.env.AGY_CHINESE_ROOT);
  }
  const candidates = [
    path.resolve(PROJECT_ROOT, '..', 'antigravity-chinese'),
    path.resolve(PROJECT_ROOT, '..', '1', 'antigravity-chinese')
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return candidates[0];
}

function resolveChinesePaths(customRoot) {
  const root = customRoot ? path.resolve(customRoot) : resolveDefaultChineseRoot();
  return {
    CHINESE_ROOT: root,
    DICT_PATH: path.join(root, 'dict', 'zh-CN.json'),
    I18N_RUNTIME_PATH: path.join(root, 'core', 'i18n-runtime.js'),
    CHINESE_CLI_PATH: path.join(root, 'cli.js'),
    CHINESE_PKG_PATH: path.join(root, 'package.json')
  };
}

const defaultChinesePaths = resolveChinesePaths();

module.exports = {
  PROJECT_ROOT,
  ...defaultChinesePaths,
  resolveDefaultChineseRoot,
  resolveChinesePaths,
  PARSER_SRC_PATH: path.join(PROJECT_ROOT, 'core', 'telemetry-parser.cjs'),
  SYNC_STATUS_FILE: path.join(PROJECT_ROOT, '.last_bg_sync.json')
};
