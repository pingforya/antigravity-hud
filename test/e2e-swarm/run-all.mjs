import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const TEST_FILES = [
  'harness-selfcheck.test.mjs',
  'tier1-features.test.mjs',
  'tier2-boundaries.test.mjs',
  'tier3-pairwise.test.mjs',
  'tier4-scenarios.test.mjs',
  'tier5-adversarial.test.mjs',
];

function runFile(filePath) {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(process.execPath, ['--test', filePath], {
      stdio: 'inherit',
    });
    child.on('exit', (code, signal) => {
      resolve({
        file: path.basename(filePath),
        code: code ?? 1,
        signal: signal || null,
        durationMs: Date.now() - started,
      });
    });
  });
}

async function main() {
  const args = process.argv.slice(2);
  const selected = args.length
    ? TEST_FILES.filter((f) => args.some((a) => f.includes(a)))
    : TEST_FILES;

  const results = [];
  for (const file of selected) {
    console.log(`\n=== Running ${file} ===`);
    const res = await runFile(path.join(__dirname, file));
    results.push(res);
  }

  console.log('\n=== E2E Swarm Suite Summary ===');
  let failed = 0;
  for (const r of results) {
    const status = r.code === 0 ? 'PASS' : 'FAIL';
    if (r.code !== 0) failed++;
    console.log(`  [${status}] ${r.file} (${(r.durationMs / 1000).toFixed(2)}s, exit=${r.code})`);
  }

  process.exitCode = failed > 0 ? 1 : 0;
}

main();
