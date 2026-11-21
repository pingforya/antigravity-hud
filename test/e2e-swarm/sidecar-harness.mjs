import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const DEFAULT_SIDECAR_DIR = path.join(os.homedir(), '.gemini', 'antigravity', 'builtin', 'plugins', 'swarm', 'sidecars', 'swarm_board');
export const DEFAULT_REGISTER_LOADER = path.join(os.homedir(), '.gemini', 'antigravity', 'lib', 'node_modules', 'sidecar_sdk', 'register_loader.js');

function killProcessTree(proc) {
  if (!proc || proc.exitCode !== null) return;
  try {
    proc.kill();
  } catch {
    // ignore
  }
  if (process.platform === 'win32' && proc.pid) {
    try {
      execFileSync('taskkill', ['/PID', String(proc.pid), '/T', '/F'], { stdio: 'ignore' });
    } catch {
      // ignore
    }
  }
}

export class SidecarHarness {
  #tmpRoot;
  #appDataDir;
  #brainDir;
  #sidecarDataDir;
  #sidecarSourceDir;
  #sidecarCopyDir = null;
  #mockCliDir = null;
  #proc = null;
  #port = null;
  #defaultConvId;
  #envOverrides;
  #useTempSidecarCopy;
  #stdoutLogs = [];
  #stderrLogs = [];

