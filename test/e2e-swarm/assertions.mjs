import assert from 'node:assert/strict';

export const CJK_RE = /[\u4e00-\u9fff]/;

export const FORBIDDEN_EN_UI_PHRASES = [
  'Looking for this conversation',
  'Updates automatically',
  'Lost contact with the swarm sidecar',
  'From anyone',
  'To anyone',
  'To no one',
  'All channels',
  'all channels',
  'Search members',
  'Standing by',
  'Waiting for the first update',
  'Waiting for posts',
  'No posts yet',
  'Your swarm is starting',
  'Want this view different? Tell the coordinator.',
  'Open coordinator chat',
  'No narrator in this swarm.',
  'Showing the last good view.json',
  'Click a link in the view to open it.',
  'Hide inactive',
  'Expand @all',
  'Even pacing',
  'Real-time gaps',
  'Copy to clipboard',
  'No swarm in this conversation',
  'Watching for a swarm',
  'Untitled swarm',
  'Show more',
  'Show less',
  'Reconnecting',
  'Working',
  'Stuck',
  'Error',
  'Retired',
  'Waiting on ',
  'last seen',
  'Runs on',
  'Nothing matches',
  'Clear filters',
  '(archived)',
  "Narrator's page",
  'Plain view',
];

export function hasChinese(str) {
  return CJK_RE.test(String(str || ''));
}

export function assertHasChinese(str, label = 'rendered text') {
  assert.ok(
    hasChinese(str),
    `${label}: expected Chinese characters ([\\u4e00-\\u9fff]), got: ${JSON.stringify(String(str || '').slice(0, 200))}`
  );
}

export function assertEveryHasChinese(items, label = 'rendered items') {
  assert.ok(Array.isArray(items) && items.length > 0, `${label}: expected non-empty array of items`);
  for (let i = 0; i < items.length; i++) {
    assertHasChinese(items[i], `${label}[${i}]`);
  }
}

