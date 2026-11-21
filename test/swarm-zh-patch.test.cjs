'use strict';

const { describe, test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const PATCHER_PATH = path.join(ROOT, 'core', 'swarm-zh-patch.cjs');
const CLI_PATH = path.join(ROOT, 'cli.js');
const FAST_PATCH_PATH = path.join(ROOT, 'fast-patch.cjs');
const PKG_ASSET_DIR = path.join(ROOT, 'plugins', 'swarm-zh');

const swarmPatch = require(PATCHER_PATH);
const hudCli = require(CLI_PATH);
const fp = require(FAST_PATCH_PATH);

const TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-swarm-zh-test-'));

after(() => {
  try {
    fs.rmSync(TMP_ROOT, { recursive: true, force: true });
  } catch (_) {}
});

function sha256File(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function makeTempDir(prefix) {
  return fs.mkdtempSync(path.join(TMP_ROOT, prefix));
}

function createUpstreamFixture(targetDir, versionTag = 'v1') {
  fs.mkdirSync(targetDir, { recursive: true });
  const files = {
    'main.mjs': `// upstream main ${versionTag}\nexport function startBoard() { return '${versionTag}'; }\n`,
    'index.html': `<!DOCTYPE html><html lang="en"><head><title>Swarm Board ${versionTag}</title></head><body></body></html>\n`,
    'app.js': `// upstream app ${versionTag}\nfunction renderBoard() { return 'Board ${versionTag}'; }\n`,
    'hive.js': `// upstream hive ${versionTag}\nfunction renderOverview() { return 'Overview ${versionTag}'; }\n`,
    'narrator_bootstrap.js': `// upstream narrator ${versionTag}\nfunction initFeedback() { return 'Feedback ${versionTag}'; }\n`,
    'styles.css': `/* upstream styles ${versionTag} */\nbody { margin: 0; }\n`,
    'channels.mjs': `export const CHANNELS = ['general']; // ${versionTag}\n`,
    'hive.css': `.hive { display: block; } /* ${versionTag} */\n`,
    'sidecar.json': JSON.stringify({ name: 'swarm_board', command: 'node', args: ['main.mjs'], version: versionTag }, null, 2) + '\n'
  };
  for (const [name, content] of Object.entries(files)) {
    fs.writeFileSync(path.join(targetDir, name), content, 'utf8');
  }
  return files;
}

function copyAssetDir(dstAssetDir) {
  fs.mkdirSync(path.join(dstAssetDir, 'sidecars', 'swarm_board'), { recursive: true });
  fs.copyFileSync(path.join(PKG_ASSET_DIR, 'manifest.json'), path.join(dstAssetDir, 'manifest.json'));
  for (const name of swarmPatch.MANAGED_FILES) {
    fs.copyFileSync(
      path.join(PKG_ASSET_DIR, 'sidecars', 'swarm_board', name),
      path.join(dstAssetDir, 'sidecars', 'swarm_board', name)
    );
  }
  return dstAssetDir;
}

function buildSyntheticAsar() {
  const pkgBuf = Buffer.from('{"name":"antigravity","version":"2.32.1"}\n', 'utf8');
  const preloadBuf = Buffer.from('const electron_1 = require("electron");\n', 'utf8');
  const ipcBuf = Buffer.from(
    'const electron_1 = require("electron");\nfunction buildContextMenuTemplate(items, onSelect) {\n  const item = {};\n  const menu = { label: item.label ?? \'\' };\n  return menu;\n}\n',
    'utf8'
  );
  const menuBuf = Buffer.from('module.exports = { label: "New Window" };\n', 'utf8');
  const mainBuf = Buffer.from('module.exports = { label: "Quit" };\n', 'utf8');

  const chunks = [];
  const addNode = (buf) => {
    const offset = chunks.reduce((sum, b) => sum + b.length, 0);
    chunks.push(buf);
    return { size: buf.length, offset: String(offset) };
  };

  const root = {
    files: {
      'package.json': addNode(pkgBuf),
      dist: {
        files: {
          'preload.js': addNode(preloadBuf),
          'ipcHandlers.js': addNode(ipcBuf),
          'menu.js': addNode(menuBuf),
          'main.js': addNode(mainBuf)
        }
      },
      node_modules: {
        files: {
          native: {
            files: {
              'binding.node': { size: 16, unpacked: true }
            }
          }
        }
      }
    }
  };

  const jsonBuf = Buffer.from(JSON.stringify(root), 'utf8');
  const jsonLen = jsonBuf.length;
  const paddedJsonLen = Math.ceil(jsonLen / 4) * 4;
  const headerPayloadLen = 4 + paddedJsonLen;
  const headerPickleLen = 4 + headerPayloadLen;
  const headerBuf = Buffer.alloc(8 + headerPickleLen, 0);
  headerBuf.writeUInt32LE(4, 0);
  headerBuf.writeUInt32LE(headerPickleLen, 4);
  headerBuf.writeUInt32LE(headerPayloadLen, 8);
  headerBuf.writeUInt32LE(jsonLen, 12);
  jsonBuf.copy(headerBuf, 16);
  return Buffer.concat([headerBuf, ...chunks]);
}

describe('Swarm ZH Patcher & Asset Integrity (isolated in tmpdir)', () => {
  test('T1: packaged assets & manifest.json pass SHA-256, node --check, and hygiene checks', () => {
    const validation = swarmPatch.validateAssets(PKG_ASSET_DIR);
    assert.equal(validation.valid, true, validation.error || '');
    assert.equal(validation.manifest.schemaVersion, 1);
    assert.equal(validation.manifest.plugin, 'swarm');
    assert.equal(validation.manifest.sidecar, 'swarm_board');
    assert.equal(validation.manifest.files.length, 7);

    // Ensure no runtime cache or plugin.json or untouched upstream files are packaged
    assert.equal(fs.existsSync(path.join(PKG_ASSET_DIR, 'plugin.json')), false);
    assert.equal(fs.existsSync(path.join(PKG_ASSET_DIR, 'translation_cache.json')), false);
    const sidecarDir = path.join(PKG_ASSET_DIR, 'sidecars', 'swarm_board');
    const entries = fs.readdirSync(sidecarDir).sort();
    assert.deepEqual(entries, [...swarmPatch.MANAGED_FILES].sort());
    assert.equal(fs.existsSync(path.join(sidecarDir, 'translation_cache.json')), false);

    for (const scriptName of swarmPatch.SCRIPT_FILES) {
      const r = spawnSync(process.execPath, ['--check', path.join(sidecarDir, scriptName)], { encoding: 'utf8' });
      assert.equal(r.status, 0, `node --check failed for ${scriptName}: ${r.stderr}`);
    }
  });

  test('T2: fresh patch installs 7 localized files, preserves non-owned files, and writes external backup only', () => {
    const targetDir = makeTempDir('t2-target-');
    const backupDir = makeTempDir('t2-backup-');
    const upstream = createUpstreamFixture(targetDir, 'v1');

    const preVerify = swarmPatch.verify({ targetDir, backupDir });
    assert.equal(preVerify.status, 'unpatched');
    assert.equal(preVerify.needsPatch, true);
    assert.equal(preVerify.hasBackup, false);

    const res = swarmPatch.patch({ targetDir, backupDir });
    assert.equal(res.status, 'patched');
    assert.equal(res.verified, true);
    assert.equal(res.backupCreated, true);
    assert.deepEqual([...res.updatedFiles].sort(), [...swarmPatch.MANAGED_FILES].sort());

    // Non-owned upstream files remain byte-identical
    for (const untouched of ['channels.mjs', 'hive.css', 'sidecar.json']) {
      assert.equal(fs.readFileSync(path.join(targetDir, untouched), 'utf8'), upstream[untouched]);
    }

    // No backup artifacts inside swarm_board/
    assert.equal(fs.existsSync(path.join(targetDir, 'backup-manifest.json')), false);
    assert.equal(fs.existsSync(path.join(targetDir, 'files')), false);

    // External backup exists and holds only the 6 upstream files (never translator.mjs)
    const bakManifest = JSON.parse(fs.readFileSync(path.join(res.targetBackupDir, 'backup-manifest.json'), 'utf8'));
    assert.deepEqual(bakManifest.addedFiles, ['translator.mjs']);
    assert.equal(fs.existsSync(path.join(res.targetBackupDir, 'files', 'translator.mjs')), false);
    for (const name of swarmPatch.UPSTREAM_FILES) {
      const bakContent = fs.readFileSync(path.join(res.targetBackupDir, 'files', name), 'utf8');
      assert.equal(bakContent, upstream[name]);
    }

    const postVerify = swarmPatch.verify({ targetDir, backupDir });
    assert.equal(postVerify.status, 'patched');
    assert.equal(postVerify.hasBackup, true);
    assert.equal(postVerify.needsPatch, false);
  });

  test('T3: repeat patch is idempotent (alreadyPatched, zero disk writes, backup untouched)', () => {
    const targetDir = makeTempDir('t3-target-');
    const backupDir = makeTempDir('t3-backup-');
    createUpstreamFixture(targetDir, 'v1');

    const first = swarmPatch.patch({ targetDir, backupDir });
    assert.equal(first.status, 'patched');

    const bakManifestPath = path.join(first.targetBackupDir, 'backup-manifest.json');
    const bakMtimeBefore = fs.statSync(bakManifestPath).mtimeMs;
    const mainTargetPath = path.join(targetDir, 'main.mjs');
    const mainMtimeBefore = fs.statSync(mainTargetPath).mtimeMs;

    const second = swarmPatch.patch({ targetDir, backupDir });
    assert.equal(second.status, 'alreadyPatched');
    assert.equal(second.changed, false);
    assert.deepEqual(second.updatedFiles, []);
    assert.equal(fs.statSync(bakManifestPath).mtimeMs, bakMtimeBefore);
    assert.equal(fs.statSync(mainTargetPath).mtimeMs, mainMtimeBefore);
  });

  test('T4: already-localized target with empty backup dir never fabricates fake backup and restore refuses safely', () => {
    const targetDir = makeTempDir('t4-target-');
    const backupDir = makeTempDir('t4-backup-');
    // Seed targetDir already localized (like live M1/M2 machine)
    for (const name of swarmPatch.MANAGED_FILES) {
      fs.copyFileSync(path.join(PKG_ASSET_DIR, 'sidecars', 'swarm_board', name), path.join(targetDir, name));
    }

    const v = swarmPatch.verify({ targetDir, backupDir });
    assert.equal(v.status, 'patched');
    assert.equal(v.hasBackup, false);

    // Even with force: true, localized files must NEVER be saved as pristine upstream backups
    const forced = swarmPatch.patch({ targetDir, backupDir, force: true });
    assert.equal(forced.status, 'patched');
    assert.equal(forced.backupCreated, false);
    assert.equal(forced.backupSkippedReason, 'already_localized');
    assert.deepEqual(fs.readdirSync(backupDir), []);

    // Also test drifted localized target with empty backup dir
    const appPath = path.join(targetDir, 'app.js');
    fs.appendFileSync(appPath, '\n// local localized tweak\n', 'utf8');
    const driftedRes = swarmPatch.patch({ targetDir, backupDir });
    assert.equal(driftedRes.status, 'patched');
    assert.equal(driftedRes.backupCreated, false);
    assert.equal(driftedRes.backupSkippedReason, 'already_localized');
    assert.deepEqual(fs.readdirSync(backupDir), []);

    // restore must throw WITHOUT touching targetDir or deleting translator.mjs
    assert.throws(() => swarmPatch.restore({ targetDir, backupDir }), /无法恢复原版/);
    assert.equal(fs.existsSync(path.join(targetDir, 'translator.mjs')), true);
    assert.equal(swarmPatch.verify({ targetDir, backupDir }).status, 'patched');
  });

  test('T5: dry-run leaves target and backup directories completely untouched across patch/sync/restore', () => {
    const targetDir = makeTempDir('t5-target-');
    const backupDir = makeTempDir('t5-backup-');
    const assetDir = copyAssetDir(makeTempDir('t5-assets-'));
    const upstream = createUpstreamFixture(targetDir, 'v1');

    const dryPatch = swarmPatch.patch({ targetDir, backupDir, assetDir, dryRun: true });
    assert.equal(dryPatch.status, 'dryRun');
    assert.equal(dryPatch.wouldPatch, true);
    assert.equal(dryPatch.plannedUpdates.length, 7);
    assert.equal(fs.existsSync(path.join(targetDir, 'translator.mjs')), false);
    assert.equal(fs.readFileSync(path.join(targetDir, 'main.mjs'), 'utf8'), upstream['main.mjs']);
    assert.deepEqual(fs.readdirSync(backupDir), []);

    // Now actually patch, then test dryRun restore
    swarmPatch.patch({ targetDir, backupDir, assetDir });
    const dryRestore = swarmPatch.restore({ targetDir, backupDir, dryRun: true });
    assert.equal(dryRestore.status, 'dryRun');
    assert.equal(dryRestore.restoredFiles.length, 6);
    assert.deepEqual(dryRestore.removedFiles, ['translator.mjs']);
    assert.equal(swarmPatch.verify({ targetDir, backupDir, assetDir }).status, 'patched');

    // Modify localized file locally, test dryRun sync
    const translatorPath = path.join(targetDir, 'translator.mjs');
    const origAssetSha = sha256File(path.join(assetDir, 'sidecars', 'swarm_board', 'translator.mjs'));
    fs.appendFileSync(translatorPath, '\n// dry run edit\n', 'utf8');
    const drySync = swarmPatch.sync({ targetDir, assetDir, dryRun: true });
    assert.equal(drySync.status, 'dryRun');
    assert.deepEqual(drySync.updatedFiles, ['translator.mjs']);
    assert.equal(sha256File(path.join(assetDir, 'sidecars', 'swarm_board', 'translator.mjs')), origAssetSha);
  });

  test('T6: drift detection, Antigravity update overwrite recovery with backup refresh, and safe sync', () => {
    const targetDir = makeTempDir('t6-target-');
    const backupDir = makeTempDir('t6-backup-');
    const assetDir = copyAssetDir(makeTempDir('t6-assets-'));
    createUpstreamFixture(targetDir, 'v1');

    swarmPatch.patch({ targetDir, backupDir, assetDir });

    // Case A: Simulated Antigravity update overwrites 6 upstream files to v2, leaving translator.mjs behind
    const v2Upstream = createUpstreamFixture(targetDir, 'v2');
    assert.equal(fs.existsSync(path.join(targetDir, 'translator.mjs')), true);
    const partialVerify = swarmPatch.verify({ targetDir, backupDir, assetDir });
    assert.equal(partialVerify.status, 'partial');
    assert.equal(partialVerify.upstreamOverwritten, true);
    assert.equal(partialVerify.needsPatch, true);
    assert.equal(partialVerify.canSync, false);

    // sync MUST refuse to capture unlocalized English files!
    assert.throws(() => swarmPatch.sync({ targetDir, assetDir }), /拒绝同步/);

    // Re-patching refreshes backup to v2 upstream files and restores 7/7 localization
    const repatch = swarmPatch.patch({ targetDir, backupDir, assetDir });
    assert.equal(repatch.status, 'patched');
    assert.equal(repatch.backupUpdated, true);
    assert.deepEqual([...repatch.backedUpFiles].sort(), [...swarmPatch.UPSTREAM_FILES].sort());
    assert.equal(fs.readFileSync(path.join(repatch.targetBackupDir, 'files', 'main.mjs'), 'utf8'), v2Upstream['main.mjs']);

    // Case B: Localized edit creates 'drifted' state; sync captures it into isolated assetDir
    fs.appendFileSync(path.join(targetDir, 'translator.mjs'), '\nexport const M3_SYNC_MARKER = true;\n', 'utf8');
    const driftedVerify = swarmPatch.verify({ targetDir, backupDir, assetDir });
    assert.equal(driftedVerify.status, 'drifted');
    assert.deepEqual(driftedVerify.driftedFiles, ['translator.mjs']);
    assert.equal(driftedVerify.canSync, true);

    const synced = swarmPatch.sync({ targetDir, assetDir });
    assert.equal(synced.status, 'synced');
    assert.deepEqual(synced.updatedFiles, ['translator.mjs']);
    assert.equal(swarmPatch.verify({ targetDir, backupDir, assetDir }).status, 'patched');

    // Syntax error in localized JS refuses sync cleanly
    fs.appendFileSync(path.join(targetDir, 'app.js'), '\nfunction broken( {\n', 'utf8');
    assert.throws(() => swarmPatch.sync({ targetDir, assetDir }), /语法校验失败/);
  });

  test('T7: full restore lifecycle and corrupted backup pre-validation safety', () => {
    const targetDir = makeTempDir('t7-target-');
    const backupDir = makeTempDir('t7-backup-');
    const upstream = createUpstreamFixture(targetDir, 'v1');

    const patched = swarmPatch.patch({ targetDir, backupDir });
    assert.equal(patched.status, 'patched');

    // Corrupt one backup file -> restore must throw WITHOUT deleting translator.mjs or modifying target
    const bakIndexPath = path.join(patched.targetBackupDir, 'files', 'index.html');
    const realBakHtml = fs.readFileSync(bakIndexPath);
    fs.writeFileSync(bakIndexPath, 'corrupted bytes', 'utf8');
    assert.throws(() => swarmPatch.restore({ targetDir, backupDir }), /backup_sha256_mismatch/);
    assert.equal(fs.existsSync(path.join(targetDir, 'translator.mjs')), true);
    assert.equal(swarmPatch.verify({ targetDir, backupDir }).status, 'patched');

    // Restore valid backup file and run genuine restore
    fs.writeFileSync(bakIndexPath, realBakHtml);
    const restored = swarmPatch.restore({ targetDir, backupDir });
    assert.equal(restored.status, 'restored');
    assert.deepEqual(restored.removedFiles, ['translator.mjs']);
    assert.equal(fs.existsSync(path.join(targetDir, 'translator.mjs')), false);
    for (const name of swarmPatch.UPSTREAM_FILES) {
      assert.equal(fs.readFileSync(path.join(targetDir, name), 'utf8'), upstream[name]);
    }
    for (const untouched of ['channels.mjs', 'hive.css', 'sidecar.json']) {
      assert.equal(fs.readFileSync(path.join(targetDir, untouched), 'utf8'), upstream[untouched]);
    }
    assert.equal(swarmPatch.verify({ targetDir, backupDir }).status, 'unpatched');
  });

  test('T8: dynamic path resolution via options, env vars, and homedir product scan', () => {
    const envKeys = [
      'ANTIGRAVITY_SWARM_BOARD_DIR',
      'AGY_SWARM_BOARD_DIR',
      'AGY_BUILTIN_DIR',
      'ANTIGRAVITY_SWARM_ZH_BACKUP_DIR',
      'AGY_SWARM_ZH_BACKUP_DIR',
      'AGY_SWARM_BACKUP_DIR',
      'ANTIGRAVITY_SWARM_ZH_PACKAGE_DIR'
    ];
    const savedEnv = {};
    for (const k of envKeys) {
      savedEnv[k] = process.env[k];
      delete process.env[k];
    }

    try {
      const homeDir = makeTempDir('t8-home-');
      const cliSwarmDir = path.join(homeDir, '.gemini', 'antigravity-cli', 'builtin', 'plugins', 'swarm', 'sidecars', 'swarm_board');
      createUpstreamFixture(cliSwarmDir, 'cli');

      assert.equal(swarmPatch.resolveTargetDir({ homedir: homeDir }), cliSwarmDir);
      assert.equal(
        swarmPatch.resolveBackupDir({ homedir: homeDir }),
        path.join(homeDir, '.gemini', 'agy-patches', 'swarm-zh')
      );

      const envTarget = makeTempDir('t8-env-target-');
      const envBackup = makeTempDir('t8-env-backup-');
      process.env.ANTIGRAVITY_SWARM_BOARD_DIR = envTarget;
      process.env.ANTIGRAVITY_SWARM_ZH_BACKUP_DIR = envBackup;
      assert.equal(swarmPatch.resolveTargetDir(), path.resolve(envTarget));
      assert.equal(swarmPatch.resolveBackupDir(), path.resolve(envBackup));

      // Whitespace-only primary env var must fall through cleanly to secondary env var
      const fallbackTarget = makeTempDir('t8-env-fallback-');
      process.env.ANTIGRAVITY_SWARM_BOARD_DIR = '   ';
      process.env.AGY_SWARM_BOARD_DIR = fallbackTarget;
      assert.equal(swarmPatch.resolveTargetDir(), path.resolve(fallbackTarget));
    } finally {
      for (const k of envKeys) {
        if (savedEnv[k] === undefined) delete process.env[k];
        else process.env[k] = savedEnv[k];
      }
    }
  });

  test('T9: cli.js subprocess integration (--help, verify-swarm exit codes, patch/sync/restore, inspect, error paths)', () => {
    const targetDir = makeTempDir('t9-target-');
    const backupDir = makeTempDir('t9-backup-');
    const assetDir = copyAssetDir(makeTempDir('t9-assets-'));
    createUpstreamFixture(targetDir, 'v1');

    const helpRes = spawnSync(process.execPath, [CLI_PATH, '--help'], { encoding: 'utf8' });
    assert.equal(helpRes.status, 0);
    assert.ok(helpRes.stdout.includes('patch-swarm'));
    assert.ok(helpRes.stdout.includes('verify-swarm'));
    assert.ok(helpRes.stdout.includes('restore-swarm'));
    assert.ok(helpRes.stdout.includes('sync-swarm'));

    // verify-swarm on unpatched -> exit 2 + JSON status 'unpatched'
    const vUnpatched = spawnSync(
      process.execPath,
      [CLI_PATH, 'verify-swarm', '--target', targetDir, '--backup-dir', backupDir, '--asset-dir', assetDir, '--json'],
      { encoding: 'utf8' }
    );
    assert.equal(vUnpatched.status, 2);
    assert.equal(JSON.parse(vUnpatched.stdout).status, 'unpatched');

    // verify-swarm on missing -> exit 1
    const missingDir = path.join(TMP_ROOT, 'does-not-exist-swarm');
    const vMissing = spawnSync(
      process.execPath,
      [CLI_PATH, 'verify-swarm', '--target', missingDir, '--backup-dir', backupDir, '--json'],
      { encoding: 'utf8' }
    );
    assert.equal(vMissing.status, 1);
    assert.equal(JSON.parse(vMissing.stdout).status, 'missing');

    // patch-swarm -> exit 0, then verify-swarm -> exit 0
    const pRes = spawnSync(
      process.execPath,
      [CLI_PATH, 'patch-swarm', '--target', targetDir, '--backup-dir', backupDir, '--asset-dir', assetDir, '--json'],
      { encoding: 'utf8' }
    );
    assert.equal(pRes.status, 0, pRes.stderr);
    assert.equal(JSON.parse(pRes.stdout).status, 'patched');

    const vPatched = spawnSync(
      process.execPath,
      [CLI_PATH, 'verify-swarm', '--target', targetDir, '--backup-dir', backupDir, '--asset-dir', assetDir, '--json'],
      { encoding: 'utf8' }
    );
    assert.equal(vPatched.status, 0);
    assert.equal(JSON.parse(vPatched.stdout).status, 'patched');

    // sync-swarm upToDate -> exit 0
    const sRes = spawnSync(
      process.execPath,
      [CLI_PATH, 'sync-swarm', '--target', targetDir, '--asset-dir', assetDir, '--json'],
      { encoding: 'utf8' }
    );
    assert.equal(sRes.status, 0, sRes.stderr);
    assert.equal(JSON.parse(sRes.stdout).status, 'upToDate');

    // restore-swarm -> exit 0, then verify-swarm -> exit 2
    const rRes = spawnSync(
      process.execPath,
      [CLI_PATH, 'restore-swarm', '--target', targetDir, '--backup-dir', backupDir, '--json'],
      { encoding: 'utf8' }
    );
    assert.equal(rRes.status, 0, rRes.stderr);
    assert.equal(JSON.parse(rRes.stdout).status, 'restored');

    // inspect --path <tmpAsar> read-only check
    const tmpAsarDir = makeTempDir('t9-asar-');
    const tmpAsar = path.join(tmpAsarDir, 'app.asar');
    fs.writeFileSync(tmpAsar, buildSyntheticAsar());
    const inspectRes = spawnSync(
      process.execPath,
      [CLI_PATH, 'inspect', '--path', tmpAsar, '--target', targetDir, '--backup-dir', backupDir],
      {
        encoding: 'utf8',
        env: {
          ...process.env,
          AGY_BRAIN_DIR: makeTempDir('t9-brain-'),
          AGY_HUD_DATA_DIR: makeTempDir('t9-hud-data-'),
          AGY_HUD_PLUGIN_DIR: makeTempDir('t9-hud-plugin-')
        }
      }
    );
    assert.equal(inspectRes.status, 0, inspectRes.stderr);
    assert.ok(inspectRes.stdout.includes('Swarm 面板中文补丁'));
    assert.equal(swarmPatch.verify({ targetDir, backupDir }).status, 'unpatched');

    // Invalid flag / missing flag value -> exit 1
    const badFlag = spawnSync(process.execPath, [CLI_PATH, 'verify-swarm', '--target'], { encoding: 'utf8' });
    assert.equal(badFlag.status, 1);
  });

  test('T10: fast-patch.cjs --swarm-only and fastPatchAsar isolation + integration', () => {
    const targetDir = makeTempDir('t10-target-');
    const backupDir = makeTempDir('t10-backup-');
    createUpstreamFixture(targetDir, 'v1');

    // --swarm-only --dry-run works without app.asar and writes nothing
    const dryFp = spawnSync(
      process.execPath,
      [FAST_PATCH_PATH, '--swarm-only', '--swarm-target', targetDir, '--swarm-backup-dir', backupDir, '--dry-run'],
      { encoding: 'utf8' }
    );
    assert.equal(dryFp.status, 0, dryFp.stderr);
    assert.equal(swarmPatch.verify({ targetDir, backupDir }).status, 'unpatched');

    // --swarm-only applies patch cleanly without touching app.asar
    const runFp = spawnSync(
      process.execPath,
      [FAST_PATCH_PATH, '--swarm-only', '--swarm-target', targetDir, '--swarm-backup-dir', backupDir],
      { encoding: 'utf8' }
    );
    assert.equal(runFp.status, 0, runFp.stderr);
    assert.equal(swarmPatch.verify({ targetDir, backupDir }).status, 'patched');

    // fastPatchAsar skipPlugins / hudOnly / skipSwarm MUST NOT touch swarmTargetDir
    const asarDir = makeTempDir('t10-asar-');
    const synthAsar = path.join(asarDir, 'app.asar');
    const synthBuf = buildSyntheticAsar();
    const tmpDict = path.join(asarDir, 'zh-CN.json');
    const tmpRuntime = path.join(asarDir, 'i18n-runtime.js');
    fs.writeFileSync(tmpDict, '{"exact":{"Settings":"设置"},"regexp":[]}\n', 'utf8');
    fs.writeFileSync(tmpRuntime, 'window.__i18nReady = true;\n', 'utf8');

    const isolatedTarget = makeTempDir('t10-isolated-swarm-');
    const isolatedBackup = makeTempDir('t10-isolated-bak-');
    createUpstreamFixture(isolatedTarget, 'v1');

    const prevPluginDir = process.env.AGY_HUD_PLUGIN_DIR;
    const prevDataDir = process.env.AGY_HUD_DATA_DIR;
    const prevBrainDir = process.env.AGY_BRAIN_DIR;
    try {
      process.env.AGY_HUD_PLUGIN_DIR = makeTempDir('t10-hud-plugin-');
      process.env.AGY_HUD_DATA_DIR = makeTempDir('t10-hud-data-');
      process.env.AGY_BRAIN_DIR = makeTempDir('t10-brain-');

      for (const skipCase of [
        { skipPlugins: true },
        { hudOnly: true },
        { skipSwarm: true }
      ]) {
        fs.writeFileSync(synthAsar, synthBuf);
        const r = fp.fastPatchAsar({
          customPath: synthAsar,
          dictPath: tmpDict,
          runtimePath: tmpRuntime,
          skipBgSync: true,
          skipProcessCheck: true,
          swarmTargetDir: isolatedTarget,
          swarmBackupDir: isolatedBackup,
          ...skipCase
        });
        assert.equal(r.swarmResult, null);
        assert.equal(swarmPatch.verify({ targetDir: isolatedTarget, backupDir: isolatedBackup }).status, 'unpatched');
      }

      // When skipPlugins: false, hudOnly: false, skipSwarm: false AND explicit swarmTargetDir -> patches both ASAR and swarm_board!
      fs.writeFileSync(synthAsar, synthBuf);
      const rBoth = fp.fastPatchAsar({
        customPath: synthAsar,
        dictPath: tmpDict,
        runtimePath: tmpRuntime,
        skipPlugins: false,
        hudOnly: false,
        skipSwarm: false,
        skipBgSync: true,
        skipProcessCheck: true,
        swarmTargetDir: isolatedTarget,
        swarmBackupDir: isolatedBackup
      });
      assert.ok(rBoth.swarmResult && rBoth.swarmResult.status === 'patched');
      assert.equal(swarmPatch.verify({ targetDir: isolatedTarget, backupDir: isolatedBackup }).status, 'patched');
    } finally {
      if (prevPluginDir === undefined) delete process.env.AGY_HUD_PLUGIN_DIR;
      else process.env.AGY_HUD_PLUGIN_DIR = prevPluginDir;
      if (prevDataDir === undefined) delete process.env.AGY_HUD_DATA_DIR;
      else process.env.AGY_HUD_DATA_DIR = prevDataDir;
      if (prevBrainDir === undefined) delete process.env.AGY_BRAIN_DIR;
      else process.env.AGY_BRAIN_DIR = prevBrainDir;
    }

    // tmp ASAR guard: isPathInTmpDir returns true for paths in os.tmpdir()
    assert.equal(fp.isPathInTmpDir(synthAsar), true);
  });

  test('T11: cli.js install subprocess modes (--no-swarm, --dry-run, default, --hud-only) in isolated tmpdir', () => {
    const setupCase = (tag) => {
      const caseRoot = makeTempDir(`t11-${tag}-`);
      const homeDir = path.join(caseRoot, 'home');
      const pluginDir = path.join(caseRoot, 'hud-plugin');
      const dataDir = path.join(caseRoot, 'hud-data');
      const brainDir = path.join(caseRoot, 'brain');
      const chineseRoot = path.join(caseRoot, 'chinese');
      const syncStatusFile = path.join(caseRoot, 'sync-status.json');
      const swarmDir = path.join(caseRoot, 'swarm_board');
      const backupDir = path.join(caseRoot, 'swarm-backup');
      const asarDir = path.join(caseRoot, 'client', 'resources');
      const asarPath = path.join(asarDir, 'app.asar');

      fs.mkdirSync(homeDir, { recursive: true });
      fs.mkdirSync(path.join(chineseRoot, 'dict'), { recursive: true });
      fs.mkdirSync(path.join(chineseRoot, 'core'), { recursive: true });
      fs.mkdirSync(asarDir, { recursive: true });
      fs.writeFileSync(path.join(chineseRoot, 'dict', 'zh-CN.json'), '{"exact":{"Settings":"设置"},"regexp":[]}\n', 'utf8');
      fs.writeFileSync(path.join(chineseRoot, 'core', 'i18n-runtime.js'), 'window.__i18nReady = true;\n', 'utf8');
      fs.writeFileSync(syncStatusFile, JSON.stringify({ lastAttemptAt: Date.now() }), 'utf8');
      fs.writeFileSync(asarPath, buildSyntheticAsar());
      createUpstreamFixture(swarmDir, 'v1');

      const env = {
        ...process.env,
        HOME: homeDir,
        USERPROFILE: homeDir,
        AGY_HUD_PLUGIN_DIR: pluginDir,
        AGY_HUD_DATA_DIR: dataDir,
        AGY_BRAIN_DIR: brainDir,
        AGY_CHINESE_ROOT: chineseRoot,
        AGY_SYNC_STATUS_FILE: syncStatusFile,
        ANTIGRAVITY_SWARM_BOARD_DIR: swarmDir,
        ANTIGRAVITY_SWARM_ZH_BACKUP_DIR: backupDir
      };
      return { asarPath, swarmDir, backupDir, pluginDir, env };
    };

    // 1. --no-swarm: ASAR patched (Chinese+HUD), Swarm temp dir stays unpatched
    const cNoSwarm = setupCase('noswarm');
    const rNoSwarm = spawnSync(
      process.execPath,
      [CLI_PATH, 'install', '--path', cNoSwarm.asarPath, '--no-swarm'],
      { encoding: 'utf8', env: cNoSwarm.env }
    );
    assert.equal(rNoSwarm.status, 0, rNoSwarm.stderr || rNoSwarm.stdout);
    assert.equal(hudCli.isAsarHudPatched(cNoSwarm.asarPath), true);
    assert.equal(fp.isBufferPatched(fs.readFileSync(cNoSwarm.asarPath)), true);
    assert.equal(fs.existsSync(path.join(cNoSwarm.pluginDir, 'plugin.json')), true);
    assert.equal(swarmPatch.verify({ targetDir: cNoSwarm.swarmDir, backupDir: cNoSwarm.backupDir }).status, 'unpatched');

    // 2. --dry-run: does NOT crash on missing updatedFiles, Swarm temp dir stays unpatched
    const cDryRun = setupCase('dryrun');
    const rDryRun = spawnSync(
      process.execPath,
      [CLI_PATH, 'install', '--path', cDryRun.asarPath, '--dry-run'],
      { encoding: 'utf8', env: cDryRun.env }
    );
    assert.equal(rDryRun.status, 0, rDryRun.stderr || rDryRun.stdout);
    assert.ok(rDryRun.stdout.includes('[DRY-RUN] [3/3]'), rDryRun.stdout);
    assert.equal(swarmPatch.verify({ targetDir: cDryRun.swarmDir, backupDir: cDryRun.backupDir }).status, 'unpatched');

    // 3. Default install: ASAR patched AND Swarm temp dir becomes patched
    const cDefault = setupCase('default');
    const rDefault = spawnSync(
      process.execPath,
      [CLI_PATH, 'install', '--path', cDefault.asarPath],
      { encoding: 'utf8', env: cDefault.env }
    );
    assert.equal(rDefault.status, 0, rDefault.stderr || rDefault.stdout);
    assert.equal(hudCli.isAsarHudPatched(cDefault.asarPath), true);
    assert.equal(fp.isBufferPatched(fs.readFileSync(cDefault.asarPath)), true);
    assert.equal(swarmPatch.verify({ targetDir: cDefault.swarmDir, backupDir: cDefault.backupDir }).status, 'patched');

    // 4. --hud-only: ASAR HUD-only patched (no Chinese), Swarm temp dir stays unpatched
    const cHudOnly = setupCase('hudonly');
    const rHudOnly = spawnSync(
      process.execPath,
      [CLI_PATH, 'install', '--path', cHudOnly.asarPath, '--hud-only'],
      { encoding: 'utf8', env: cHudOnly.env }
    );
    assert.equal(rHudOnly.status, 0, rHudOnly.stderr || rHudOnly.stdout);
    const hudOnlyBuf = fs.readFileSync(cHudOnly.asarPath);
    assert.equal(hudCli.isAsarHudPatched(cHudOnly.asarPath), true);
    assert.equal(fp.isBufferHudPatched(hudOnlyBuf), true);
    assert.equal(fp.isBufferPatched(hudOnlyBuf), false);
    assert.equal(swarmPatch.verify({ targetDir: cHudOnly.swarmDir, backupDir: cHudOnly.backupDir }).status, 'unpatched');
  });

  test('T12: Tier 5 — selective single-file overwrite+restore, mid-write rollback, and assets_invalid CLI exit 1', () => {
    // 1. Selective single-file upstream overwrite (main.mjs v2 while app.js stays localized)
    const target1 = makeTempDir('t12-sel-target-');
    const backup1 = makeTempDir('t12-sel-bak-');
    const asset1 = copyAssetDir(makeTempDir('t12-sel-assets-'));
    const v1 = createUpstreamFixture(target1, 'v1');
    swarmPatch.patch({ targetDir: target1, backupDir: backup1, assetDir: asset1 });

    const mainV2 = '// upstream main v2 overwrite\nexport function startBoard() { return "v2"; }\n';
    fs.writeFileSync(path.join(target1, 'main.mjs'), mainV2, 'utf8');
    const vPartial = swarmPatch.verify({ targetDir: target1, backupDir: backup1, assetDir: asset1 });
    assert.equal(vPartial.status, 'partial');

    const pSelective = swarmPatch.patch({ targetDir: target1, backupDir: backup1, assetDir: asset1 });
    assert.equal(pSelective.status, 'patched');
    assert.equal(swarmPatch.verify({ targetDir: target1, backupDir: backup1, assetDir: asset1 }).status, 'patched');

    const rSelective = swarmPatch.restore({ targetDir: target1, backupDir: backup1 });
    assert.equal(rSelective.status, 'restored');
    assert.equal(fs.readFileSync(path.join(target1, 'main.mjs'), 'utf8'), mainV2);
    assert.equal(fs.readFileSync(path.join(target1, 'app.js'), 'utf8'), v1['app.js']);

    // 2. Mid-write rollback when a later target file fails (styles.css replaced by a directory)
    const target2 = makeTempDir('t12-rb-target-');
    const backup2 = makeTempDir('t12-rb-bak-');
    const v1Rb = createUpstreamFixture(target2, 'v1-rb');
    fs.unlinkSync(path.join(target2, 'styles.css'));
    fs.mkdirSync(path.join(target2, 'styles.css'));

    assert.throws(() => swarmPatch.patch({ targetDir: target2, backupDir: backup2, assetDir: asset1 }));
    assert.equal(fs.readFileSync(path.join(target2, 'main.mjs'), 'utf8'), v1Rb['main.mjs']);
    assert.equal(fs.readFileSync(path.join(target2, 'app.js'), 'utf8'), v1Rb['app.js']);
    assert.equal(fs.existsSync(path.join(target2, 'translator.mjs')), false);

    // 3. cli.js verify-swarm --asset-dir <corrupt> --json -> exit 1 & status === 'assets_invalid'
    const badAssetDir = makeTempDir('t12-bad-assets-');
    fs.mkdirSync(path.join(badAssetDir, 'sidecars', 'swarm_board'), { recursive: true });
    fs.writeFileSync(path.join(badAssetDir, 'manifest.json'), '{"version":1,"files":{}}\n', 'utf8');
    const badRes = spawnSync(
      process.execPath,
      [CLI_PATH, 'verify-swarm', '--target', target1, '--backup-dir', backup1, '--asset-dir', badAssetDir, '--json'],
      { encoding: 'utf8' }
    );
    assert.equal(badRes.status, 1);
    assert.equal(JSON.parse(badRes.stdout).status, 'assets_invalid');
  });
});
