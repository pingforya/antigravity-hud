'use strict';

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { pathToFileURL } = require('node:url');

const BUILTIN_SWARM_BOARD = path.join(os.homedir(), '.gemini', 'antigravity', 'builtin', 'plugins', 'swarm', 'sidecars', 'swarm_board');
const TRANSLATOR_MJS_PATH = path.join(BUILTIN_SWARM_BOARD, 'translator.mjs');
const MAIN_MJS_PATH = path.join(BUILTIN_SWARM_BOARD, 'main.mjs');
const SIDECAR_REGISTER_LOADER = path.join(os.homedir(), '.gemini', 'antigravity', 'lib', 'node_modules', 'sidecar_sdk', 'register_loader.js');

let mod;

before(async () => {
  mod = await import(pathToFileURL(TRANSLATOR_MJS_PATH).href);
});

function sha256File(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function startHttpServer(handler) {
  return new Promise((resolve, reject) => {
    const server = http.createServer(handler);
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      resolve({
        server,
        url: `http://127.0.0.1:${addr.port}`,
        close: () =>
          new Promise((res) => {
            server.closeAllConnections?.();
            server.close(() => res());
          }),
      });
    });
  });
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.setEncoding('utf-8');
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      try { resolve(raw ? JSON.parse(raw) : {}); }
      catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

async function waitFor(fn, timeoutMs = 4000, stepMs = 25) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const res = await fn();
    if (res) return res;
    await new Promise((r) => setTimeout(r, stepMs));
  }
  throw new Error(`waitFor timed out after ${timeoutMs}ms`);
}

// ---------------------------------------------------------------------------
// Group 1: F1 Placeholder Masking, Restoration, CJK & Bare-Token Detection
// ---------------------------------------------------------------------------

