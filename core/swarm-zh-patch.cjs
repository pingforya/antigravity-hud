'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const MANAGED_FILES = [
  'translator.mjs',
  'main.mjs',
  'index.html',
  'app.js',
  'hive.js',
  'narrator_bootstrap.js',
  'styles.css'
];

const UPSTREAM_FILES = [
  'main.mjs',
  'index.html',
  'app.js',
  'hive.js',
  'narrator_bootstrap.js',
  'styles.css'
];

const CREATED_FILES = ['translator.mjs'];
const SCRIPT_FILES = ['translator.mjs', 'main.mjs', 'app.js', 'hive.js', 'narrator_bootstrap.js'];
const PRODUCT_DIRS = ['antigravity', 'antigravity-cli', 'antigravity-ide'];

function sha256Buffer(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function normcase(p) {
  const str = String(p || '');
  return process.platform === 'win32' ? str.toLowerCase() : str;
}

function realpathOrResolve(targetPath) {
  const resolved = path.resolve(String(targetPath || ''));
  try {
    if (fs.existsSync(resolved)) {
      return fs.realpathSync(resolved);
    }
  } catch (_) {}
  return resolved;
}

function computeTargetTag(targetDir) {
  const canonical = normcase(realpathOrResolve(targetDir));
  return crypto.createHash('sha256').update(canonical, 'utf8').digest('hex').slice(0, 12);
}

function firstNonEmptyEnv(...names) {
  for (const name of names) {
    const val = process.env[name];
    if (typeof val === 'string' && val.trim()) {
      return val.trim();
    }
  }
  return '';
}

function resolveTargetDir(options = {}) {
  if (options.targetDir) return path.resolve(options.targetDir);
  if (options.swarmDir) return path.resolve(options.swarmDir);

  const envTarget = firstNonEmptyEnv('ANTIGRAVITY_SWARM_BOARD_DIR', 'AGY_SWARM_BOARD_DIR');
  if (envTarget) {
    return path.resolve(envTarget);
  }

  const builtinDir = (options.builtinDir && String(options.builtinDir).trim())
    ? String(options.builtinDir).trim()
    : firstNonEmptyEnv('AGY_BUILTIN_DIR');
  if (builtinDir) {
    return path.join(path.resolve(builtinDir), 'plugins', 'swarm', 'sidecars', 'swarm_board');
  }

  const home = options.homedir || os.homedir();
  const candidates = PRODUCT_DIRS.map((product) =>
    path.join(home, '.gemini', product, 'builtin', 'plugins', 'swarm', 'sidecars', 'swarm_board')
  );
  for (const cand of candidates) {
    try {
      if (fs.existsSync(cand) && fs.statSync(cand).isDirectory()) {
        return cand;
      }
    } catch (_) {}
  }
  return candidates[0];
}

function resolveBackupDir(options = {}) {
  if (options.backupDir) return path.resolve(options.backupDir);
  const envBackup = firstNonEmptyEnv(
    'ANTIGRAVITY_SWARM_ZH_BACKUP_DIR',
    'AGY_SWARM_ZH_BACKUP_DIR',
    'AGY_SWARM_BACKUP_DIR'
  );
  if (envBackup) {
    return path.resolve(envBackup);
  }
  const home = options.homedir || os.homedir();
  return path.join(home, '.gemini', 'agy-patches', 'swarm-zh');
}

function resolveAssetDir(options = {}) {
  if (options.assetDir) return path.resolve(options.assetDir);
  if (options.packageDir) return path.resolve(options.packageDir);
  const envAsset = firstNonEmptyEnv('ANTIGRAVITY_SWARM_ZH_PACKAGE_DIR');
  if (envAsset) {
    return path.resolve(envAsset);
  }
  return path.join(__dirname, '..', 'plugins', 'swarm-zh');
}

function resolveTargetBackupDir(targetDir, options = {}) {
  const backupDir = resolveBackupDir(options);
  const targetTag = computeTargetTag(targetDir);
  return {
    backupDir,
    targetTag,
    targetBackupDir: path.join(backupDir, targetTag)
  };
}

function hasLocalizationMarker(name, content) {
  if (typeof content !== 'string') return false;
  switch (name) {
    case 'translator.mjs':
      return content.includes('createTranslator') && content.includes('maskTechnicalLiterals');
    case 'main.mjs':
      return content.includes('./translator.mjs') && content.includes('translateSnapshotFields');
    case 'index.html':
      return content.includes('<html lang="zh-CN">') && content.includes('Swarm 协作看板');
    case 'app.js':
      return content.includes('msgDisplayText') && content.includes('tier1Fallback');
    case 'hive.js':
      return content.includes('tier1ClientFallback') && content.includes('协调者');
    case 'narrator_bootstrap.js':
      return content.includes('对此项提供反馈');
    case 'styles.css':
      return content.includes('Header (Swarm ZH UI)');
    default:
      return false;
  }
}

function writeFileAtomic(filePath, data) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const tmpPath = `${filePath}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(String(data), 'utf8');
  let fd;
  try {
    fd = fs.openSync(tmpPath, 'w');
    let offset = 0;
    while (offset < buf.length) {
      offset += fs.writeSync(fd, buf, offset, buf.length - offset);
    }
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    fs.renameSync(tmpPath, filePath);
  } finally {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch (_) {}
    }
    try {
      if (fs.existsSync(tmpPath)) fs.rmSync(tmpPath, { force: true });
    } catch (_) {}
  }
}

function validateAssets(assetDir) {
  const manifestPath = path.join(assetDir, 'manifest.json');
  const sidecarDir = path.join(assetDir, 'sidecars', 'swarm_board');
  const errors = [];

  if (!fs.existsSync(manifestPath)) {
    return {
      valid: false,
      error: `未找到打包资源清单: ${manifestPath}`,
      errors: [`missing manifest: ${manifestPath}`],
      manifest: null,
      entriesByName: {},
      assetDir,
      sidecarDir
    };
  }

  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  } catch (err) {
    return {
      valid: false,
      error: `资源清单 JSON 解析失败: ${err.message}`,
      errors: [`invalid manifest json: ${err.message}`],
      manifest: null,
      entriesByName: {},
      assetDir,
      sidecarDir
    };
  }

  if (!manifest || manifest.schemaVersion !== 1 || !Array.isArray(manifest.files)) {
    return {
      valid: false,
      error: '资源清单结构无效 (需要 schemaVersion=1 且 files 为数组)',
      errors: ['invalid manifest schema'],
      manifest,
      entriesByName: {},
      assetDir,
      sidecarDir
    };
  }

  const entriesByName = {};
  for (const entry of manifest.files) {
    if (!entry || typeof entry.path !== 'string') {
      errors.push('invalid manifest entry without path');
      continue;
    }
    if (entriesByName[entry.path]) {
      errors.push(`duplicate manifest entry: ${entry.path}`);
      continue;
    }
    entriesByName[entry.path] = entry;
  }

  for (const name of MANAGED_FILES) {
    const entry = entriesByName[name];
    if (!entry) {
      errors.push(`manifest missing managed file: ${name}`);
      continue;
    }
    const expectedCreated = CREATED_FILES.includes(name);
    if (typeof entry.createdByPatch !== 'boolean' || entry.createdByPatch !== expectedCreated) {
      errors.push(`invalid createdByPatch for ${name}`);
    }
    if (typeof entry.sha256 !== 'string' || !/^[0-9a-f]{64}$/i.test(entry.sha256)) {
      errors.push(`invalid sha256 in manifest for ${name}`);
      continue;
    }
    const assetFile = path.join(sidecarDir, name);
    if (!fs.existsSync(assetFile) || !fs.statSync(assetFile).isFile()) {
      errors.push(`missing packaged asset file: ${assetFile}`);
      continue;
    }
    const buf = fs.readFileSync(assetFile);
    const actualSha = sha256Buffer(buf);
    if (actualSha !== entry.sha256) {
      errors.push(`asset sha256 mismatch for ${name}: expected ${entry.sha256}, got ${actualSha}`);
    }
    if (typeof entry.size === 'number' && buf.length !== entry.size) {
      errors.push(`asset size mismatch for ${name}: expected ${entry.size}, got ${buf.length}`);
    }
    if (!hasLocalizationMarker(name, buf.toString('utf8'))) {
      errors.push(`packaged asset missing localization marker: ${name}`);
    }
  }

  return {
    valid: errors.length === 0,
    error: errors.length > 0 ? errors.join('; ') : null,
    errors,
    manifest,
    entriesByName,
    assetDir,
    sidecarDir
  };
}

function inspectBackup(targetBackupDir) {
  const manifestPath = path.join(targetBackupDir, 'backup-manifest.json');
  const filesDir = path.join(targetBackupDir, 'files');

  if (!fs.existsSync(manifestPath)) {
    return {
      hasBackup: false,
      backupValid: false,
      reason: 'backup_manifest_missing',
      manifestPath,
      filesDir,
      manifest: null
    };
  }

  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  } catch (err) {
    return {
      hasBackup: false,
      backupValid: false,
      reason: `backup_manifest_invalid: ${err.message}`,
      manifestPath,
      filesDir,
      manifest: null
    };
  }

  if (!manifest || manifest.schemaVersion !== 1 || !manifest.files || typeof manifest.files !== 'object') {
    return {
      hasBackup: false,
      backupValid: false,
      reason: 'backup_manifest_schema_invalid',
      manifestPath,
      filesDir,
      manifest: null
    };
  }

  for (const name of UPSTREAM_FILES) {
    const entry = manifest.files[name];
    if (!entry || typeof entry.sha256 !== 'string' || !/^[0-9a-f]{64}$/i.test(entry.sha256)) {
      return {
        hasBackup: false,
        backupValid: false,
        reason: `backup_entry_invalid:${name}`,
        manifestPath,
        filesDir,
        manifest
      };
    }
    const bakFile = path.join(filesDir, name);
    if (!fs.existsSync(bakFile) || !fs.statSync(bakFile).isFile()) {
      return {
        hasBackup: false,
        backupValid: false,
        reason: `backup_file_missing:${name}`,
        manifestPath,
        filesDir,
        manifest
      };
    }
    const buf = fs.readFileSync(bakFile);
    const actualSha = sha256Buffer(buf);
    if (actualSha !== entry.sha256) {
      return {
        hasBackup: false,
        backupValid: false,
        reason: `backup_sha256_mismatch:${name}`,
        manifestPath,
        filesDir,
        manifest
      };
    }
    if (hasLocalizationMarker(name, buf.toString('utf8'))) {
      return {
        hasBackup: false,
        backupValid: false,
        reason: `backup_contains_localized_marker:${name}`,
        manifestPath,
        filesDir,
        manifest
      };
    }
  }

  return {
    hasBackup: true,
    backupValid: true,
    reason: null,
    manifestPath,
    filesDir,
    manifest
  };
}

function isValidSwarmBoardDir(targetDir) {
  try {
    if (!fs.existsSync(targetDir) || !fs.statSync(targetDir).isDirectory()) {
      return false;
    }
    const anchors = ['main.mjs', 'index.html', 'app.js', 'hive.js', 'sidecar.json'];
    return anchors.some((name) => {
      const p = path.join(targetDir, name);
      return fs.existsSync(p) && fs.statSync(p).isFile();
    });
  } catch (_) {
    return false;
  }
}

function verify(options = {}) {
  const targetDir = resolveTargetDir(options);
  const assetDir = resolveAssetDir(options);
  const { backupDir, targetTag, targetBackupDir } = resolveTargetBackupDir(targetDir, options);
  const assets = validateAssets(assetDir);
  const backupInfo = inspectBackup(targetBackupDir);

  const files = {};
  const changedFiles = [];
  const missingFiles = [];
  const driftedFiles = [];
  const upstreamUnlocalizedFiles = [];

  if (!assets.valid) {
    for (const name of MANAGED_FILES) {
      files[name] = {
        path: name,
        state: 'missing',
        sha256: null,
        expectedSha256: null,
        size: null,
        expectedSize: null,
        createdByPatch: CREATED_FILES.includes(name),
        hasMarker: false
      };
      changedFiles.push(name);
    }
    return {
      status: 'assets_invalid',
      targetDir,
      assetDir,
      backupDir,
      targetTag,
      targetBackupDir,
      assetsValid: false,
      assetsError: assets.error,
      files,
      changedFiles,
      missingFiles,
      driftedFiles,
      upstreamUnlocalizedFiles,
      upstreamOverwritten: false,
      needsPatch: false,
      canSync: false,
      hasBackup: backupInfo.hasBackup,
      summary: `打包资源校验失败: ${assets.error}`
    };
  }

  const targetValid = isValidSwarmBoardDir(targetDir);
  if (!targetValid) {
    for (const name of MANAGED_FILES) {
      const entry = assets.entriesByName[name];
      files[name] = {
        path: name,
        state: 'missing',
        sha256: null,
        expectedSha256: entry.sha256,
        size: null,
        expectedSize: entry.size,
        createdByPatch: entry.createdByPatch,
        hasMarker: false
      };
      changedFiles.push(name);
      missingFiles.push(name);
    }
    return {
      status: 'missing',
      targetDir,
      assetDir,
      backupDir,
      targetTag,
      targetBackupDir,
      assetsValid: true,
      assetsError: null,
      files,
      changedFiles,
      missingFiles,
      driftedFiles,
      upstreamUnlocalizedFiles,
      upstreamOverwritten: false,
      needsPatch: false,
      canSync: false,
      hasBackup: backupInfo.hasBackup,
      summary: `未找到有效的 Swarm 面板目录: ${targetDir}`
    };
  }

  for (const name of MANAGED_FILES) {
    const entry = assets.entriesByName[name];
    const filePath = path.join(targetDir, name);
    let state;
    let actualSha = null;
    let actualSize = null;
    let marker = false;

    if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
      state = 'missing';
      missingFiles.push(name);
      changedFiles.push(name);
    } else {
      const buf = fs.readFileSync(filePath);
      actualSha = sha256Buffer(buf);
      actualSize = buf.length;
      marker = hasLocalizationMarker(name, buf.toString('utf8'));
      if (actualSha === entry.sha256) {
        state = 'match';
      } else if (marker) {
        state = 'localized_modified';
        driftedFiles.push(name);
        changedFiles.push(name);
      } else {
        state = 'upstream_unlocalized';
        upstreamUnlocalizedFiles.push(name);
        changedFiles.push(name);
      }
    }

    files[name] = {
      path: name,
      state,
      sha256: actualSha,
      expectedSha256: entry.sha256,
      size: actualSize,
      expectedSize: entry.size,
      createdByPatch: entry.createdByPatch,
      hasMarker: marker
    };
  }

  let status;
  if (changedFiles.length === 0) {
    status = 'patched';
  } else if (
    files['translator.mjs'].state === 'missing' &&
    UPSTREAM_FILES.every((name) => files[name].state === 'upstream_unlocalized')
  ) {
    status = 'unpatched';
  } else if (
    missingFiles.length === 0 &&
    upstreamUnlocalizedFiles.length === 0 &&
    driftedFiles.length >= 1
  ) {
    status = 'drifted';
  } else {
    status = 'partial';
  }

  const upstreamOverwritten =
    status === 'partial' &&
    UPSTREAM_FILES.some((name) => files[name].state === 'upstream_unlocalized');
  const needsPatch = status === 'unpatched' || status === 'drifted' || status === 'partial';
  const canSync =
    missingFiles.length === 0 &&
    MANAGED_FILES.every((name) => files[name].hasMarker === true);

  let summary;
  if (status === 'patched') {
    summary = 'Swarm 面板已完整汉化 (7/7 文件校验通过)';
  } else if (status === 'unpatched') {
    summary = 'Swarm 面板尚未汉化 (6 个上游原版文件待补丁，translator.mjs 未安装)';
  } else if (status === 'drifted') {
    summary = `检测到本地汉化变更/漂移 (${driftedFiles.join(', ')} 与打包版本不一致)`;
  } else if (upstreamOverwritten) {
    summary = `检测到上游更新覆盖 (${upstreamUnlocalizedFiles.join(', ')} 为未汉化版本，需重新注入)`;
  } else {
    summary = `Swarm 面板处于部分汉化状态 (变更/缺失: ${changedFiles.join(', ')})`;
  }

  return {
    status,
    targetDir,
    assetDir,
    backupDir,
    targetTag,
    targetBackupDir,
    assetsValid: true,
    assetsError: null,
    files,
    changedFiles,
    missingFiles,
    driftedFiles,
    upstreamUnlocalizedFiles,
    upstreamOverwritten,
    needsPatch,
    canSync,
    hasBackup: backupInfo.hasBackup,
    summary
  };
}

function loadExistingBackupManifest(targetBackupDir, targetDir, targetTag) {
  const manifestPath = path.join(targetBackupDir, 'backup-manifest.json');
  if (fs.existsSync(manifestPath)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
      if (parsed && parsed.schemaVersion === 1 && parsed.files && typeof parsed.files === 'object') {
        return parsed;
      }
    } catch (_) {}
  }
  return {
    schemaVersion: 1,
    targetDir: realpathOrResolve(targetDir),
    targetTag,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    addedFiles: CREATED_FILES.slice(),
    files: {}
  };
}

function patch(options = {}) {
  const dryRun = Boolean(options.dryRun);
  const force = Boolean(options.force);
  const allowMissing = Boolean(options.allowMissing);

  const report = verify(options);
  if (!report.assetsValid) {
    throw new Error(`Swarm 汉化资源包校验失败，已中止: ${report.assetsError}`);
  }

  if (report.status === 'missing') {
    if (allowMissing) {
      return {
        status: 'skippedMissing',
        skipped: true,
        reason: 'target_missing',
        changed: false,
        updatedFiles: [],
        targetDir: report.targetDir,
        assetDir: report.assetDir,
        backupDir: report.backupDir,
        targetBackupDir: report.targetBackupDir,
        backupCreated: false,
        backupUpdated: false,
        backupSkippedReason: 'target_missing',
        verified: false,
        report
      };
    }
    throw new Error(`未找到有效的 Swarm 面板目录: ${report.targetDir}`);
  }

  if (report.status === 'patched' && !force) {
    return {
      status: 'alreadyPatched',
      changed: false,
      updatedFiles: [],
      targetDir: report.targetDir,
      assetDir: report.assetDir,
      backupDir: report.backupDir,
      targetBackupDir: report.targetBackupDir,
      backupCreated: false,
      backupUpdated: false,
      backupSkippedReason: null,
      verified: true,
      report
    };
  }

  const upstreamToBackup = UPSTREAM_FILES.filter(
    (name) => report.files[name] && report.files[name].state === 'upstream_unlocalized'
  );
  const filesToUpdate = force
    ? MANAGED_FILES.slice()
    : MANAGED_FILES.filter((name) => report.files[name].state !== 'match');

  let backupCreated = false;
  let backupUpdated = false;
  let backupSkippedReason = null;
  const backedUpFiles = [];

  if (upstreamToBackup.length > 0) {
    const manifestPath = path.join(report.targetBackupDir, 'backup-manifest.json');
    const hadManifestBefore = fs.existsSync(manifestPath);
    const existingManifest = hadManifestBefore
      ? loadExistingBackupManifest(report.targetBackupDir, report.targetDir, report.targetTag)
      : null;

    if (dryRun) {
      for (const name of upstreamToBackup) {
        const curSha = report.files[name].sha256;
        const prevEntry = existingManifest && existingManifest.files && existingManifest.files[name];
        const bakFile = path.join(report.targetBackupDir, 'files', name);
        if (!prevEntry || prevEntry.sha256 !== curSha || !fs.existsSync(bakFile)) {
          backedUpFiles.push(name);
        }
      }
      backupCreated = !hadManifestBefore && backedUpFiles.length > 0;
      backupUpdated = hadManifestBefore && backedUpFiles.length > 0;
    } else {
      const filesDir = path.join(report.targetBackupDir, 'files');
      fs.mkdirSync(filesDir, { recursive: true });
      const manifest = existingManifest || loadExistingBackupManifest(report.targetBackupDir, report.targetDir, report.targetTag);
      const now = new Date().toISOString();

      for (const name of upstreamToBackup) {
        const srcFile = path.join(report.targetDir, name);
        const dstFile = path.join(filesDir, name);
        const buf = fs.readFileSync(srcFile);
        const curSha = sha256Buffer(buf);
        const prevEntry = manifest.files[name];
        let needCopy = !prevEntry || prevEntry.sha256 !== curSha || !fs.existsSync(dstFile);
        if (!needCopy) {
          const existingBakSha = sha256Buffer(fs.readFileSync(dstFile));
          if (existingBakSha !== curSha) needCopy = true;
        }
        if (needCopy) {
          writeFileAtomic(dstFile, buf);
          manifest.files[name] = {
            path: name,
            sha256: curSha,
            size: buf.length,
            backedUpAt: now
          };
          backedUpFiles.push(name);
        }
      }

      if (!hadManifestBefore || backedUpFiles.length > 0) {
        manifest.targetDir = realpathOrResolve(report.targetDir);
        manifest.targetTag = report.targetTag;
        manifest.addedFiles = CREATED_FILES.slice();
        manifest.updatedAt = now;
        writeFileAtomic(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
      }
      backupCreated = !hadManifestBefore;
      backupUpdated = hadManifestBefore && backedUpFiles.length > 0;
    }
  } else {
    backupSkippedReason = report.hasBackup ? 'preserved_existing' : 'already_localized';
  }

  if (dryRun) {
    return {
      status: 'dryRun',
      wouldPatch: filesToUpdate.length > 0,
      changed: false,
      plannedUpdates: filesToUpdate,
      backedUpFiles,
      targetDir: report.targetDir,
      assetDir: report.assetDir,
      backupDir: report.backupDir,
      targetBackupDir: report.targetBackupDir,
      backupCreated,
      backupUpdated,
      backupSkippedReason,
      verified: false,
      report
    };
  }

  const sidecarAssetDir = path.join(report.assetDir, 'sidecars', 'swarm_board');
  const rollbackSnapshots = [];
  const updatedFiles = [];

  try {
    for (const name of filesToUpdate) {
      const srcPath = path.join(sidecarAssetDir, name);
      const dstPath = path.join(report.targetDir, name);
      if (fs.existsSync(dstPath)) {
        rollbackSnapshots.push({ dstPath, existed: true, buf: fs.readFileSync(dstPath) });
      } else {
        rollbackSnapshots.push({ dstPath, existed: false, buf: null });
      }
      const srcBuf = fs.readFileSync(srcPath);
      writeFileAtomic(dstPath, srcBuf);
      updatedFiles.push(name);
    }

    const postReport = verify(options);
    if (postReport.status !== 'patched') {
      throw new Error(`补丁后校验未通过 (status=${postReport.status}: ${postReport.summary})`);
    }

    return {
      status: 'patched',
      changed: updatedFiles.length > 0,
      updatedFiles,
      backedUpFiles,
      targetDir: report.targetDir,
      assetDir: report.assetDir,
      backupDir: report.backupDir,
      targetBackupDir: report.targetBackupDir,
      backupCreated,
      backupUpdated,
      backupSkippedReason,
      verified: true,
      report: postReport
    };
  } catch (err) {
    for (let i = rollbackSnapshots.length - 1; i >= 0; i--) {
      const snap = rollbackSnapshots[i];
      try {
        if (snap.existed) {
          writeFileAtomic(snap.dstPath, snap.buf);
        } else if (fs.existsSync(snap.dstPath)) {
          fs.rmSync(snap.dstPath, { force: true });
        }
      } catch (_) {}
    }
    throw err;
  }
}

function checkJsSyntax(filePath) {
  const res = spawnSync(process.execPath, ['--check', filePath], {
    encoding: 'utf8',
    windowsHide: true
  });
  if (res.status !== 0) {
    const detail = (res.stderr || res.stdout || '').trim() || `exit ${res.status}`;
    throw new Error(`语法校验失败 (${path.basename(filePath)}): ${detail}`);
  }
}

function sync(options = {}) {
  const dryRun = Boolean(options.dryRun);
  const targetDir = resolveTargetDir(options);
  const assetDir = resolveAssetDir(options);
  const sidecarAssetDir = path.join(assetDir, 'sidecars', 'swarm_board');
  const manifestPath = path.join(assetDir, 'manifest.json');

  if (!isValidSwarmBoardDir(targetDir)) {
    throw new Error(`无法同步: 未找到有效的 Swarm 面板目录 (${targetDir})`);
  }

  const missing = [];
  for (const name of MANAGED_FILES) {
    const p = path.join(targetDir, name);
    if (!fs.existsSync(p) || !fs.statSync(p).isFile()) {
      missing.push(name);
    }
  }
  if (missing.length > 0) {
    throw new Error(`无法同步: 目标目录缺少受管文件: ${missing.join(', ')}`);
  }

  const unlocalized = [];
  const fileData = {};
  for (const name of MANAGED_FILES) {
    const p = path.join(targetDir, name);
    const buf = fs.readFileSync(p);
    const content = buf.toString('utf8');
    if (!hasLocalizationMarker(name, content)) {
      unlocalized.push(name);
    }
    fileData[name] = {
      path: p,
      buf,
      sha256: sha256Buffer(buf),
      size: buf.length,
      createdByPatch: CREATED_FILES.includes(name)
    };
  }

  if (unlocalized.length > 0) {
    throw new Error(
      `拒绝同步: 以下文件缺少汉化标记 (${unlocalized.join(', ')})，可能已被官方更新覆盖为英文原版；请先运行 patch-swarm 重新注入`
    );
  }

  for (const scriptName of SCRIPT_FILES) {
    checkJsSyntax(fileData[scriptName].path);
  }

  const updatedFiles = [];
  const unchangedFiles = [];
  const newManifestEntries = [];

  for (const name of MANAGED_FILES) {
    const info = fileData[name];
    const dstPath = path.join(sidecarAssetDir, name);
    let differs = true;
    if (fs.existsSync(dstPath) && fs.statSync(dstPath).isFile()) {
      const existingBuf = fs.readFileSync(dstPath);
      if (existingBuf.equals(info.buf)) {
        differs = false;
      }
    }
    if (differs) {
      updatedFiles.push(name);
    } else {
      unchangedFiles.push(name);
    }
    newManifestEntries.push({
      path: name,
      sha256: info.sha256,
      size: info.size,
      createdByPatch: info.createdByPatch
    });
  }

  let manifestDiffers = true;
  if (fs.existsSync(manifestPath)) {
    try {
      const oldManifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
      if (
        oldManifest &&
        oldManifest.schemaVersion === 1 &&
        Array.isArray(oldManifest.files) &&
        oldManifest.files.length === newManifestEntries.length &&
        newManifestEntries.every((n, i) => {
          const o = oldManifest.files[i];
          return o && o.path === n.path && o.sha256 === n.sha256 && o.size === n.size && o.createdByPatch === n.createdByPatch;
        })
      ) {
        manifestDiffers = false;
      }
    } catch (_) {}
  }

  const manifest = {
    schemaVersion: 1,
    plugin: 'swarm',
    sidecar: 'swarm_board',
    generatedAt: new Date().toISOString(),
    files: newManifestEntries
  };

  if (dryRun) {
    return {
      status: 'dryRun',
      targetDir,
      assetDir,
      manifestPath,
      updatedFiles,
      unchangedFiles,
      manifestDiffers,
      manifest
    };
  }

  if (updatedFiles.length === 0 && !manifestDiffers) {
    return {
      status: 'upToDate',
      targetDir,
      assetDir,
      manifestPath,
      updatedFiles,
      unchangedFiles,
      manifest
    };
  }

  fs.mkdirSync(sidecarAssetDir, { recursive: true });
  for (const name of updatedFiles) {
    writeFileAtomic(path.join(sidecarAssetDir, name), fileData[name].buf);
  }
  writeFileAtomic(manifestPath, JSON.stringify(manifest, null, 2) + '\n');

  return {
    status: 'synced',
    targetDir,
    assetDir,
    manifestPath,
    updatedFiles,
    unchangedFiles,
    manifest
  };
}

function restore(options = {}) {
  const dryRun = Boolean(options.dryRun);
  const targetDir = resolveTargetDir(options);
  const { backupDir, targetTag, targetBackupDir } = resolveTargetBackupDir(targetDir, options);

  if (!isValidSwarmBoardDir(targetDir)) {
    throw new Error(`无法恢复: 未找到有效的 Swarm 面板目录 (${targetDir})`);
  }

  const backupInfo = inspectBackup(targetBackupDir);
  if (!backupInfo.backupValid) {
    throw new Error(
      `无法恢复原版 swarm_board (${backupInfo.reason}): 未找到完整且未汉化的上游备份 (${backupInfo.manifestPath})，已中止且未修改目标文件`
    );
  }

  const translatorPath = path.join(targetDir, 'translator.mjs');
  const filesToRemove = fs.existsSync(translatorPath) ? ['translator.mjs'] : [];

  if (dryRun) {
    return {
      status: 'dryRun',
      targetDir,
      backupDir,
      targetTag,
      targetBackupDir,
      restoredFiles: UPSTREAM_FILES.slice(),
      removedFiles: filesToRemove
    };
  }

  const rollbackSnapshots = [];
  try {
    for (const name of UPSTREAM_FILES) {
      const dstPath = path.join(targetDir, name);
      const srcPath = path.join(backupInfo.filesDir, name);
      if (fs.existsSync(dstPath)) {
        rollbackSnapshots.push({ dstPath, existed: true, buf: fs.readFileSync(dstPath) });
      } else {
        rollbackSnapshots.push({ dstPath, existed: false, buf: null });
      }
      const bakBuf = fs.readFileSync(srcPath);
      writeFileAtomic(dstPath, bakBuf);
    }

    for (const name of UPSTREAM_FILES) {
      const dstPath = path.join(targetDir, name);
      const actualSha = sha256Buffer(fs.readFileSync(dstPath));
      const expectedSha = backupInfo.manifest.files[name].sha256;
      if (actualSha !== expectedSha) {
        throw new Error(`恢复后校验失败 (${name}): 预期 ${expectedSha}，实际 ${actualSha}`);
      }
    }
  } catch (err) {
    for (let i = rollbackSnapshots.length - 1; i >= 0; i--) {
      const snap = rollbackSnapshots[i];
      try {
        if (snap.existed) {
          writeFileAtomic(snap.dstPath, snap.buf);
        } else if (fs.existsSync(snap.dstPath)) {
          fs.rmSync(snap.dstPath, { force: true });
        }
      } catch (_) {}
    }
    throw err;
  }

  const removedFiles = [];
  if (fs.existsSync(translatorPath)) {
    fs.rmSync(translatorPath, { force: true });
    removedFiles.push('translator.mjs');
  }

  return {
    status: 'restored',
    targetDir,
    backupDir,
    targetTag,
    targetBackupDir,
    restoredFiles: UPSTREAM_FILES.slice(),
    removedFiles
  };
}

function printCliHelp() {
  console.log([
    '用法: node core/swarm-zh-patch.cjs <命令> [选项]',
    '',
    '命令:',
    '  verify    检查 Swarm 面板汉化状态 (默认)',
    '  patch     应用/重新注入 Swarm 面板汉化文件',
    '  sync      从目标 Swarm 面板目录同步已修改的汉化文件回仓库包',
    '  restore   从外部备份恢复原版 Swarm 面板文件并移除 translator.mjs',
    '',
    '选项:',
    '  --target, --swarm-dir <dir>  指定 swarm_board 目录',
    '  --backup-dir <dir>           指定外部备份目录',
    '  --asset-dir <dir>            指定打包资源目录 (plugins/swarm-zh)',
    '  --dry-run, --check           仅预览操作，不写入磁盘',
    '  --force                      强制覆盖写入',
    '  --json                       以 JSON 格式输出结果',
    '  -h, --help                   显示此帮助信息'
  ].join('\n'));
}

function parseCliArgs(argv) {
  const opts = {
    cmd: null,
    targetDir: null,
    backupDir: null,
    assetDir: null,
    dryRun: false,
    force: false,
    json: false,
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
    } else if (a === '--target' || a === '--swarm-dir') {
      opts.targetDir = requireValue(a, i);
      i++;
    } else if (a === '--backup-dir') {
      opts.backupDir = requireValue(a, i);
      i++;
    } else if (a === '--asset-dir') {
      opts.assetDir = requireValue(a, i);
      i++;
    } else if (a === '--dry-run' || a === '--check') {
      opts.dryRun = true;
    } else if (a === '--force') {
      opts.force = true;
    } else if (a === '--json') {
      opts.json = true;
    } else if (a.startsWith('-')) {
      throw new Error(`未知参数: ${a}`);
    } else if (!opts.cmd) {
      opts.cmd = a;
    } else {
      throw new Error(`多余的参数: ${a}`);
    }
  }
  opts.cmd = opts.cmd || 'verify';
  return opts;
}

function getVerifyExitCode(report) {
  if (!report || !report.assetsValid || report.status === 'missing' || report.status === 'assets_invalid') {
    return 1;
  }
  if (report.status === 'patched') {
    return 0;
  }
  return 2;
}

if (require.main === module) {
  let opts;
  try {
    opts = parseCliArgs(process.argv.slice(2));
  } catch (err) {
    console.error(`[ERR] ${err.message}`);
    process.exit(1);
  }
  if (opts.help || opts.cmd === 'help') {
    printCliHelp();
    process.exit(0);
  }

  const callOpts = {
    targetDir: opts.targetDir || undefined,
    backupDir: opts.backupDir || undefined,
    assetDir: opts.assetDir || undefined,
    dryRun: opts.dryRun,
    force: opts.force
  };

  try {
    if (opts.cmd === 'verify') {
      const res = verify(callOpts);
      if (opts.json) {
        console.log(JSON.stringify(res, null, 2));
      } else {
        console.log(`[${res.status.toUpperCase()}] ${res.summary}`);
        console.log(`  目标目录: ${res.targetDir}`);
      }
      process.exit(getVerifyExitCode(res));
    } else if (opts.cmd === 'patch') {
      const res = patch(callOpts);
      if (opts.json) {
        console.log(JSON.stringify(res, null, 2));
      } else {
        console.log(`[OK] patch (${res.status}): ${res.targetDir}`);
      }
    } else if (opts.cmd === 'sync') {
      const res = sync(callOpts);
      if (opts.json) {
        console.log(JSON.stringify(res, null, 2));
      } else {
        console.log(`[OK] sync (${res.status}): 更新 ${res.updatedFiles.length} 个文件`);
      }
    } else if (opts.cmd === 'restore') {
      const res = restore(callOpts);
      if (opts.json) {
        console.log(JSON.stringify(res, null, 2));
      } else {
        console.log(`[OK] restore (${res.status}): ${res.targetDir}`);
      }
    } else {
      console.error(`[ERR] 未知命令: ${opts.cmd}`);
      process.exit(1);
    }
  } catch (err) {
    if (opts.json) {
      console.log(JSON.stringify({ status: 'error', error: err.message }, null, 2));
    } else {
      console.error(`[ERR] ${err.message}`);
    }
    process.exit(1);
  }
}

module.exports = {
  MANAGED_FILES,
  UPSTREAM_FILES,
  CREATED_FILES,
  SCRIPT_FILES,
  PRODUCT_DIRS,
  sha256Buffer,
  normcase,
  realpathOrResolve,
  computeTargetTag,
  resolveTargetDir,
  resolveBackupDir,
  resolveAssetDir,
  resolveTargetBackupDir,
  hasLocalizationMarker,
  validateAssets,
  inspectBackup,
  verify,
  patch,
  sync,
  restore,
  getVerifyExitCode
};