function stripTechnicalLiteralsForComparison(text) {
  return String(text || '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`[^`\n]+`/g, ' ')
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/(?:[A-Za-z]:\\|\/(?:[\w.-]+\/)+)\S*/g, ' ')
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, ' ')
    .replace(/@#?[A-Za-z0-9_.-]+/g, ' ')
    .replace(/#[1-9]\d*\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function extractEnglishProseWords(text) {
  const withoutFiles = String(text || '').replace(/\b[A-Za-z0-9_-]+\.[A-Za-z0-9]{1,6}\b/g, ' ');
  const matches = withoutFiles.match(/\b[A-Za-z]{2,}(?:['’-][A-Za-z]+)*\b/g) || [];
  return matches.filter((w) => !/^[A-Z]{2,}$/.test(w));
}

export function assertTranslatedFrom(actual, originalEnglish, label = 'translated text') {
  const act = String(actual || '').trim();
  const orig = String(originalEnglish || '').trim();
  assertHasChinese(act, label);
  assert.notEqual(act, orig, `${label}: rendered text is identical to original English`);

  // Detect trivial prefix-only fakes (e.g. "自动翻译结果如下：" + original, "[译]" + original, "注：" + original, "[已完成] " + original, "系统提示 - " + original, "（译）" + original)
  const strippedAct = act
    .replace(/^(?:(?:[\u4e00-\u9fff]{1,20}\s*[-—–:：]|\[[\u4e00-\u9fff]{1,10}\](?:\s*[-—–:：])?|【[\u4e00-\u9fff]{1,10}】(?:\s*[-—–:：])?|\([\u4e00-\u9fff]{1,10}\)(?:\s*[-—–:：])?|（[\u4e00-\u9fff]{1,10}）(?:\s*[-—–:：])?)\s*)+/i, '')
    .trim();
  const strippedOrig = orig
    .replace(/^\[(?:done|blocked|stall|quota|channel)\]\s*/i, '')
    .trim();
  assert.notEqual(
    strippedAct,
    strippedOrig,
    `${label}: translation only prepended a trivial prefix before verbatim English`
  );

  // Also check stripped non-literal prose (ignoring leading @mentions stripped by board UI)
  const actProse = stripTechnicalLiteralsForComparison(strippedAct);
  const origProse = stripTechnicalLiteralsForComparison(strippedOrig);
  const origAlphaWords = extractEnglishProseWords(origProse);

  if (origProse.length >= 4 || origAlphaWords.length >= 1) {
    assert.notEqual(
      actProse,
      origProse,
      `${label}: non-literal English prose remained verbatim unchanged`
    );
    // Count Chinese characters that did not exist in originalEnglish
    const actCjk = (actProse.match(/[\u4e00-\u9fff]/g) || []).length;
    const origCjk = (origProse.match(/[\u4e00-\u9fff]/g) || []).length;
    if (origAlphaWords.length >= 1) {
      if (origCjk === 0) {
        assert.ok(
          actCjk > origCjk,
          `${label}: expected Chinese character count to increase over original (${actCjk} <= ${origCjk})`
        );
      } else {
        assert.ok(
          actCjk > 0 && (actCjk > origCjk || actProse !== origProse),
          `${label}: mixed-CJK text remained untranslated (${actCjk} <= ${origCjk})`
        );
      }
    }

    // Ensure multi-word English prose clauses (including digits/hyphens/apostrophes, e.g. "2 of 5 checks done")
    // did not survive verbatim
    const actForProseCheck = actProse.replace(/术语\[[^\]]+\]/g, ' ').replace(/\s+/g, ' ').trim();
    if (origAlphaWords.length >= 1) {
      assert.notEqual(
        actForProseCheck,
        origProse,
        `${label}: English prose remained verbatim after stripping prefix`
      );
    }

    const clauses = origProse.match(/\b[A-Za-z0-9]+(?:['’-][A-Za-z0-9]+)*(?:\s+[A-Za-z0-9]+(?:['’-][A-Za-z0-9]+)*){2,}\b/g) || [];
    const actProseLower = actForProseCheck.toLowerCase();
    for (const clause of clauses) {
      const words = clause.split(/\s+/);
      for (let i = 0; i <= words.length - 3; i++) {
        const subClause = words.slice(i, i + 3).join(' ');
        const subAlpha = extractEnglishProseWords(subClause);
        if (subClause.length >= 10 && subAlpha.length >= 3) {
          assert.ok(
            !actProseLower.includes(subClause.toLowerCase()),
            `${label}: untranslated English prose clause remained verbatim: ${JSON.stringify(subClause)}`
          );
        }
      }
    }

    // Reject 1-2 word English prose surviving verbatim (even when prefixed or embedded, case-insensitive)
    if (origAlphaWords.length >= 1 && origAlphaWords.length <= 2) {
      const actWords = new Set(extractEnglishProseWords(actForProseCheck).map((w) => w.toLowerCase()));
      const retained = origAlphaWords.filter((w) => actWords.has(w.toLowerCase()));
      if (
        retained.length === origAlphaWords.length &&
        (actProseLower.includes(origProse.toLowerCase()) || origCjk === 0)
      ) {
        assert.fail(`${label}: untranslated short English prose remained verbatim: ${JSON.stringify(origProse)}`);
      }
    }

    // Reject 2-word English prose clauses remaining verbatim in short (<=3-word) originals
    if (origAlphaWords.length >= 2 && origAlphaWords.length <= 3) {
      const twoWordClauses = origProse.match(/\b[A-Za-z]{2,}\s+[A-Za-z]{2,}\b/g) || [];
      for (const cl of twoWordClauses) {
        if (extractEnglishProseWords(cl).length === 2 && actProseLower.includes(cl.toLowerCase())) {
          assert.fail(`${label}: 2-word English prose clause remained verbatim: ${JSON.stringify(cl)}`);
        }
      }
    }

    // High untranslated ASCII-word retention check
    if (origAlphaWords.length >= 2) {
      const actWords = new Set(extractEnglishProseWords(actForProseCheck).map((w) => w.toLowerCase()));
      const retained = origAlphaWords.filter((w) => actWords.has(w.toLowerCase()));
      const ratio = retained.length / origAlphaWords.length;
      const highRetention =
        origAlphaWords.length <= 4
          ? (retained.length >= 2 && ratio >= 0.5)
          : (retained.length >= 3 && ratio >= 0.4);
      assert.ok(
        !highRetention,
        `${label}: high untranslated English word retention (${retained.length}/${origAlphaWords.length}): ${JSON.stringify(retained.slice(0, 8))}`
      );
    }
  }
}

export function assertNoUntranslatedUiStrings(text, phrases = FORBIDDEN_EN_UI_PHRASES, label = 'UI text') {
  const hay = String(text || '');
  for (const phrase of phrases) {
    assert.ok(
      !hay.includes(phrase),
      `${label}: found untranslated English UI string ${JSON.stringify(phrase)}`
    );
  }
}

export function assertLiteralsPreserved(renderedText, expectedLiterals, label = 'rendered message') {
  const text = String(renderedText || '');
  for (const lit of expectedLiterals) {
    assert.ok(
      text.includes(lit),
      `${label}: expected technical literal ${JSON.stringify(lit)} to be preserved verbatim, got: ${JSON.stringify(text.slice(0, 300))}`
    );
  }
}

export function assertSnapshotContract(snap) {
  assert.ok(snap && typeof snap === 'object', 'snapshot must be an object');
  assert.ok(typeof snap.id === 'string' && snap.id.length > 0, 'snap.id must be a non-empty string');
  assert.ok(Array.isArray(snap.members), 'snap.members on /api/swarm must be an Array');
  assert.ok(Array.isArray(snap.messages), 'snap.messages must be an Array');
  assert.ok(typeof snap.etag === 'string' && snap.etag.length > 0, 'snap.etag must be a non-empty string');
}

export async function getLangModeState(page) {
  return page.evaluate(() => {
    const btn = document.querySelector('[data-testid="swarm-lang-mode"], #lang-mode');
    return {
      exists: !!btn,
      stored: localStorage.getItem('swarm.langMode'),
    };
  });
}

export function assertLangModeAbsent(state, label = 'lang mode toggle') {
  assert.ok(state && !state.exists, `${label}: expected [data-testid="swarm-lang-mode"] to be removed from header`);
}