describe('F1: maskTechnicalLiterals, unmaskTechnicalLiterals & isPredominantlyChinese', () => {
  test('masks Windows path with embedded UUID as a single token before UUIDs', () => {
    const input = 'Check C:\\Users\\alice\\.gemini\\antigravity\\brain\\56f8c44e-ba95-43c2-94d3-41b7a3b39a07\\scratch\\scanner\\ and UUID 11111111-2222-4333-8444-555555555555.';
    const { masked, tokens } = mod.maskTechnicalLiterals(input);
    assert.equal(tokens.length, 2);
    assert.equal(tokens[0], 'C:\\Users\\alice\\.gemini\\antigravity\\brain\\56f8c44e-ba95-43c2-94d3-41b7a3b39a07\\scratch\\scanner\\');
    assert.equal(tokens[1], '11111111-2222-4333-8444-555555555555');
    assert.equal(masked, 'Check ⟦P0⟧ and UUID ⟦P1⟧.');
    const restored = mod.unmaskTechnicalLiterals('请检查 ⟦P0⟧ 和 UUID ⟦P1⟧。', tokens);
    assert.equal(restored.intact, true);
    assert.equal(restored.text, '请检查 C:\\Users\\alice\\.gemini\\antigravity\\brain\\56f8c44e-ba95-43c2-94d3-41b7a3b39a07\\scratch\\scanner\\ 和 UUID 11111111-2222-4333-8444-555555555555。');
  });

  test('masks pre-existing sentinel, fenced code (closed + unclosed), and inline code atomically', () => {
    const input = [
      'Sentinel ⟦P0⟧ and `inline @alice #12 C:\\a\\b` here.',
      '```js',
      'const cost = "$$ $1 $&"; // @bob #99',
      '```',
      '```txt',
      'unclosed fence at EOF @carol',
    ].join('\n');
    const { masked, tokens } = mod.maskTechnicalLiterals(input);
    assert.equal(tokens[0], '⟦P0⟧');
    assert.ok(tokens.some((t) => t.includes('const cost = "$$ $1 $&";')));
    assert.ok(tokens.some((t) => t.includes('unclosed fence at EOF @carol')));
    assert.ok(tokens.some((t) => t === '`inline @alice #12 C:\\a\\b`'));
    assert.ok(!masked.includes('@alice'));
    assert.ok(!masked.includes('@bob'));
    assert.ok(!masked.includes('@carol'));

    const restored = mod.unmaskTechnicalLiterals(masked, tokens);
    assert.equal(restored.intact, true);
    assert.equal(restored.text, input);
  });

  test('masks URLs with balanced-paren trailing punctuation trimming', () => {
    const input = 'See (https://en.wikipedia.org/wiki/Foo_(bar).) and customization://swarm_board/app.js!';
    const { masked, tokens } = mod.maskTechnicalLiterals(input);
    assert.equal(tokens[0], 'https://en.wikipedia.org/wiki/Foo_(bar)');
    assert.equal(tokens[1], 'customization://swarm_board/app.js');
    assert.equal(masked, 'See (⟦P0⟧.) and ⟦P1⟧!');
  });

  test('masks POSIX paths and bare filenames while NOT false-matching PASS/FAIL, 14/14, e.g., v1.2', () => {
    const input = 'Hit /api/swarm and src/api.rs:40 and app.js:12; PASS/FAIL 14/14 e.g. v1.2 read/write.';
    const { masked, tokens } = mod.maskTechnicalLiterals(input);
    assert.deepEqual(tokens, ['/api/swarm', 'src/api.rs:40', 'app.js:12']);
    assert.ok(masked.includes('PASS/FAIL 14/14 e.g. v1.2 read/write.'));
  });

  test('masks @#channel, @mentions, and #<seq> while skipping email addresses and HTML entities', () => {
    const input = 'Ping @#ops-1 and @parser on #13 (not user@example.com, &#39;, /#12, #0, #1a2b).';
    const { masked, tokens } = mod.maskTechnicalLiterals(input);
    assert.deepEqual(tokens, ['@#ops-1', '@parser', '#13']);
    assert.ok(masked.includes('user@example.com'));
    assert.ok(masked.includes('&#39;'));
    assert.ok(masked.includes('/#12'));
    assert.ok(masked.includes('#0'));
    assert.ok(masked.includes('#1a2b'));
  });

  test('unmaskTechnicalLiterals repairs CJK boundaries for @mention/#seq, fenced newlines, $$ patterns, and detects corruption', () => {
    const { tokens } = mod.maskTechnicalLiterals('@parser fixed #13 and #14 in\n```js\nconst a = "$$1";\n```');
    // Masking order: fenced block is P0, @parser is P1, #13 is P2, #14 is P3.
    // LLM drops spaces around placeholders, puts fenced code inline, and has whitespace drift inside ⟦ p 1 ⟧
    const llmOut = '请看⟦ p 1 ⟧修复了⟦P2⟧和⟦P3⟧，代码：⟦P0⟧完成。';
    const res = mod.unmaskTechnicalLiterals(llmOut, tokens);
    assert.equal(res.intact, true);
    assert.ok(res.text.includes('请看 @parser 修复了 #13 和 #14，'));
    assert.ok(res.text.includes('\n```js\nconst a = "$$1";\n```\n完成。'));

    // Verify app.js-style regexes still match restored @parser, #13, #14
    const MENTION_RE = /(^|[^\p{L}\p{N}_-])@([\p{L}\p{N}_-]+)/gu;
    const CITATION_RE = /(^|[^\p{L}\p{N}_&#/-])#([1-9]\d{0,8})(?![\p{L}\p{N}_-])/gu;
    assert.equal([...res.text.matchAll(MENTION_RE)].map((m) => m[2]).includes('parser'), true);
    assert.deepEqual([...res.text.matchAll(CITATION_RE)].map((m) => m[2]), ['13', '14']);

    // Corruption detection: missing, duplicate, out-of-range
    assert.equal(mod.unmaskTechnicalLiterals('少了占位符', tokens).intact, false);
    assert.equal(mod.unmaskTechnicalLiterals('⟦P0⟧ ⟦P0⟧ ⟦P1⟧ ⟦P2⟧ ⟦P3⟧', tokens).intact, false);
    assert.equal(mod.unmaskTechnicalLiterals('⟦P0⟧ ⟦P1⟧ ⟦P2⟧ ⟦P3⟧ ⟦P99⟧', tokens).intact, false);
  });

  test('isPredominantlyChinese handles mixed CJK, technical tokens, and English-heavy strings', () => {
    assert.equal(mod.isPredominantlyChinese('225 条反重力聊天来源与构成调查'), true);
    assert.equal(mod.isPredominantlyChinese('agy-control: 一键开关 MCP / 插件 / Skill 独立侧边栏插件'), true);
    assert.equal(mod.isPredominantlyChinese('[已完成] 前端体验重做，详见 `app.js` #20'), true);
    assert.equal(mod.isPredominantlyChinese('修复 bug'), true);

    assert.equal(mod.isPredominantlyChinese('Investigate 压缩'), false);
    assert.equal(mod.isPredominantlyChinese('Fix the 中文 bug'), false);
    assert.equal(mod.isPredominantlyChinese('@coordinator [done] Finished parsing `board.jsonl`'), false);
  });

  test('protects literal ⟦Pn⟧ inside inline code, fenced code, nested cross-delimiter fences, and double-backtick inline code', () => {
    // 1. Literal ⟦P0⟧ / ⟦P1⟧ inside inline code
    const inlineSent = 'Never alter `⟦P0⟧` or `⟦P1⟧` placeholders.';
    const m1 = mod.maskTechnicalLiterals(inlineSent);
    assert.deepEqual(m1.tokens, ['`⟦P0⟧`', '`⟦P1⟧`']);
    assert.equal(m1.masked, 'Never alter ⟦P0⟧ or ⟦P1⟧ placeholders.');
    const r1 = mod.unmaskTechnicalLiterals('切勿修改 ⟦P0⟧ 或 ⟦P1⟧ 占位符。', m1.tokens);
    assert.equal(r1.intact, true);
    assert.equal(r1.text, '切勿修改 `⟦P0⟧` 或 `⟦P1⟧` 占位符。');

    // 2. Literal ⟦P0⟧ inside fenced code block
    const fencedSent = 'Example:\n```js\nconst s = "⟦P0⟧";\n```\nDone.';
    const m2 = mod.maskTechnicalLiterals(fencedSent);
    assert.equal(m2.tokens.length, 1);
    assert.equal(m2.masked, 'Example:\n⟦P0⟧\nDone.');
    const r2 = mod.unmaskTechnicalLiterals('示例：\n⟦P0⟧\n完成。', m2.tokens);
    assert.equal(r2.intact, true);
    assert.ok(r2.text.includes('const s = "⟦P0⟧";'));

    // 3. Nested cross-delimiter code fences (~~~md wrapping ```js ... ```)
    const nestedFence = 'Intro\n~~~md\n```js\nconst x = 1;\n```\n~~~\nOutro';
    const m3 = mod.maskTechnicalLiterals(nestedFence);
    assert.equal(m3.tokens.length, 1);
    assert.equal(m3.masked, 'Intro\n⟦P0⟧\nOutro');
    const r3 = mod.unmaskTechnicalLiterals(m3.masked, m3.tokens);
    assert.equal(r3.intact, true);
    assert.equal(r3.text, nestedFence);

    // 4. Double-backtick inline code containing single backtick
    const dbl = 'Use ``foo `bar` baz`` in markdown.';
    const m4 = mod.maskTechnicalLiterals(dbl);
    assert.deepEqual(m4.tokens, ['``foo `bar` baz``']);
    assert.equal(m4.masked, 'Use ⟦P0⟧ in markdown.');
    const r4 = mod.unmaskTechnicalLiterals('在 Markdown 中使用 ⟦P0⟧。', m4.tokens);
    assert.equal(r4.intact, true);
    assert.equal(r4.text, '在 Markdown 中使用 ``foo `bar` baz``。');
  });

  test('masks CJK-bounded URLs, Han-adjacent mentions/citations, and :start-end line ranges on POSIX/bare files', () => {
    const cjkUrls = '详见（https://example.com/a）和 https://example.com/b。';
    const mu = mod.maskTechnicalLiterals(cjkUrls);
    assert.deepEqual(mu.tokens, ['https://example.com/a', 'https://example.com/b']);
    assert.equal(mu.masked, '详见（⟦P0⟧）和 ⟦P1⟧。');

    const cjkRefs = '请@#dev-ops和@alice查看#42的Check';
    const mr = mod.maskTechnicalLiterals(cjkRefs);
    assert.deepEqual(mr.tokens, ['@#dev-ops', '@alice', '#42']);
    assert.equal(mr.masked, '请⟦P0⟧和⟦P1⟧查看⟦P2⟧的Check');
    const rr = mod.unmaskTechnicalLiterals(mr.masked, mr.tokens);
    assert.equal(rr.intact, true);
    assert.equal(rr.text, '请 @#dev-ops 和 @alice 查看 #42 的Check');

    const lineRanges = 'Check C:\\foo\\56f8c44e-ba95-43c2-94d3-41b7a3b39a07\\foo.mjs:42-50 and main.mjs:809-810 and dir/app.js:12-34.';
    const ml = mod.maskTechnicalLiterals(lineRanges);
    assert.deepEqual(ml.tokens, [
      'C:\\foo\\56f8c44e-ba95-43c2-94d3-41b7a3b39a07\\foo.mjs:42-50',
      'dir/app.js:12-34',
      'main.mjs:809-810',
    ]);
    assert.equal(ml.masked, 'Check ⟦P0⟧ and ⟦P2⟧ and ⟦P1⟧.');
  });

  test('maskTechnicalLiterals & unmaskTechnicalLiterals stay linear (<100ms) on 50KB trimUrlTrailing, PUA delimiters, RE_WIN_REL, and 12.5k tokens', () => {
    // 1. trimUrlTrailing 50KB closing brackets
    for (const ch of [')', ']', '}']) {
      const t0 = performance.now();
      const res = mod.maskTechnicalLiterals('https://a/' + ch.repeat(50000));
      const elapsed = performance.now() - t0;
      assert.deepEqual(res.tokens, ['https://a/']);
      assert.equal(res.masked, '⟦P0⟧' + ch.repeat(50000));
      assert.ok(elapsed < 100, `trimUrlTrailing 50k '${ch}' took ${elapsed.toFixed(2)}ms`);
    }

    // 2. 50KB PUA \uE000 / \uE001 delimiters (must not throw SyntaxError: Regular expression too large)
    for (const [name, input, expectedTokens] of [
      ['50k uE000', '\uE000'.repeat(50000), []],
      ['50k uE001', '\uE001'.repeat(50000), []],
      ['50k uE000 + @alice', '\uE000'.repeat(50000) + ' @alice', ['@alice']],
    ]) {
      const t0 = performance.now();
      const res = mod.maskTechnicalLiterals(input);
      const elapsed = performance.now() - t0;
      assert.deepEqual(res.tokens, expectedTokens, `${name} tokens`);
      if (expectedTokens.length > 0) {
        const unmasked = mod.unmaskTechnicalLiterals(res.masked, res.tokens);
        assert.equal(unmasked.intact, true, `${name} unmask intact`);
        assert.equal(unmasked.text, input, `${name} roundtrip`);
      }
      assert.ok(elapsed < 100, `${name} took ${elapsed.toFixed(2)}ms`);
    }

    // 3. RE_WIN_REL 50KB dot/hyphen/backslash cases in maskTechnicalLiterals
    for (const [name, input, expectedTokens] of [
      ['RE_WIN_REL a. x 25k + xyz!', 'a.'.repeat(25000) + 'xyz!', []],
      ['RE_WIN_REL a-b- x 12.5k + !', 'a-b-'.repeat(12500) + '!', []],
      ['RE_WIN_REL . x 50k + !', '.'.repeat(50000) + '!', []],
      ['RE_WIN_REL a. x 25k + b\\c', 'a.'.repeat(25000) + ' b\\c', ['b\\c']],
    ]) {
      const t0 = performance.now();
      const res = mod.maskTechnicalLiterals(input);
      const elapsed = performance.now() - t0;
      assert.deepEqual(res.tokens, expectedTokens, `${name} tokens`);
      assert.ok(elapsed < 100, `${name} took ${elapsed.toFixed(2)}ms`);
    }

    // 4. unmaskTechnicalLiterals with 12,500 tokens (missing, present, and 【Pn】 salvage)
    const tokens12k = Array.from({ length: 12500 }, () => '@a');
    {
      const t0 = performance.now();
      const res = mod.unmaskTechnicalLiterals('x'.repeat(50000), tokens12k);
      const elapsed = performance.now() - t0;
      assert.equal(res.intact, false);
      assert.ok(elapsed < 100, `unmask 12.5k missing took ${elapsed.toFixed(2)}ms`);
    }
    {
      const presentInput = Array.from({ length: 12500 }, (_, i) => `⟦P${i}⟧`).join(' ');
      const t0 = performance.now();
      const res = mod.unmaskTechnicalLiterals(presentInput, tokens12k);
      const elapsed = performance.now() - t0;
      assert.equal(res.intact, true);
      assert.ok(elapsed < 100, `unmask 12.5k present took ${elapsed.toFixed(2)}ms`);
    }
    {
      const salvageInput = Array.from({ length: 12500 }, (_, i) => `【P${i}】`).join(' ');
      const t0 = performance.now();
      const res = mod.unmaskTechnicalLiterals(salvageInput, tokens12k);
      const elapsed = performance.now() - t0;
      assert.equal(res.intact, true);
      assert.ok(elapsed < 100, `unmask 12.5k 【Pn】 salvage took ${elapsed.toFixed(2)}ms`);
    }
  });

  test('unmaskTechnicalLiterals avoids V8 ConsString O(n^2) flattening (<50ms) on large expanding & mixed-corruption payloads', () => {
    // 1. 50KB repeated expanding token -> 649,999 chars (duplicated ⟦P0⟧ -> intact: false)
    {
      const toks = ['@' + 'a'.repeat(50)];
      const input = '⟦P0⟧'.repeat(12500);
      const t0 = performance.now();
      const res = mod.unmaskTechnicalLiterals(input, toks);
      const elapsed = performance.now() - t0;
      assert.equal(res.text.length, 649999);
      assert.equal(res.intact, false);
      assert.ok(res.text.startsWith('@' + 'a'.repeat(50) + ' @' + 'a'.repeat(50)));
      assert.ok(elapsed < 50, `50KB repeated expanding token took ${elapsed.toFixed(2)}ms (expected < 50ms)`);
    }

    // 2. 7,000 unique adjacent ⟦Pi⟧ with 22+ char @tokens -> 180,889 chars (intact: true)
    {
      const toks = Array.from({ length: 7000 }, (_, i) => '@' + 'x'.repeat(20) + i);
      const input = Array.from({ length: 7000 }, (_, i) => `⟦P${i}⟧`).join('');
      const t0 = performance.now();
      const res = mod.unmaskTechnicalLiterals(input, toks);
      const elapsed = performance.now() - t0;
      assert.equal(res.text.length, 180889);
      assert.equal(res.intact, true);
      assert.ok(elapsed < 50, `7,000 unique expanding tokens took ${elapsed.toFixed(2)}ms (expected < 50ms)`);
    }

    // 3. 12,500 mixed corrupted tokens (⟦ p i ⟧ / 【Pi】 / ⟦P99999⟧)
    {
      const toks = Array.from({ length: 12500 }, (_, i) => `@u${i}`);
      const input = Array.from({ length: 12500 }, (_, i) => {
        if (i % 3 === 0) return `⟦ p ${i} ⟧`;
        if (i % 3 === 1) return `【P${i}】`;
        return '⟦P99999⟧';
      }).join(' ');
      const t0 = performance.now();
      const res = mod.unmaskTechnicalLiterals(input, toks);
      const elapsed = performance.now() - t0;
      assert.equal(res.intact, false);
      assert.ok(res.text.includes('@u0 @u1 ⟦P99999⟧ @u3'));
      assert.ok(elapsed < 50, `12,500 mixed corrupted tokens took ${elapsed.toFixed(2)}ms (expected < 50ms)`);
    }
  });

  test('masks CJK-adjacent Windows/POSIX/UNC paths, bare filenames, and bare drive roots without swallowing Chinese prose', () => {
    const cases = [
      ['查看src\\app.js文件', ['src\\app.js'], '查看⟦P0⟧文件'],
      ['访问\\\\server\\share\\file.txt文件', ['\\\\server\\share\\file.txt'], '访问⟦P0⟧文件'],
      ['请看C:\\repo\\app.js', ['C:\\repo\\app.js'], '请看⟦P0⟧'],
      ['请检查C:\\repo\\main.mjs文件', ['C:\\repo\\main.mjs'], '请检查⟦P0⟧文件'],
      ['查看/api/swarm接口', ['/api/swarm'], '查看⟦P0⟧接口'],
      ['查看src/app.js文件', ['src/app.js'], '查看⟦P0⟧文件'],
      ['修改app.js并测试', ['app.js'], '修改⟦P0⟧并测试'],
      ['检查 app.js的逻辑', ['app.js'], '检查 ⟦P0⟧的逻辑'],
      ['Check C:\\ directory', ['C:\\'], 'Check ⟦P0⟧ directory'],
    ];

    for (const [input, expectedTokens, expectedMasked] of cases) {
      const m = mod.maskTechnicalLiterals(input);
      assert.deepEqual(m.tokens, expectedTokens, `tokens for ${input}`);
      assert.equal(m.masked, expectedMasked, `masked for ${input}`);
      const r = mod.unmaskTechnicalLiterals(m.masked, m.tokens);
      assert.equal(r.intact, true, `intact for ${input}`);
      assert.equal(r.text, input, `roundtrip for ${input}`);
    }

    // 50KB CJK + backslash ReDoS check
    const t0 = performance.now();
    const bigCjk = '中文'.repeat(25000) + '\\';
    const bigRes = mod.maskTechnicalLiterals(bigCjk);
    const elapsed = performance.now() - t0;
    assert.deepEqual(bigRes.tokens, []);
    assert.ok(elapsed < 100, `50KB CJK backslash took ${elapsed.toFixed(2)}ms`);
  });
});

// ---------------------------------------------------------------------------
// Group 2: F2 Tier-1 Deterministic Rules
// ---------------------------------------------------------------------------

describe('F2: applyTier1Rules deterministic offline localization', () => {
  test('translates BOARD_ACTIVITY and describeToolCall labels deterministically', () => {
    assert.deepEqual(mod.applyTier1Rules('Waiting for posts', 'activity'), { text: '正在等待新消息', fullyTranslated: true });
    assert.deepEqual(mod.applyTier1Rules('Reading the board', 'activity'), { text: '正在读取看板', fullyTranslated: true });
    assert.deepEqual(mod.applyTier1Rules('Posting to the board', 'activity'), { text: '正在发布到看板', fullyTranslated: true });

    assert.deepEqual(mod.applyTier1Rules('Read app.js', 'activity'), { text: '读取 app.js', fullyTranslated: true });
    assert.deepEqual(mod.applyTier1Rules('Write config.json', 'activity'), { text: '写入 config.json', fullyTranslated: true });
    assert.deepEqual(mod.applyTier1Rules('Edit main.mjs', 'activity'), { text: '编辑 main.mjs', fullyTranslated: true });
    assert.deepEqual(mod.applyTier1Rules('Search MENTION_RE', 'activity'), { text: '搜索 MENTION_RE', fullyTranslated: true });
    assert.deepEqual(mod.applyTier1Rules('swarm add parser', 'activity'), { text: '添加成员 parser', fullyTranslated: true });
    assert.deepEqual(mod.applyTier1Rules('swarm_wait', 'activity'), { text: '等待看板新消息', fullyTranslated: true });
    assert.deepEqual(mod.applyTier1Rules('Unit test execution', 'activity'), { text: '执行单元测试', fullyTranslated: true });
  });

  test('translates stepFailure and systemAttention patterns', () => {
    assert.deepEqual(mod.applyTier1Rules('model error', 'failure'), { text: '模型调用错误', fullyTranslated: true });
    assert.deepEqual(mod.applyTier1Rules('step failed', 'failure'), { text: '步骤执行失败', fullyTranslated: true });
    const qFail = mod.applyTier1Rules('HTTP 429 RESOURCE_EXHAUSTED', 'failure');
    assert.equal(qFail.fullyTranslated, true);
    assert.ok(qFail.text.startsWith('额度耗尽或触发限流：'));

    assert.deepEqual(
      mod.applyTier1Rules('worker1: last step failed (quota)', 'attention'),
      { text: 'worker1：上一步执行失败（额度耗尽）', fullyTranslated: true },
    );
    assert.deepEqual(
      mod.applyTier1Rules('worker2: last step failed (error)', 'attention'),
      { text: 'worker2：上一步执行失败（出错）', fullyTranslated: true },
    );
    assert.deepEqual(
      mod.applyTier1Rules('worker3: no progress, and not waiting on the board', 'attention'),
      { text: 'worker3：长时间无进展，且未在看板等待', fullyTranslated: true },
    );
    assert.deepEqual(mod.applyTier1Rules('@w1 ran out of quota', 'attention'), { text: '@w1 额度已耗尽', fullyTranslated: true });
    assert.deepEqual(mod.applyTier1Rules('@w2 looks stuck', 'attention'), { text: '@w2 疑似停滞', fullyTranslated: true });
    assert.deepEqual(mod.applyTier1Rules('@w3 hit an error', 'attention'), { text: '@w3 发生错误', fullyTranslated: true });
  });

  test('translates protocol tags, [channel] controls, resume, Screenshot:, and clause prefixes', () => {
    // [done] + Chinese skips LLM
    assert.deepEqual(
      mod.applyTier1Rules('[done] 前端体验重做已完成', 'message'),
      { text: '[已完成] 前端体验重做已完成', fullyTranslated: true },
    );
    // Bare @coordinator [done] skips LLM
    assert.deepEqual(
      mod.applyTier1Rules('@coordinator [done]', 'message'),
      { text: '@coordinator [已完成]', fullyTranslated: true },
    );
    // [done] + English marks fullyTranslated: false while converting [done]
    const engDone = mod.applyTier1Rules('@coordinator [done] Implemented feature X', 'message');
    assert.equal(engDone.fullyTranslated, false);
    assert.equal(engDone.text, '@coordinator [已完成] Implemented feature X');

    // [stall] ping
    assert.deepEqual(
      mod.applyTier1Rules('@verifier [stall] #38 is for you.', 'message'),
      { text: '@verifier [停滞告警] #38 是发给你的，请处理。', fullyTranslated: true },
    );

    // [channel] controls
    assert.deepEqual(
      mod.applyTier1Rules('[channel] created #ops: deploy coordination', 'control'),
      { text: '[频道] 创建了频道 #ops：deploy coordination', fullyTranslated: true },
    );
    assert.deepEqual(
      mod.applyTier1Rules('[channel] subscribed @alice to #ops', 'control'),
      { text: '[频道] 将 @alice 订阅到频道 #ops', fullyTranslated: true },
    );
    assert.deepEqual(
      mod.applyTier1Rules('[channel] created #parser (lexer and parser)', 'control'),
      { text: '[频道] 创建了频道 #parser（lexer and parser）', fullyTranslated: true },
    );
    assert.deepEqual(
      mod.applyTier1Rules('[channel] created #parser (lexer (v2) and parser)', 'control'),
      { text: '[频道] 创建了频道 #parser（lexer (v2) and parser）', fullyTranslated: true },
    );
    assert.deepEqual(
      mod.applyTier1Rules('[channel] created #parser ()', 'control'),
      { text: '[频道] 创建了频道 #parser', fullyTranslated: true },
    );
    assert.deepEqual(
      mod.applyTier1Rules('[channel] created #parser (词法与语法分析)', 'control'),
      { text: '[频道] 创建了频道 #parser（词法与语法分析）', fullyTranslated: true },
    );
    assert.deepEqual(
      mod.applyTier1Rules('[channel] created #parser （词法与语法分析）', 'control'),
      { text: '[频道] 创建了频道 #parser（词法与语法分析）', fullyTranslated: true },
    );
    assert.deepEqual(
      mod.applyTier1Rules('[channel] created #my-chan by @coord (topic)', 'control'),
      { text: '[频道] 由 @coord 创建了频道 #my-chan（topic）', fullyTranslated: true },
    );
    assert.deepEqual(
      mod.applyTier1Rules('[channel] created #my-chan - deploy topic', 'control'),
      { text: '[频道] 创建了频道 #my-chan：deploy topic', fullyTranslated: true },
    );
    assert.deepEqual(
      mod.applyTier1Rules('[channel] #parser created (topic)', 'control'),
      { text: '[频道] 创建了频道 #parser（topic）', fullyTranslated: true },
    );
    assert.deepEqual(
      mod.applyTier1Rules('[channel] coordinator created #dev', 'control'),
      { text: '[频道] coordinator 创建了频道 #dev', fullyTranslated: true },
    );
    assert.deepEqual(
      mod.applyTier1Rules('[channel] coordinator archived #parser', 'control'),
      { text: '[频道] coordinator 归档了频道 #parser', fullyTranslated: true },
    );
    assert.deepEqual(
      mod.applyTier1Rules('[channel] archived #parser (obsolete)', 'control'),
      { text: '[频道] 归档了频道 #parser（obsolete）', fullyTranslated: true },
    );
    assert.deepEqual(
      mod.applyTier1Rules('[channel] reviewer subscribed to #parser', 'control'),
      { text: '[频道] reviewer 订阅了频道 #parser', fullyTranslated: true },
    );
    assert.deepEqual(
      mod.applyTier1Rules('[channel] reviewer subscribed   to #parser', 'control'),
      { text: '[频道] reviewer 订阅了频道 #parser', fullyTranslated: true },
    );
    assert.deepEqual(
      mod.applyTier1Rules('[channel] coordinator subscribed reviewer to #parser', 'control'),
      { text: '[频道] coordinator 将 reviewer 订阅到频道 #parser', fullyTranslated: true },
    );
    assert.deepEqual(
      mod.applyTier1Rules('[channel] coordinator subscribed   reviewer   to #parser', 'control'),
      { text: '[频道] coordinator 将 reviewer 订阅到频道 #parser', fullyTranslated: true },
    );
    assert.deepEqual(
      mod.applyTier1Rules('[channel] subscribed   @alice   to #ops', 'control'),
      { text: '[频道] 将 @alice 订阅到频道 #ops', fullyTranslated: true },
    );
    assert.deepEqual(
      mod.applyTier1Rules('[channel] reviewer unsubscribed from #parser', 'control'),
      { text: '[频道] reviewer 退出了频道 #parser', fullyTranslated: true },
    );
    assert.deepEqual(
      mod.applyTier1Rules('[channel] reviewer unsubscribed   from #parser', 'control'),
      { text: '[频道] reviewer 退出了频道 #parser', fullyTranslated: true },
    );
    assert.deepEqual(
      mod.applyTier1Rules('[channel] coordinator renamed #old to #new', 'control'),
      { text: '[频道] coordinator 将频道 #old 重命名为 #new', fullyTranslated: true },
    );
    assert.deepEqual(
      mod.applyTier1Rules('[channel] coordinator updated #dev topic: new focus', 'control'),
      { text: '[频道] coordinator 将频道 #dev 的主题更新为：new focus', fullyTranslated: true },
    );

    // resume
    assert.deepEqual(mod.applyTier1Rules('@monitor resume', 'message'), { text: '@monitor 恢复运行', fullyTranslated: true });
    assert.deepEqual(mod.applyTier1Rules('resume', 'message'), { text: '恢复运行', fullyTranslated: true });

    // Verdict & line-start headers (never mid-sentence)
    const verdict = mod.applyTier1Rules('Verdict: PASS\nSummary: Check status of PASS/FAIL.', 'message');
    assert.equal(verdict.fullyTranslated, false);
    assert.ok(verdict.text.startsWith('结论：通过\n摘要：'));
    assert.ok(verdict.text.includes('PASS/FAIL'));

    // Screenshot prefix
    const shot = mod.applyTier1Rules('Screenshot: /tmp/a.png | 更新后界面', 'message');
    assert.equal(shot.fullyTranslated, true);
    assert.equal(shot.text, '截图：/tmp/a.png | 更新后界面');
  });

  test('protects fenced code blocks in applyTier1Rules and handles edge-case activity/tag/resume/verdict forms', () => {
    // 1. Fenced code blocks (closed & unclosed) are never mutated by Screenshot:/applyClausePrefixes
    const withFence = [
      '@coordinator [done] Check error:',
      '```',
      'Status: failed',
      'Error: ENOENT',
      'PASS',
      'Screenshot: raw.png',
      '```',
      'Verdict: PASS',
    ].join('\n');
    const rFence = mod.applyTier1Rules(withFence, 'message');
    assert.equal(rFence.fullyTranslated, false);
    assert.ok(rFence.text.startsWith('@coordinator [已完成] Check error:\n'));
    assert.ok(rFence.text.includes('```\nStatus: failed\nError: ENOENT\nPASS\nScreenshot: raw.png\n```'));
    assert.ok(rFence.text.endsWith('\n结论：通过'));

    const unclosedFence = 'Check:\n~~~\nStatus: failed\nScreenshot: raw.png';
    const rUnclosed = mod.applyTier1Rules(unclosedFence, 'message');
    assert.equal(rUnclosed.text, unclosedFence);

    // 2. kind='activity' Read/Write/Edit rejects English prose while keeping file/path tokens
    const proseActivity = mod.applyTier1Rules('Read the board specification and design plan', 'activity');
    assert.equal(proseActivity.fullyTranslated, false);
    assert.equal(proseActivity.text, 'Read the board specification and design plan');
    assert.deepEqual(mod.applyTier1Rules('Read Makefile', 'activity'), { text: '读取 Makefile', fullyTranslated: true });

    // 3. @#channel [done], @worker-1, resume, **Verdict:** PASS, Verdict: PASS (17/17)
    const chDone = mod.applyTier1Rules('@#dev [done] All tests passed.', 'message');
    assert.equal(chDone.fullyTranslated, false);
    assert.equal(chDone.text, '@#dev [已完成] All tests passed.');

    assert.deepEqual(
      mod.applyTier1Rules('@worker-1, resume', 'message'),
      { text: '@worker-1, 恢复运行', fullyTranslated: true },
    );
    assert.deepEqual(
      mod.applyTier1Rules('@worker-1: resume!', 'message'),
      { text: '@worker-1: 恢复运行!', fullyTranslated: true },
    );

    const boldVerdict = mod.applyTier1Rules('**Verdict:** PASS', 'message');
    assert.equal(boldVerdict.text, '**结论：** 通过');
    assert.equal(boldVerdict.fullyTranslated, true);

    const boldVerdictOut = mod.applyTier1Rules('**Verdict**: PASS', 'message');
    assert.equal(boldVerdictOut.text, '**结论**：通过');
    assert.equal(boldVerdictOut.fullyTranslated, true);

    const parenVerdict = mod.applyTier1Rules('Verdict: PASS (17/17)', 'message');
    assert.equal(parenVerdict.text, '结论：通过 (17/17)');
    assert.equal(parenVerdict.fullyTranslated, true);
  });

  test('applyTier1Rules avoids catastrophic ReDoS on 50KB adversarial space-padded, RE_WIN_REL, CHANNEL_*, Tier-1 CLI, and multiline inputs', () => {
    const cases = [
      // Existing 9 cases
      { name: 'space-padded channel create', input: '[channel] created #ch' + ' '.repeat(50000) + '!', kind: 'control', expectedFullyTranslated: false },
      { name: 'space-padded bare control', input: 'x' + ' '.repeat(50000) + '!', kind: 'control', expectedFullyTranslated: true },
      { name: 'space-padded subject subscribed', input: '[channel] a' + ' '.repeat(50000) + 'subscribed to #x ()!', kind: 'control', expectedFullyTranslated: false },
      { name: 'space-padded verb subscribed', input: '[channel] subscribed' + ' '.repeat(50000) + 'to #x ()!', kind: 'control', expectedFullyTranslated: false },
      { name: '50KB @a single-space mention chain', input: '@a '.repeat(16700) + 'unmatched text', kind: 'text', expectedFullyTranslated: false },
      { name: '50KB @a double-space mention chain', input: '@a  '.repeat(12500) + 'unmatched text', kind: 'text', expectedFullyTranslated: false },
      { name: '50KB @a mention chain + late [done]', input: '@a '.repeat(16700) + 'foo [done]', kind: 'text', expectedFullyTranslated: false },
      { name: '50KB @a@b adjacent mention chain', input: '@a@b'.repeat(12500) + 'unmatched', kind: 'text', expectedFullyTranslated: false },
      { name: '50KB leading spaces + unmatched', input: ' '.repeat(50000) + 'unmatched', kind: 'text', expectedFullyTranslated: false },
      // RE_WIN_REL 50KB cases
      { name: 'RE_WIN_REL: a. x 25k + xyz!', input: 'a.'.repeat(25000) + 'xyz!', kind: 'text', expectedFullyTranslated: false },
      { name: 'RE_WIN_REL: a-b- x 12.5k + !', input: 'a-b-'.repeat(12500) + '!', kind: 'text', expectedFullyTranslated: true },
      { name: 'RE_WIN_REL: a-b- x 12.5k + unmatched', input: 'a-b-'.repeat(12500) + ' unmatched', kind: 'text', expectedFullyTranslated: false },
      { name: 'RE_WIN_REL: . x 50k + !', input: '.'.repeat(50000) + '!', kind: 'text', expectedFullyTranslated: true },
      { name: 'RE_WIN_REL: a. x 25k + b\\c', input: 'a.'.repeat(25000) + ' b\\c', kind: 'text', expectedFullyTranslated: true },
      // CHANNEL_TOPIC_* 50KB + newline / \u2028 cases
      { name: 'CHANNEL_TOPIC colon + 50k sp + \\n!\\n!', input: '[channel] created #ch : ' + ' '.repeat(50000) + '\n!\n!', kind: 'control', expectedFullyTranslated: false },
      { name: 'CHANNEL_TOPIC dash + 50k sp + \\n!\\n!', input: '[channel] created #ch - ' + ' '.repeat(50000) + '\n!\n!', kind: 'control', expectedFullyTranslated: false },
      { name: 'CHANNEL_TOPIC parens + 50k sp + \\n!\\n!', input: '[channel] created #ch (' + ' '.repeat(50000) + '\n!\n!)', kind: 'control', expectedFullyTranslated: false },
      { name: 'CHANNEL_ARCHIVE colon + 50k sp + \\n!\\n!', input: '[channel] archived #ch : ' + ' '.repeat(50000) + '\n!\n!', kind: 'control', expectedFullyTranslated: false },
      { name: 'CHANNEL_TOPIC colon + 50k sp + \\u2028!\\u2028!', input: '[channel] created #ch : ' + ' '.repeat(50000) + '\u2028!\u2028!', kind: 'control', expectedFullyTranslated: false },
      { name: 'CHANNEL_TOPIC_OF + 50k sp + \\n!\\n!', input: '[channel] coordinator updated topic for #dev to ' + ' '.repeat(50000) + '\n!\n!', kind: 'control', expectedFullyTranslated: false },
      { name: 'CHANNEL_TOPIC_CH + 50k sp + \\n!\\n!', input: '[channel] coordinator updated #dev topic to ' + ' '.repeat(50000) + '\n!\n!', kind: 'control', expectedFullyTranslated: false },
      { name: 'CHANNEL_TOPIC_SHORT + 50k sp + \\n!\\n!', input: '[channel] #dev topic: ' + ' '.repeat(50000) + '\n!\n!', kind: 'control', expectedFullyTranslated: false },
      { name: 'CHANNEL_TOPIC_COLON + 50k sp + \\n!\\n!', input: '[channel] topic of #dev: ' + ' '.repeat(50000) + '\n!\n!', kind: 'control', expectedFullyTranslated: false },
      { name: 'CHANNEL_TOPIC_OF + 50k sp + \\u2028!\\u2028!', input: '[channel] coordinator updated topic for #dev to ' + ' '.repeat(50000) + '\u2028!\u2028!', kind: 'control', expectedFullyTranslated: false },
      // Mention comma / colon chains
      { name: '50KB @a, chain + resume!', input: '@a, '.repeat(12500) + 'resume!', kind: 'text', expectedFullyTranslated: true },
      { name: '50KB @a: chain + unmatched', input: '@a: '.repeat(12500) + 'unmatched', kind: 'text', expectedFullyTranslated: false },
      // Tier-1 Step 3 CLI / Read / Search 50KB cases
      { name: 'Tier-1 swarm activity + 50k sp + \\n!\\n!', input: 'swarm add ' + ' '.repeat(50000) + '\n!\n!', kind: 'activity', expectedFullyTranslated: false },
      { name: 'Tier-1 swarm text + 50k sp + \\n!\\n!', input: 'swarm add ' + ' '.repeat(50000) + '\n!\n!', kind: 'text', expectedFullyTranslated: false },
      { name: 'Tier-1 Read activity + 50k sp + \\n!\\n!', input: 'Read ' + ' '.repeat(50000) + '\n!\n!', kind: 'activity', expectedFullyTranslated: false },
      { name: 'Tier-1 Read text + 50k sp + \\n!\\n!', input: 'Read ' + ' '.repeat(50000) + '\n!\n!', kind: 'text', expectedFullyTranslated: false },
      { name: 'Tier-1 Search activity + 50k sp + \\n!\\n!', input: 'Search ' + ' '.repeat(50000) + '\n!\n!', kind: 'activity', expectedFullyTranslated: false },
      // PUA 50KB via applyTier1Rules
      { name: '50KB PUA uE000 via applyTier1Rules', input: '\uE000'.repeat(50000), kind: 'text', expectedFullyTranslated: true },
      // Multiline [channel] asymmetry guard
      { name: 'multiline [channel] subscribed asymmetry guard', input: '[channel] coordinator subscribed reviewer\nto #parser', kind: 'control', expectedFullyTranslated: false },
      { name: 'multiline [channel] created guard', input: '[channel] coordinator\ncreated #parser', kind: 'control', expectedFullyTranslated: false },
    ];

    for (const c of cases) {
      const t0 = performance.now();
      const res = mod.applyTier1Rules(c.input, c.kind);
      const elapsedMs = performance.now() - t0;
      assert.equal(res.fullyTranslated, c.expectedFullyTranslated, `${c.name} fullyTranslated`);
      assert.ok(elapsedMs < 100, `${c.name} took ${elapsedMs.toFixed(2)}ms (expected < 100ms)`);
    }
  });
});

// ---------------------------------------------------------------------------
// Group 3: F3 Explicit Opt-In Async LLM Queue, Zero-Key Default & Atomic LRU Cache
// ---------------------------------------------------------------------------

describe('F3: createTranslator zero-key offline default, explicit opt-in LLM queue, and atomic LRU cache', () => {
  test('respects disableLlm / AGY_SWARM_TRANSLATE_DISABLED=1 and never calls LLM', async () => {
    let called = 0;
    const tr = mod.createTranslator({
      cachePath: null,
      disableLlm: true,
      fetchImpl: async () => { called++; throw new Error('should not fetch'); },
    });
    const out = tr.translateSnapshotFields('s1', {
      title: 'English Swarm Title',
      messages: [{ seq: 1, agent: 'a', text: 'Working on task now.' }],
      members: [{ name: 'a', activity: 'Waiting for posts' }],
      systemAttention: [],
    });
    await new Promise((r) => setTimeout(r, 40));
    assert.equal(called, 0);
    assert.equal(out.translationState.enabled, false);
    assert.equal(out.translationState.provider, 'disabled');
    assert.equal(out.messages[0].text_zh_pending, false);
    assert.equal(out.members[0].activity_zh, '正在等待新消息');
    await tr.close();
  });

  test('offline default: zero akv-proxy or child_process code, zero network calls without explicit provider', async () => {
    const src = fs.readFileSync(TRANSLATOR_MJS_PATH, 'utf-8');
    assert.equal(/akv[-_]?proxy|AGY_SWARM_AKV|fromAkv|child_process|execFile/i.test(src), false,
      'translator.mjs must never auto-invoke akv-proxy or spawn child processes');

    const prevUrl = process.env.AGY_SWARM_TRANSLATE_BASE_URL;
    const prevKey = process.env.AGY_SWARM_TRANSLATE_API_KEY;
    delete process.env.AGY_SWARM_TRANSLATE_BASE_URL;
    delete process.env.AGY_SWARM_TRANSLATE_API_KEY;

    let fetchCalls = 0;
    const tr = mod.createTranslator({
      cachePath: null,
      fetchImpl: async () => { fetchCalls++; throw new Error('must never call fetch without explicit provider'); },
    });
    try {
      const out = tr.translateSnapshotFields('s-offline', {
        title: 'English Swarm Title',
        messages: [
          { seq: 1, agent: 'coordinator', text: '@monitor resume' },
          { seq: 2, agent: 'worker', text: '[done] Completed check of `main.mjs`' },
          { seq: 3, agent: 'worker', text: 'Plain English message with no LLM provider configured.' },
        ],
        members: [{ name: 'worker', activity: 'Read app.js' }],
        systemAttention: [],
      });
      await new Promise((r) => setTimeout(r, 40));
      assert.equal(fetchCalls, 0);
      assert.equal(out.translationState.provider, 'none');
      assert.equal(out.translationState.pending, 0);
      assert.equal(out.messages[0].text_zh, '@monitor 恢复运行');
      assert.equal(out.messages[0].text_zh_source, 'rule');
      assert.ok(out.messages[1].text_zh.startsWith('[已完成]'));
      assert.equal(out.messages[2].text_zh, null);
      assert.equal(out.messages[2].text_zh_pending, false);
      assert.equal(out.members[0].activity_zh, '读取 app.js');
    } finally {
      await tr.close();
      if (prevUrl !== undefined) process.env.AGY_SWARM_TRANSLATE_BASE_URL = prevUrl;
      if (prevKey !== undefined) process.env.AGY_SWARM_TRANSLATE_API_KEY = prevKey;
    }
  });

  test('provider precedence: explicit providerConfig beats AGY_SWARM_TRANSLATE_BASE_URL', async () => {
    const prevUrl = process.env.AGY_SWARM_TRANSLATE_BASE_URL;
    const prevKey = process.env.AGY_SWARM_TRANSLATE_API_KEY;
    const prevModel = process.env.AGY_SWARM_TRANSLATE_MODEL;
    const seenUrls = [];

    try {
      process.env.AGY_SWARM_TRANSLATE_BASE_URL = 'http://127.0.0.1:9999/v1';
      process.env.AGY_SWARM_TRANSLATE_API_KEY = 'env-key';
      process.env.AGY_SWARM_TRANSLATE_MODEL = 'env-model';

      const trDi = mod.createTranslator({
        cachePath: null,
        providerConfig: { baseUrl: 'http://127.0.0.1:8888/v1', apiKey: 'di-key', model: 'di-model' },
        fetchImpl: async (url) => {
          seenUrls.push(String(url));
          return {
            ok: true,
            json: async () => ({ choices: [{ message: { content: 'DI译文' } }] }),
          };
        },
      });
      trDi.translateSnapshotFields('p-di', { messages: [{ seq: 1, agent: 'a', text: 'Hello world' }], members: [] });
      await waitFor(() => trDi.getCacheVersion('p-di') > 0);
      assert.equal(trDi.getStats().provider, 'providerConfig');
      assert.equal(seenUrls[0], 'http://127.0.0.1:8888/v1/chat/completions');
      await trDi.close();

      const trEnv = mod.createTranslator({
        cachePath: null,
        fetchImpl: async (url) => {
          seenUrls.push(String(url));
          return {
            ok: true,
            json: async () => ({ choices: [{ message: { content: 'Env译文' } }] }),
          };
        },
      });
      trEnv.translateSnapshotFields('p-env', { messages: [{ seq: 1, agent: 'a', text: 'Hello env' }], members: [] });
      await waitFor(() => trEnv.getCacheVersion('p-env') > 0);
      assert.equal(trEnv.getStats().provider, 'env');
      assert.equal(seenUrls[1], 'http://127.0.0.1:9999/v1/chat/completions');
      await trEnv.close();
    } finally {
      if (prevUrl === undefined) delete process.env.AGY_SWARM_TRANSLATE_BASE_URL;
      else process.env.AGY_SWARM_TRANSLATE_BASE_URL = prevUrl;
      if (prevKey === undefined) delete process.env.AGY_SWARM_TRANSLATE_API_KEY;
      else process.env.AGY_SWARM_TRANSLATE_API_KEY = prevKey;
      if (prevModel === undefined) delete process.env.AGY_SWARM_TRANSLATE_MODEL;
      else process.env.AGY_SWARM_TRANSLATE_MODEL = prevModel;
    }
  });

  test('mock OpenAI server: concurrency cap (<=2), 429 Retry-After backoff, timeout, and corrupted placeholder rejection', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    let first429 = true;

    const mockServer = await startHttpServer(async (req, res) => {
      if (req.url === '/v1/chat/completions' && req.method === 'POST') {
        const body = await readJsonBody(req);
        const prompt = body.messages[1].content;

        if (prompt.includes('TRIGGER_429') && first429) {
          first429 = false;
          res.writeHead(429, { 'Content-Type': 'application/json', 'Retry-After': '0' });
          res.end(JSON.stringify({ error: 'rate limited' }));
          return;
        }
        if (prompt.includes('TRIGGER_TIMEOUT')) {
          await new Promise((r) => setTimeout(r, 300));
          if (!res.writableEnded) {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ choices: [{ message: { content: '太晚了' } }] }));
          }
          return;
        }
        if (prompt.includes('TRIGGER_CORRUPT')) {
          // Drop ⟦P0⟧ placeholder on purpose!
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ choices: [{ message: { content: '损坏的输出没有占位符' } }] }));
          return;
        }

        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((r) => setTimeout(r, 35));
        inFlight--;

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          choices: [{ message: { content: `译文:${prompt}` } }],
        }));
        return;
      }
      res.writeHead(404);
      res.end();
    });

    const tr = mod.createTranslator({
      cachePath: null,
      concurrency: 2,
      requestTimeoutMs: 100,
      baseBackoffMs: 10,
      providerConfig: { baseUrl: `${mockServer.url}/v1`, apiKey: 'test', model: 'mock-model' },
    });

    try {
      const msgs = [
        { seq: 1, agent: 'a', text: 'First normal message' },
        { seq: 2, agent: 'a', text: 'Second normal message' },
        { seq: 3, agent: 'a', text: 'Third normal message' },
        { seq: 4, agent: 'a', text: 'Fourth normal message' },
        { seq: 5, agent: 'a', text: 'Message TRIGGER_429 with `code`' },
        { seq: 6, agent: 'a', text: 'Message TRIGGER_CORRUPT with `app.js`' },
        { seq: 7, agent: 'a', text: 'Message TRIGGER_TIMEOUT test' },
      ];
      tr.translateSnapshotFields('s-ops', { messages: msgs, members: [] });

      await waitFor(() => {
        const st = tr.getStats();
        return st.pending === 0 && st.llmSuccess >= 5 && st.failed >= 2;
      }, 5000);

      assert.ok(maxInFlight <= 2, `Expected maxInFlight <= 2, got ${maxInFlight}`);

      const snap = tr.translateSnapshotFields('s-ops', { messages: msgs, members: [] });
      // 429 retried and succeeded
      assert.ok(snap.messages[4].text_zh.includes('`code`'));
      assert.equal(snap.messages[4].text_zh_source, 'llm');
      // Corrupt placeholder output was rejected and NOT cached
      assert.equal(snap.messages[5].text_zh, null);
      assert.equal(snap.messages[5].text_zh_source, 'none');
      // Timed out job was rejected and NOT cached
      assert.equal(snap.messages[6].text_zh, null);
    } finally {
      await tr.close();
      await mockServer.close();
    }
  });

  test('persistent atomic LRU cache: eviction, corrupt recovery, no .tmp leftovers, reload across instances', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-lru-cache-'));
    const cachePath = path.join(tmpDir, 'nested', 'translation_cache.json');
    // Seed corrupt JSON first
    fs.mkdirSync(path.dirname(cachePath), { recursive: true });
    fs.writeFileSync(cachePath, '{corrupt json!!!', 'utf-8');

    const mockServer = await startHttpServer(async (req, res) => {
      const body = await readJsonBody(req);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        choices: [{ message: { content: `中文(${body.messages[1].content})` } }],
      }));
    });

    try {
      const tr1 = mod.createTranslator({
        cachePath,
        maxEntries: 3,
        concurrency: 1,
        providerConfig: { baseUrl: `${mockServer.url}/v1`, apiKey: 'k', model: 'm' },
      });

      const sendOne = async (txt) => {
        const beforeVer = tr1.getCacheVersion('lru');
        tr1.translateSnapshotFields('lru', { messages: [{ seq: 1, agent: 'a', text: txt }], members: [] });
        await waitFor(() => tr1.getCacheVersion('lru') > beforeVer);
      };

      await sendOne('Alpha entry');
      await sendOne('Beta entry');
      await sendOne('Gamma entry');
      // Touch Alpha so Beta becomes oldest
      const hitAlpha = tr1.translateSnapshotFields('lru', {
        messages: [{ seq: 1, agent: 'a', text: 'Alpha entry' }],
        members: [],
      });
      assert.equal(hitAlpha.messages[0].text_zh, '中文(Alpha entry)');

      // Insert Delta -> evicts Beta
      await sendOne('Delta entry');
      assert.equal(tr1.getStats().cached, 3);
      await tr1.close();

      const files = fs.readdirSync(path.dirname(cachePath));
      assert.equal(files.some((f) => f.includes('.tmp.')), false);

      // Fresh translator with LLM disabled loads persisted cache
      const tr2 = mod.createTranslator({ cachePath, disableLlm: true });
      const check = tr2.translateSnapshotFields('lru', {
        messages: [
          { seq: 1, agent: 'a', text: 'Alpha entry' },
          { seq: 2, agent: 'a', text: 'Beta entry' },
          { seq: 3, agent: 'a', text: 'Gamma entry' },
          { seq: 4, agent: 'a', text: 'Delta entry' },
        ],
        members: [],
      });
      assert.equal(check.messages[0].text_zh, '中文(Alpha entry)');
      assert.equal(check.messages[0].text_zh_source, 'cache');
      assert.equal(check.messages[1].text_zh, null); // evicted
      assert.equal(check.messages[2].text_zh, '中文(Gamma entry)');
      assert.equal(check.messages[3].text_zh, '中文(Delta entry)');
      await tr2.close();
    } finally {
      await mockServer.close();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test('P1.8c: placeholder integrity failure fails fast in 1 attempt', async () => {
    // Placeholder integrity failure is non-retriable -> 1 LLM call (not 3)
    let corruptCalls = 0;
    const trFailFast = mod.createTranslator({
      cachePath: null,
      concurrency: 1,
      baseBackoffMs: 10,
      providerConfig: { baseUrl: 'http://127.0.0.1:1/v1', apiKey: 'k', model: 'm' },
      fetchImpl: async () => {
        corruptCalls++;
        return {
          ok: true,
          status: 200,
          json: async () => ({ choices: [{ message: { content: '丢掉了占位符' } }] }),
        };
      },
    });
    try {
      trFailFast.translateSnapshotFields('s-fast-fail', {
        messages: [{ seq: 1, agent: 'a', text: 'Inspect `main.mjs` immediately.' }],
        members: [],
      });
      await waitFor(() => trFailFast.getStats().pending === 0 && trFailFast.getStats().failed === 1);
      assert.equal(corruptCalls, 1);
      assert.equal(trFailFast.getStats().llmCalls, 1);
      assert.equal(trFailFast.getStats().cached, 0);
    } finally {
      await trFailFast.close();
    }
  });

  test('channel control lines: matched controls make 0 LLM calls while unmatched control lines fall back to async LLM', async () => {
    let llmCalls = 0;
    const tr = mod.createTranslator({
      cachePath: null,
      concurrency: 1,
      baseBackoffMs: 10,
      providerConfig: { baseUrl: 'http://127.0.0.1:1/v1', apiKey: 'k', model: 'm' },
      fetchImpl: async (_url, init) => {
        llmCalls++;
        const body = JSON.parse(init.body);
        const prompt = body.messages[1].content;
        return {
          ok: true,
          status: 200,
          json: async () => ({ choices: [{ message: { content: `中文:${prompt}` } }] }),
        };
      },
    });
    try {
      const matchedOnly = tr.translateSnapshotFields('s-ctrl-matched', {
        messages: [
          {
            seq: 1,
            agent: 'coordinator',
            text: '[channel] created #parser (lexer and parser)',
            control: { op: 'create', channel: 'parser', topic: 'lexer and parser' },
          },
          {
            seq: 2,
            agent: 'reviewer',
            text: '[channel] reviewer subscribed to #parser',
            control: { op: 'subscribe', channel: 'parser', members: ['reviewer'] },
          },
          {
            seq: 3,
            agent: 'coordinator',
            text: '[channel] coordinator renamed #old to #new',
            control: { op: 'rename', channel: 'new' },
          },
        ],
        members: [],
      });
      await new Promise((r) => setTimeout(r, 30));
      assert.equal(llmCalls, 0);
      assert.equal(tr.getStats().llmCalls, 0);
      assert.equal(matchedOnly.messages[0].text_zh_pending, false);
      assert.equal(matchedOnly.messages[0].text_zh_source, 'rule');
      assert.equal(matchedOnly.messages[0].text_zh, '[频道] 创建了频道 #parser（lexer and parser）');
      assert.equal(matchedOnly.messages[1].text_zh, '[频道] reviewer 订阅了频道 #parser');
      assert.equal(matchedOnly.messages[2].text_zh, '[频道] coordinator 将频道 #old 重命名为 #new');

      const withUnmatched = tr.translateSnapshotFields('s-ctrl-unmatched', {
        messages: [
          {
            seq: 4,
            agent: 'coordinator',
            text: '[channel] custom unknown op #parser',
            control: { op: 'custom', channel: 'parser' },
          },
        ],
        members: [],
      });
      assert.equal(withUnmatched.messages[0].text_zh_pending, true);
      assert.equal(withUnmatched.messages[0].text_zh, null);

      await waitFor(() => tr.getStats().pending === 0 && tr.getStats().llmSuccess === 1);
      assert.equal(llmCalls, 1);

      const after = tr.translateSnapshotFields('s-ctrl-unmatched', {
        messages: [
          {
            seq: 4,
            agent: 'coordinator',
            text: '[channel] custom unknown op #parser',
            control: { op: 'custom', channel: 'parser' },
          },
        ],
        members: [],
      });
      assert.equal(after.messages[0].text_zh_pending, false);
      assert.equal(after.messages[0].text_zh_source, 'llm');
      assert.ok(after.messages[0].text_zh.startsWith('中文:[频道]'));
    } finally {
      await tr.close();
    }
  });

  test('avoids O(n^2) ReDoS on 50KB baseUrl trailing slashes and 50KB interior-newline LLM responses', async () => {
    const slashUrl = '/'.repeat(50000) + 'a';
    const seenUrls = [];
    const t0 = performance.now();
    const tr = mod.createTranslator({
      cachePath: null,
      concurrency: 1,
      baseBackoffMs: 10,
      providerConfig: { baseUrl: slashUrl, apiKey: 'k', model: 'm' },
      fetchImpl: async (url) => {
        seenUrls.push(String(url));
        return {
          ok: true,
          status: 200,
          json: async () => ({
            choices: [{ message: { content: '前文' + '\n'.repeat(50000) + '后文' } }],
          }),
        };
      },
    });
    try {
      tr.translateSnapshotFields('s-redos-llm', {
        messages: [{ seq: 1, agent: 'a', text: 'Translate this sentence please' }],
        members: [],
      });
      const initElapsed = performance.now() - t0;
      assert.ok(initElapsed < 100, `createTranslator + translateSnapshotFields took ${initElapsed.toFixed(2)}ms`);

      const tDone0 = performance.now();
      await waitFor(() => tr.getStats().pending === 0 && tr.getStats().llmSuccess === 1, 2000, 10);
      const totalElapsed = performance.now() - tDone0;
      assert.ok(totalElapsed < 150, `50KB newline LLM response processing took ${totalElapsed.toFixed(2)}ms`);

      assert.equal(seenUrls[0], `${slashUrl}/chat/completions`);
      const after = tr.translateSnapshotFields('s-redos-llm', {
        messages: [{ seq: 1, agent: 'a', text: 'Translate this sentence please' }],
        members: [],
      });
      assert.equal(after.messages[0].text_zh, '前文' + '\n'.repeat(50000) + '后文');
    } finally {
      await tr.close();
    }
  });

  test('Tier 5: queue >500 eviction, __proto__ key safety, and cross-kind cache isolation', async () => {
    // 1. MAX_QUEUE_SIZE (>500) priority eviction keeps queue capped at 500 & runs highest priority
    const seenPrompts = [];
    let releaseHold;
    const hold = new Promise((r) => { releaseHold = r; });
    const trQueue = mod.createTranslator({
      cachePath: null,
      concurrency: 1,
      providerConfig: { baseUrl: 'http://127.0.0.1:1/v1', apiKey: 'k', model: 'm' },
      fetchImpl: async (_u, init) => {
        const body = JSON.parse(init.body);
        const prompt = body.messages[1].content;
        seenPrompts.push(prompt);
        if (seenPrompts.length === 1) await hold;
        return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: `中文:${prompt}` } }] }) };
      },
    });
    try {
      const bulkMsgs = Array.from({ length: 505 }, (_, i) => ({
        seq: i + 1,
        agent: 'w',
        text: `Bulk queue message index ${i + 1} needs translation.`,
      }));
      trQueue.translateSnapshotFields('s-q-cap', { messages: bulkMsgs, members: [] });
      assert.ok(trQueue.getStats().pending <= 501, `Expected pending <= 501 (1 inFlight + 500 queued), got ${trQueue.getStats().pending}`);
      releaseHold();
      await waitFor(() => trQueue.getStats().pending === 0, 5000, 15);
      assert.ok(seenPrompts.some((p) => p.includes('index 505')), 'Highest-priority tail message must not be evicted');
    } finally {
      await trQueue.close();
    }

    // 2. __proto__ object-map member key does not mutate prototype + cross-kind makeCacheKey isolation
    const trKinds = mod.createTranslator({
      cachePath: null,
      concurrency: 1,
      providerConfig: { baseUrl: 'http://127.0.0.1:1/v1', apiKey: 'k', model: 'm' },
      fetchImpl: async (_u, init) => {
        const prompt = JSON.parse(init.body).messages[1].content;
        return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: `译:${prompt}` } }] }) };
      },
    });
    try {
      const protoMembers = JSON.parse('{"__proto__": {"name": "__proto__", "activity": "Read a.js"}}');
      const quotaText = '429 RESOURCE_EXHAUSTED: rate limit exceeded in workspace billing quota window';
      const sProto = trKinds.translateSnapshotFields('s-proto', {
        messages: [{ seq: 1, agent: 'a', text: quotaText }],
        members: protoMembers,
      });
      assert.equal(Object.getPrototypeOf(sProto.members), Object.prototype);
      assert.equal(Object.hasOwn(sProto.members, '__proto__'), true);
      assert.ok(Object.keys(sProto.members).includes('__proto__'));
      assert.equal(sProto.members['__proto__'].activity_zh, '读取 a.js');

      await waitFor(() => trKinds.getStats().pending === 0);
      const sFailure = trKinds.translateSnapshotFields('s-proto', {
        messages: [{ seq: 1, agent: 'a', text: quotaText }],
        members: [{ name: 'w1', failure: { kind: 'quota', text: quotaText } }],
      });
      await waitFor(() => trKinds.getStats().pending === 0);
      const sFailureAfter = trKinds.translateSnapshotFields('s-proto', {
        messages: [{ seq: 1, agent: 'a', text: quotaText }],
        members: [{ name: 'w1', failure: { kind: 'quota', text: quotaText } }],
      });
      assert.ok(!sFailureAfter.messages[0].text_zh.startsWith('额度耗尽或触发限流：'));
      assert.ok(sFailureAfter.members[0].failure_zh.startsWith('译:额度耗尽或触发限流：'), `got: ${sFailureAfter.members[0].failure_zh}`);
      assert.notEqual(sFailureAfter.members[0].failure_zh, sFailureAfter.messages[0].text_zh);
    } finally {
      await trKinds.close();
    }
  });

  test('long messages (>2000 chars) auto-chunk on paragraph boundaries and preserve all placeholders', async () => {
    const chunkPrompts = [];
    const tr = mod.createTranslator({
      cachePath: null,
      concurrency: 1,
      providerConfig: { baseUrl: 'http://127.0.0.1:1/v1', apiKey: 'k', model: 'm' },
      fetchImpl: async (_url, init) => {
        const body = JSON.parse(init.body);
        const prompt = body.messages[1].content;
        chunkPrompts.push(prompt);
        return {
          ok: true,
          status: 200,
          json: async () => ({ choices: [{ message: { content: `中文块:${prompt}` } }] }),
        };
      },
    });
    try {
      const paras = Array.from({ length: 12 }, (_, i) =>
        `Paragraph ${i + 1}: Please inspect \`file_${i + 1}.mjs\` at C:\\work\\dir_${i + 1}\\item.json and report findings to @verifier about #${i + 1}. ` +
        'This paragraph contains enough English description text to ensure the complete message crosses the chunking threshold cleanly.'
      );
      const longMsg = paras.join('\n\n');
      assert.ok(longMsg.length > 2400);

      tr.translateSnapshotFields('s-chunk', {
        messages: [{ seq: 1, agent: 'coordinator', text: longMsg }],
        members: [],
      });
      await waitFor(() => tr.getStats().pending === 0 && tr.getStats().cached === 1, 3000, 15);
      const after = tr.translateSnapshotFields('s-chunk', {
        messages: [{ seq: 1, agent: 'coordinator', text: longMsg }],
        members: [],
      });
      assert.ok(chunkPrompts.length >= 2, `Expected >= 2 chunks, got ${chunkPrompts.length}`);
      assert.equal(after.messages[0].text_zh_source, 'llm');
      assert.ok(after.messages[0].text_zh.includes('`file_1.mjs`'));
      assert.ok(after.messages[0].text_zh.includes('`file_12.mjs`'));
      assert.ok(after.messages[0].text_zh.includes('C:\\work\\dir_12\\item.json'));
      assert.ok(after.messages[0].text_zh.includes('@verifier'));
      assert.ok(after.messages[0].text_zh.includes('#12'));
    } finally {
      await tr.close();
    }
  });
});