  constructor({
    conversationId = '11111111-1111-4111-8111-111111111111',
    sidecarDir = process.env.SWARM_E2E_SIDECAR_DIR || DEFAULT_SIDECAR_DIR,
    useTempSidecarCopy = false,
    env = {},
    overview = true,
    graphTab = true,
    rawTab = true,
  } = {}) {
    this.#tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-e2e-sidecar-'));
    this.#appDataDir = path.join(this.#tmpRoot, 'appdata');
    this.#brainDir = path.join(this.#appDataDir, 'brain');
    this.#sidecarDataDir = path.join(this.#appDataDir, 'sidecar_data', 'swarm', 'swarm_board', 'data');
    fs.mkdirSync(this.#brainDir, { recursive: true });
    fs.mkdirSync(this.#sidecarDataDir, { recursive: true });

    this.#sidecarSourceDir = sidecarDir;
    this.#useTempSidecarCopy = useTempSidecarCopy;
    this.#defaultConvId = conversationId;
    this.#envOverrides = {
      SWARM_OVERVIEW: overview ? 'true' : 'false',
      SWARM_GRAPH_TAB: graphTab ? 'true' : 'false',
      SWARM_RAW_TAB: rawTab ? 'true' : 'false',
      ...env,
    };
  }

  get tmpRoot() { return this.#tmpRoot; }
  get appDataDir() { return this.#appDataDir; }
  get brainDir() { return this.#brainDir; }
  get sidecarDataDir() { return this.#sidecarDataDir; }
  get port() { return this.#port; }
  get baseUrl() { return `http://127.0.0.1:${this.#port}`; }
  get conversationId() { return this.#defaultConvId; }
  get stdoutLogs() { return this.#stdoutLogs.join(''); }
  get stderrLogs() { return this.#stderrLogs.join(''); }

  /**
   * Prepares a temp copy of swarm_board/ with remote_board.json and a cross-platform
   * Node-based mock CLI named `swarm` placed in an isolated cwd directory.
   */
  configureRemoteBoard({ backend = 'mock-remote', label = 'Fleet', scriptBody } = {}) {
    if (!this.#sidecarCopyDir) {
      this.#sidecarCopyDir = path.join(this.#tmpRoot, 'swarm_board_copy');
      fs.cpSync(this.#sidecarSourceDir, this.#sidecarCopyDir, { recursive: true });
    }
    this.#mockCliDir = path.join(this.#tmpRoot, 'mock_cli_cwd');
    fs.mkdirSync(this.#mockCliDir, { recursive: true });
    fs.writeFileSync(
      path.join(this.#mockCliDir, 'swarm'),
      scriptBody,
      'utf-8'
    );
    fs.writeFileSync(
      path.join(this.#sidecarCopyDir, 'remote_board.json'),
      JSON.stringify({ backend, label, cli: ['mock-cli'], cli_env: 'MOCK_REMOTE_CLI' }, null, 2),
      'utf-8'
    );
    this.#useTempSidecarCopy = true;
    this.#envOverrides.MOCK_REMOTE_CLI = process.execPath;
  }

  swarmDir(convId = this.#defaultConvId) {
    return path.join(this.#brainDir, convId, '.system_generated', 'swarm');
  }

  transcriptPath(convId) {
    return path.join(this.#brainDir, convId, '.system_generated', 'logs', 'transcript.jsonl');
  }

  ensureSwarmDir(convId = this.#defaultConvId) {
    const dir = this.swarmDir(convId);
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  }

  writeSwarmFiles(convId = this.#defaultConvId, {
    swarmJson = null,
    membersJson = null,
    boardLines = null,
    viewJson = null,
    viewHtml = null,
    planJson = null,
  } = {}) {
    const dir = this.ensureSwarmDir(convId);
    if (swarmJson !== null) {
      fs.writeFileSync(
        path.join(dir, 'swarm.json'),
        typeof swarmJson === 'string' ? swarmJson : JSON.stringify(swarmJson, null, 2),
        'utf-8'
      );
    }
    if (membersJson !== null) {
      fs.writeFileSync(
        path.join(dir, 'members.json'),
        typeof membersJson === 'string' ? membersJson : JSON.stringify(membersJson, null, 2),
        'utf-8'
      );
    }
    if (boardLines !== null) {
      const content = Array.isArray(boardLines)
        ? boardLines.map((l) => (typeof l === 'string' ? l : JSON.stringify(l))).join('\n') + (boardLines.length ? '\n' : '')
        : String(boardLines);
      fs.writeFileSync(path.join(dir, 'board.jsonl'), content, 'utf-8');
    }
    if (viewJson !== null) {
      this.writeViewJson(convId, viewJson);
    }
    if (viewHtml !== null) {
      this.writeViewHtml(convId, viewHtml);
    }
    if (planJson !== null) {
      this.writePlanJson(convId, planJson);
    }
    return dir;
  }

  appendBoardLine(convId = this.#defaultConvId, obj) {
    const dir = this.ensureSwarmDir(convId);
    const boardPath = path.join(dir, 'board.jsonl');
    const line = typeof obj === 'string' ? obj : JSON.stringify(obj);
    fs.appendFileSync(boardPath, line + '\n', 'utf-8');
  }

  writeViewJson(convId = this.#defaultConvId, objOrStr) {
    const dir = this.ensureSwarmDir(convId);
    const text = typeof objOrStr === 'string' ? objOrStr : JSON.stringify(objOrStr, null, 2);
    fs.writeFileSync(path.join(dir, 'view.json'), text, 'utf-8');
  }

  writeViewHtml(convId = this.#defaultConvId, html) {
    const dir = this.ensureSwarmDir(convId);
    fs.writeFileSync(path.join(dir, 'view.html'), html, 'utf-8');
  }

  writePlanJson(convId = this.#defaultConvId, objOrStr) {
    const dir = this.ensureSwarmDir(convId);
    const text = typeof objOrStr === 'string' ? objOrStr : JSON.stringify(objOrStr, null, 2);
    fs.writeFileSync(path.join(dir, 'plan.json'), text, 'utf-8');
  }

  writeTranscript(memberConvId, steps, { mtimeMs = null } = {}) {
    const trPath = this.transcriptPath(memberConvId);
    fs.mkdirSync(path.dirname(trPath), { recursive: true });
    const content = Array.isArray(steps)
      ? steps.map((s) => (typeof s === 'string' ? s : JSON.stringify(s))).join('\n') + (steps.length ? '\n' : '')
      : String(steps);
    fs.writeFileSync(trPath, content, 'utf-8');
    if (Number.isFinite(mtimeMs)) {
      const sec = mtimeMs / 1000;
      fs.utimesSync(trPath, sec, sec);
    }
    return trPath;
  }

  /**
   * Writes a PNG file inside this swarm's temp brain dir and returns a POSIX path
   * relative to the temp root's drive root (for Windows canonicalFile + SHOT_RE compatibility).
   */
  writeScreenshot(convId = this.#defaultConvId, filename, buffer) {
    const dir = this.ensureSwarmDir(convId);
    const absPath = path.join(dir, filename);
    fs.writeFileSync(absPath, buffer);
    const driveRoot = path.parse(absPath).root;
    const rel = path.relative(driveRoot, absPath).split(path.sep).join('/');
    return { absPath, posixPath: `/${rel}` };
  }

  async start() {
    if (this.#proc) return;
    if (this.#useTempSidecarCopy && !this.#sidecarCopyDir) {
      this.#sidecarCopyDir = path.join(this.#tmpRoot, 'swarm_board_copy');
      fs.cpSync(this.#sidecarSourceDir, this.#sidecarCopyDir, { recursive: true });
    }
    const targetDir = this.#useTempSidecarCopy ? this.#sidecarCopyDir : this.#sidecarSourceDir;
    const mainMjs = path.join(targetDir, 'main.mjs');
    const loaderUrl = pathToFileURL(DEFAULT_REGISTER_LOADER).href;

    // On Windows, cwd = drive root of tmpRoot allows canonicalFile() to resolve
    // drive-less POSIX paths `/Users/.../shot.png` for /api/frame.
    // For remote_board mock CLI, cwd = mockCliDir so `node swarm` resolves `swarm`.
    const cwd = this.#mockCliDir || path.parse(this.#tmpRoot).root;

    const env = {
      ...process.env,
      ANTIGRAVITY_EXECUTABLE_DATA_DIR: this.#sidecarDataDir,
      ANTIGRAVITY_SIDECAR_WEB_PORT: '0',
      ANTIGRAVITY_LS_ADDRESS: '127.0.0.1:1',
      ANTIGRAVITY_CSRF_TOKEN: 'test',
      ANTIGRAVITY_CONVERSATION_ID: this.#defaultConvId,
      ANTIGRAVITY_AGENTAPI_EXE: path.join(this.#tmpRoot, 'nonexistent-agentapi.exe'),
      ...this.#envOverrides,
    };

    try {
      this.#proc = spawn(process.execPath, ['--import', loaderUrl, mainMjs], {
        cwd,
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      this.#proc.stdout.setEncoding('utf-8');
      this.#proc.stderr.setEncoding('utf-8');

      this.#port = await new Promise((resolve, reject) => {
        let settled = false;
        let timer = null;
        const onStderr = (c) => this.#stderrLogs.push(c);
        const onStdoutLater = (c) => this.#stdoutLogs.push(c);
        const cleanupStartup = () => {
          clearTimeout(timer);
          this.#proc?.stdout?.off('data', onStdout);
          this.#proc?.off('exit', onExit);
          this.#proc?.off('error', onError);
        };
        const onError = (err) => {
          if (settled) return;
          settled = true;
          cleanupStartup();
          reject(new Error(`Sidecar spawn error: ${err?.message || err}. stdout=${this.stdoutLogs} stderr=${this.stderrLogs}`));
        };
        const onStdout = (chunk) => {
          this.#stdoutLogs.push(chunk);
          const joined = this.stdoutLogs;
          const m = joined.match(/\[sidecar\] listening on 127\.0\.0\.1:(\d+)/);
          if (m && !settled) {
            settled = true;
            cleanupStartup();
            this.#proc.stdout.on('data', onStdoutLater);
            resolve(Number(m[1]));
          }
        };
        const onExit = (code, sig) => {
          if (settled) return;
          settled = true;
          cleanupStartup();
          reject(new Error(`Sidecar exited early (${code}/${sig}). stdout=${this.stdoutLogs} stderr=${this.stderrLogs}`));
        };
        timer = setTimeout(() => {
          if (settled) return;
          settled = true;
          cleanupStartup();
          reject(new Error(`Sidecar startup timeout. stdout=${this.stdoutLogs} stderr=${this.stderrLogs}`));
        }, 15000);
        this.#proc.once('error', onError);
        this.#proc.stdout.on('data', onStdout);
        this.#proc.stderr.on('data', onStderr);
        this.#proc.once('exit', onExit);
      });
    } catch (err) {
      killProcessTree(this.#proc);
      this.#proc = null;
      this.#port = null;
      throw err;
    }
  }

  async getSwarm(params = {}) {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== null) qs.set(k, String(v));
    }
    const query = qs.toString();
    const res = await fetch(`${this.baseUrl}/api/swarm${query ? `?${query}` : ''}`);
    if (!res.ok) throw new Error(`/api/swarm HTTP ${res.status}`);
    return res.json();
  }

  async getFrame(params = {}) {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== null) qs.set(k, String(v));
    }
    return fetch(`${this.baseUrl}/api/frame?${qs.toString()}`);
  }

  /**
   * Polls /api/swarm until predicate(snap) returns truthy, returning the snapshot.
   */
  async waitForSwarm(predicate, { params = {}, timeout = 8000, interval = 80 } = {}) {
    const deadline = Date.now() + timeout;
    let lastSnap = null;
    while (Date.now() < deadline) {
      lastSnap = await this.getSwarm(params);
      if (predicate(lastSnap)) return lastSnap;
      await new Promise((r) => setTimeout(r, interval));
    }
    throw new Error(`waitForSwarm timed out after ${timeout}ms. Last snap keys: ${lastSnap ? Object.keys(lastSnap).join(',') : 'null'}`);
  }

  async stop({ cleanup = true } = {}) {
    if (this.#proc && this.#proc.exitCode === null) {
      try {
        this.#proc.kill();
      } catch {
        // ignore
      }
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, 1500);
        this.#proc.once('exit', () => {
          clearTimeout(timer);
          resolve();
        });
      });
      killProcessTree(this.#proc);
    }
    this.#proc = null;
    if (cleanup && this.#tmpRoot) {
      const dir = this.#tmpRoot;
      try {
        fs.rmSync(dir, { recursive: true, force: true, maxRetries: 15, retryDelay: 100 });
      } finally {
        if (!fs.existsSync(dir)) {
          this.#tmpRoot = null;
        }
      }
      if (fs.existsSync(dir)) {
        throw new Error(`Failed to remove SidecarHarness temp directory after retries: ${dir}`);
      }
    }
  }
}