// ---------------------------------------------------------------------------
// Group 4: F4 main.mjs /api/swarm End-to-End Child Process Integration
// ---------------------------------------------------------------------------

describe('F4: main.mjs /api/swarm end-to-end non-blocking enrichment & etag versioning', () => {
  const CONV_ID = 'aaaa1111-2222-4333-8444-555566667777';
  const WORKER_CONV = 'bbbb1111-2222-4333-8444-555566667777';

  function spawnSidecar(envExtra) {
    return new Promise((resolve, reject) => {
      const child = spawn(
        process.execPath,
        ['--import', pathToFileURL(SIDECAR_REGISTER_LOADER).href, MAIN_MJS_PATH],
        {
          env: {
            ...process.env,
            ANTIGRAVITY_LS_ADDRESS: '127.0.0.1:1',
            ANTIGRAVITY_CSRF_TOKEN: 'test-csrf',
            ANTIGRAVITY_SIDECAR_WEB_PORT: '0',
            SWARM_OVERVIEW: 'true',
            ...envExtra,
          },
          stdio: ['ignore', 'pipe', 'pipe'],
        },
      );

      let stdout = '';
      let stderr = '';
      const timer = setTimeout(() => {
        child.kill();
        reject(new Error(`Sidecar startup timeout. stdout=${stdout}\nstderr=${stderr}`));
      }, 6000);

      child.stdout.on('data', (chunk) => {
        stdout += chunk.toString('utf-8');
        const m = /\[sidecar\] listening on 127\.0\.0\.1:(\d+)/.exec(stdout);
        if (m) {
          clearTimeout(timer);
          resolve({ child, port: Number(m[1]), getStderr: () => stderr });
        }
      });
      child.stderr.on('data', (chunk) => { stderr += chunk.toString('utf-8'); });
      child.on('exit', (code) => {
        clearTimeout(timer);
        reject(new Error(`Sidecar exited early (${code}). stdout=${stdout}\nstderr=${stderr}`));
      });
    });
  }

  async function stopChild(child) {
    if (!child || child.exitCode !== null) return;
    await new Promise((resolve) => {
      const t = setTimeout(() => {
        try { child.kill('SIGKILL'); } catch {}
        resolve();
      }, 3000);
      child.once('exit', () => { clearTimeout(t); resolve(); });
      child.kill('SIGTERM');
    });
  }

  async function fetchSwarm(port, conv, etag = '') {
    const url = `http://127.0.0.1:${port}/api/swarm?conversationId=${encodeURIComponent(conv)}&etag=${encodeURIComponent(etag)}`;
    const res = await fetch(url, { headers: { 'x-sidecar-token': 'test-csrf' } });
    assert.equal(res.status, 200);
    return res.json();
  }

  test('non-blocking response (<100ms), etag unchanged/bump, read-only invariance, and restart cache hit', async () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-main-e2e-'));
    const dataDir = path.join(tmpRoot, 'app_data', 'sidecar_data', 'swarm', 'swarm_board', 'data');
    const swarmDir = path.join(tmpRoot, 'app_data', 'brain', CONV_ID, '.system_generated', 'swarm');
    const workerLogDir = path.join(tmpRoot, 'app_data', 'brain', WORKER_CONV, '.system_generated', 'logs');
    fs.mkdirSync(dataDir, { recursive: true });
    fs.mkdirSync(swarmDir, { recursive: true });
    fs.mkdirSync(workerLogDir, { recursive: true });

    const membersPath = path.join(swarmDir, 'members.json');
    const boardPath = path.join(swarmDir, 'board.jsonl');
    const viewPath = path.join(swarmDir, 'view.json');
    const planPath = path.join(swarmDir, 'plan.json');
    const shotPath = path.join(swarmDir, 'shot.png');

    fs.writeFileSync(shotPath, 'fake-png', 'utf-8');
    fs.writeFileSync(membersPath, JSON.stringify({
      title: 'Swarm E2E Test Board',
      members: {
        coordinator: { conversation_id: CONV_ID, role: 'coordinator', wake_mode: 'mentions' },
        worker1: { conversation_id: WORKER_CONV, role: 'worker', wake_mode: 'working' },
      },
    }), 'utf-8');

    fs.writeFileSync(workerLogDir + path.sep + 'transcript.jsonl', JSON.stringify({
      type: 'PLANNER_RESPONSE',
      step_index: 1,
      tool_calls: [{ name: 'read_file', args: { Path: '"f:\\\\proj\\\\app.js"' } }],
    }) + '\n', 'utf-8');

    const boardLines = [
      JSON.stringify({ seq: 1, agent: 'coordinator', text: '@worker1 Please inspect `main.mjs` and report #1.', time: '2026-11-19 10:00:00' }),
      JSON.stringify({ seq: 2, agent: 'worker1', text: `[done] 已完成检查\nScreenshot: /frames/shot.png | Initial frame`, time: '2026-11-19 10:01:00' }),
      JSON.stringify({ seq: 3, agent: 'coordinator', text: '[channel] created #ops: deploy', control: { op: 'create', channel: 'ops', topic: 'deploy' }, time: '2026-11-19 10:02:00' }),
    ];
    fs.writeFileSync(boardPath, boardLines.join('\n') + '\n', 'utf-8');

    const originalView = {
      version: 1,
      as_of_seq: 3,
      updated_at: '2026-11-19T10:02:00Z',
      headline: 'Investigating sidecar performance',
      phase: { label: 'In progress', index: 1, total: 2 },
      attention: [{ id: 'att-1', kind: 'fyi', severity: 'low', title: 'Review needed', why: 'Check latency metrics', refs: [{ seq: 1 }] }],
      workstreams: [{ id: 'ws-1', title: 'Backend sidecar', owners: ['worker1'], state: 'active', note: '1/2 done' }],
      milestones: [{ id: 'ms-1', text: 'Ship localization' }],
      risks: [],
    };
    fs.writeFileSync(viewPath, JSON.stringify(originalView), 'utf-8');

    const originalPlan = {
      goal: 'Localize swarm board completely',
      tasks: { worker1: 'Inspect main.mjs latency' },
      threads: [{ id: 'th-1', title: 'Backend', goal: 'Zero blocking', tasks: ['worker1'] }],
    };
    fs.writeFileSync(planPath, JSON.stringify(originalPlan), 'utf-8');

    const hashesBefore = {
      members: sha256File(membersPath),
      board: sha256File(boardPath),
      view: sha256File(viewPath),
      plan: sha256File(planPath),
    };

    // Mock LLM server with 120ms delay to verify non-blocking poll 1
    let llmHits = 0;
    const mockLlm = await startHttpServer(async (req, res) => {
      if (req.url === '/v1/chat/completions' && req.method === 'POST') {
        llmHits++;
        const body = await readJsonBody(req);
        await new Promise((r) => setTimeout(r, 120));
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          choices: [{ message: { content: `中文:${body.messages[1].content}` } }],
        }));
        return;
      }
      res.writeHead(404);
      res.end();
    });

    let sidecar1 = null;
    let sidecar2 = null;
    try {
      sidecar1 = await spawnSidecar({
        ANTIGRAVITY_EXECUTABLE_DATA_DIR: dataDir,
        AGY_SWARM_TRANSLATE_BASE_URL: `${mockLlm.url}/v1`,
        AGY_SWARM_TRANSLATE_API_KEY: 'test-key',
        AGY_SWARM_TRANSLATE_MODEL: 'mock-fast',
      });

      // Poll 1: must return immediately (<100ms, well below 120ms LLM latency)
      const t0 = Date.now();
      const p1 = await fetchSwarm(sidecar1.port, CONV_ID, '');
      const elapsed = Date.now() - t0;
      assert.ok(elapsed < 100, `Expected non-blocking /api/swarm < 100ms, took ${elapsed}ms`);

      assert.equal(p1.swarm, CONV_ID);
      assert.equal(p1.messages.length, 3);
      assert.equal(p1.messages[0].text, '@worker1 Please inspect `main.mjs` and report #1.');
      assert.equal(p1.messages[0].text_zh_pending, true);
      assert.equal(p1.messages[0].text_zh, null);
      assert.equal(p1.messages[1].text_zh_source, 'rule');
      assert.ok(p1.messages[1].text_zh.startsWith('[已完成] 已完成检查'));
      assert.equal(p1.messages[2].text_zh_source, 'rule');
      assert.ok(p1.messages[2].text_zh.includes('[频道]'));

      // Snap.members is an Array with additive activity_zh & title_zh
      assert.ok(Array.isArray(p1.members));
      const w1 = p1.members.find((m) => m.name === 'worker1');
      assert.equal(w1.activity, 'Read app.js');
      assert.equal(w1.activity_zh, '读取 app.js');

      // Deep-cloned view_zh & plan_zh exist without mutating raw view.json
      assert.ok(p1.view_zh && typeof p1.view_zh === 'object');
      assert.equal(p1.view.json.headline, 'Investigating sidecar performance');
      assert.equal(p1.view_zh.phase.label, '进行中');
      assert.ok(p1.plan_zh && typeof p1.plan_zh === 'object');
      assert.equal(p1.plan.goal, 'Localize swarm board completely');

      // Poll 2 immediately with p1.etag -> unchanged: true
      const p2 = await fetchSwarm(sidecar1.port, CONV_ID, p1.etag);
      assert.equal(p2.unchanged, true);
      assert.equal(p2.etag, p1.etag);

      // Wait for async LLM translation to complete -> etag bumps and Poll 3 gets Chinese
      const p3 = await waitFor(async () => {
        const res = await fetchSwarm(sidecar1.port, CONV_ID, p1.etag);
        if (
          !res.unchanged &&
          res.translationState?.pending === 0 &&
          res.messages?.[0]?.text_zh_source === 'llm' &&
          res.view_zh?.headline?.startsWith('中文:')
        ) {
          return res;
        }
        return null;
      }, 6000, 60);

      assert.notEqual(p3.etag, p1.etag);
      assert.equal(p3.messages[0].text_zh_pending, false);
      assert.equal(p3.messages[0].text_zh_source, 'llm');
      assert.ok(p3.messages[0].text_zh.includes('@worker1'));
      assert.ok(p3.messages[0].text_zh.includes('`main.mjs`'));
      assert.ok(p3.messages[0].text_zh.includes('#1'));
      assert.ok(p3.title_zh.startsWith('中文:'));
      assert.ok(p3.plan_zh.goal.startsWith('中文:'));
      assert.ok(p3.frames[0].caption_zh.startsWith('中文:'));
      const w1After = p3.members.find((m) => m.name === 'worker1');
      assert.ok(w1After.title_zh.startsWith('中文:'));
      assert.ok(llmHits > 0);

      // Stop sidecar 1 gracefully (SIGTERM flushes translation_cache.json)
      await stopChild(sidecar1.child);
      sidecar1 = null;

      const cacheFile = path.join(dataDir, 'translation_cache.json');
      assert.equal(fs.existsSync(cacheFile), true);

      // Verify strict read-only invariance of swarm files on disk
      assert.equal(sha256File(membersPath), hashesBefore.members);
      assert.equal(sha256File(boardPath), hashesBefore.board);
      assert.equal(sha256File(viewPath), hashesBefore.view);
      assert.equal(sha256File(planPath), hashesBefore.plan);

      // Restart sidecar 2 with LLM disabled -> hits disk cache immediately
      sidecar2 = await spawnSidecar({
        ANTIGRAVITY_EXECUTABLE_DATA_DIR: dataDir,
        AGY_SWARM_TRANSLATE_DISABLED: '1',
      });
      const pRestart = await fetchSwarm(sidecar2.port, CONV_ID, '');
      assert.equal(pRestart.translationState.enabled, false);
      assert.equal(pRestart.messages[0].text_zh_source, 'cache');
      assert.equal(pRestart.messages[0].text_zh, p3.messages[0].text_zh);
      assert.equal(pRestart.title_zh, p3.title_zh);
    } finally {
      if (sidecar1?.child) await stopChild(sidecar1.child);
      if (sidecar2?.child) await stopChild(sidecar2.child);
      await mockLlm.close();
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  test('/api/swarm stays < 150ms on 50KB adversarial thinkingHeading, SHOT_RE, RE_WIN_REL, and CHANNEL_TOPIC_* inputs', async () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-main-redos-'));
    const dataDir = path.join(tmpRoot, 'app_data', 'sidecar_data', 'swarm', 'swarm_board', 'data');
    const swarmDir = path.join(tmpRoot, 'app_data', 'brain', CONV_ID, '.system_generated', 'swarm');
    const workerLogDir = path.join(tmpRoot, 'app_data', 'brain', WORKER_CONV, '.system_generated', 'logs');
    fs.mkdirSync(dataDir, { recursive: true });
    fs.mkdirSync(swarmDir, { recursive: true });
    fs.mkdirSync(workerLogDir, { recursive: true });

    fs.writeFileSync(path.join(swarmDir, 'members.json'), JSON.stringify({
      title: 'Swarm 50KB ReDoS Probe',
      members: {
        coordinator: { conversation_id: CONV_ID, role: 'coordinator', wake_mode: 'mentions' },
        worker1: { conversation_id: WORKER_CONV, role: 'worker', wake_mode: 'working' },
      },
    }), 'utf-8');

    // Seed transcript with 50KB newlines in thinking (exercises main.mjs thinkingHeading)
    fs.writeFileSync(path.join(workerLogDir, 'transcript.jsonl'), JSON.stringify({
      type: 'PLANNER_RESPONSE',
      step_index: 1,
      thinking: '\n'.repeat(50000) + '!',
      tool_calls: [{ name: 'read_file', args: { Path: '"f:\\\\proj\\\\app.js"' } }],
    }) + '\n', 'utf-8');

    // Seed board.jsonl with 50KB SHOT_RE, RE_WIN_REL, and CHANNEL_TOPIC_* adversarial lines
    const boardLines = [
      JSON.stringify({ seq: 1, agent: 'worker1', text: 'Screenshot: /a.png' + ' '.repeat(50000) + '!', time: '2026-11-19 10:00:00' }),
      JSON.stringify({ seq: 2, agent: 'worker1', text: '\n'.repeat(50000) + '!', time: '2026-11-19 10:00:01' }),
      JSON.stringify({ seq: 3, agent: 'worker1', text: 'Screenshot:' + '\n'.repeat(50000) + '!', time: '2026-11-19 10:00:02' }),
      JSON.stringify({ seq: 4, agent: 'worker1', text: 'a.'.repeat(25000) + 'xyz!', time: '2026-11-19 10:00:03' }),
      JSON.stringify({ seq: 5, agent: 'coordinator', text: '[channel] created #ch : ' + ' '.repeat(50000) + '\n!\n!', control: { op: 'create', channel: 'ch' }, time: '2026-11-19 10:00:04' }),
      JSON.stringify({ seq: 6, agent: 'worker1', text: 'Screenshot: /frames/ok.png |   valid caption   ', time: '2026-11-19 10:00:05' }),
    ];
    fs.writeFileSync(path.join(swarmDir, 'board.jsonl'), boardLines.join('\n') + '\n', 'utf-8');

    let sidecar = null;
    try {
      sidecar = await spawnSidecar({
        ANTIGRAVITY_EXECUTABLE_DATA_DIR: dataDir,
        AGY_SWARM_TRANSLATE_DISABLED: '1',
      });

      const t0 = performance.now();
      const snap = await fetchSwarm(sidecar.port, CONV_ID, '');
      const elapsed = performance.now() - t0;

      assert.equal(snap.swarm, CONV_ID);
      assert.equal(snap.messages.length, 6);
      assert.equal(snap.frames.length, 1);
      assert.equal(snap.frames[0].caption, 'valid caption');
      assert.ok(elapsed < 150, `Expected /api/swarm 50KB adversarial latency < 150ms, took ${elapsed.toFixed(2)}ms`);
    } finally {
      if (sidecar?.child) await stopChild(sidecar.child);
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  test('/api/swarm bumps etag on LLM failure (delivering Tier-1 partial) and recovers after cooldown expiry', async () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-main-fail-etag-'));
    const dataDir = path.join(tmpRoot, 'app_data', 'sidecar_data', 'swarm', 'swarm_board', 'data');
    const swarmDir = path.join(tmpRoot, 'app_data', 'brain', CONV_ID, '.system_generated', 'swarm');
    fs.mkdirSync(dataDir, { recursive: true });
    fs.mkdirSync(swarmDir, { recursive: true });

    fs.writeFileSync(path.join(swarmDir, 'members.json'), JSON.stringify({
      title: 'Swarm Failure Etag Recovery',
      members: {
        coordinator: { conversation_id: CONV_ID, role: 'coordinator', wake_mode: 'mentions' },
        worker: { conversation_id: WORKER_CONV, role: 'worker', wake_mode: 'working' },
      },
    }), 'utf-8');
    fs.writeFileSync(
      path.join(swarmDir, 'board.jsonl'),
      JSON.stringify({
        seq: 1,
        agent: 'worker',
        text: '@coordinator [done] Please verify this critical report now.',
        time: '2026-11-19 10:00:00',
      }) + '\n',
      'utf-8',
    );

    let mode = '500';
    const mockLlm = await startHttpServer(async (req, res) => {
      if (req.url === '/v1/chat/completions' && req.method === 'POST') {
        const body = await readJsonBody(req);
        if (mode === '500') {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'temporary outage' }));
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ choices: [{ message: { content: `中文:${body.messages[1].content}` } }] }));
        return;
      }
      res.writeHead(404);
      res.end();
    });

    let sidecar = null;
    try {
      sidecar = await spawnSidecar({
        ANTIGRAVITY_EXECUTABLE_DATA_DIR: dataDir,
        AGY_SWARM_TRANSLATE_BASE_URL: `${mockLlm.url}/v1`,
        AGY_SWARM_TRANSLATE_API_KEY: 'test-key',
        AGY_SWARM_TRANSLATE_MODEL: 'mock-fast',
        AGY_SWARM_TRANSLATE_BACKOFF_MS: '15',
        AGY_SWARM_TRANSLATE_COOLDOWN_MS: '250',
      });

      const p1 = await fetchSwarm(sidecar.port, CONV_ID, '');
      assert.ok(p1.translationState.pending >= 1);
      assert.equal(p1.messages[0].text_zh_pending, true);
      assert.equal(p1.messages[0].text_zh, null);

      // Wait until retries fail and etag bumps with Tier-1 partial translation
      const p2 = await waitFor(async () => {
        const res = await fetchSwarm(sidecar.port, CONV_ID, p1.etag);
        if (!res.unchanged && res.translationState?.pending === 0 && res.translationState?.failed >= 1) {
          return res;
        }
        return null;
      }, 4000, 30);

      assert.notEqual(p2.etag, p1.etag);
      assert.equal(p2.messages[0].text_zh_pending, false);
      assert.equal(p2.messages[0].text_zh_source, 'rule');
      assert.ok(p2.messages[0].text_zh.startsWith('@coordinator [已完成]'));

      // Switch mock LLM to 200 OK and wait for cooldown expiry -> idle swarm must retry & deliver LLM translation
      mode = '200';
      const p3 = await waitFor(async () => {
        const res = await fetchSwarm(sidecar.port, CONV_ID, p2.etag);
        if (!res.unchanged && res.messages?.[0]?.text_zh_source === 'llm') {
          return res;
        }
        return null;
      }, 4000, 50);

      assert.notEqual(p3.etag, p2.etag);
      assert.equal(p3.messages[0].text_zh_source, 'llm');
      assert.ok(p3.messages[0].text_zh.includes('[已完成]'));
    } finally {
      if (sidecar?.child) await stopChild(sidecar.child);
      await mockLlm.close();
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  });
});
