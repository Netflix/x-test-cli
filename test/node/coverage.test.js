import { suite, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { XTestCliCoverage } from '../../x-test-cli-coverage.js';
import { dedent } from './common.js';

/** Build a V8-shaped entry (Puppeteer post-normalization). `kind` is
 *  set explicitly because the production code requires it — there is no
 *  silent default in `#filterAndMerge` or `computeLineHits`. CSS-shaped
 *  fixtures pass `kind: 'css'` directly inline. */
function entry(url, text, ranges) {
  return { url, text, ranges, kind: 'js' };
}

/** Cover the entire text with one range — useful for "all hit" fixtures. */
function all(text) {
  return [{ start: 0, end: text.length }];
}

suite('XTestCliCoverage.computeLineHits — classification', () => {
  test('all bytes covered → every non-blank line classified full', () => {
    const text = 'const a = 1;\nconst b = 2;';
    const hits = XTestCliCoverage.computeLineHits(entry('u', text, all(text)));
    assert(hits.total === 2);
    assert(hits.covered === 2);
    assert(hits.hitMap.get(1) === 'full');
    assert(hits.hitMap.get(2) === 'full');
  });

  test('half a non-blank line uncovered → partial (not counted toward strict covered)', () => {
    const text = 'abc def';                            // Non-WS: 0,1,2,4,5,6
    const ranges = [{ start: 0, end: 3 }];             // Covers "abc" only.
    const hits = XTestCliCoverage.computeLineHits(entry('u', text, ranges));
    assert(hits.total === 1);
    assert(hits.covered === 0);
    assert(hits.hitMap.get(1) === 'partial');
  });

  test('no bytes covered → none', () => {
    const text = 'abc';
    const hits = XTestCliCoverage.computeLineHits(entry('u', text, []));
    assert(hits.total === 1);
    assert(hits.covered === 0);
    assert(hits.hitMap.get(1) === 'none');
  });

  test('whitespace gaps in coverage are tolerated (still full)', () => {
    const text = 'abc def';                            // Space at index 3.
    const ranges = [{ start: 0, end: 3 }, { start: 4, end: 7 }]; // Skip the space.
    const hits = XTestCliCoverage.computeLineHits(entry('u', text, ranges));
    assert(hits.total === 1);
    assert(hits.covered === 1);
    assert(hits.hitMap.get(1) === 'full');
  });

  test('blank/whitespace-only lines excluded from denominator', () => {
    const text = 'const a = 1;\n\n   \nconst b = 2;';
    const hits = XTestCliCoverage.computeLineHits(entry('u', text, all(text)));
    assert(hits.total === 2);                          // Lines 2 and 3 dropped.
    assert(hits.covered === 2);
  });

  test('handles \\r\\n line endings', () => {
    const text = 'a;\r\nb;\r\nc;';
    const hits = XTestCliCoverage.computeLineHits(entry('u', text, all(text)));
    assert(hits.total === 3);
    assert(hits.covered === 3);
  });
});

suite('XTestCliCoverage.computeLineHits — pragmas', () => {
  test('ignore next — excludes exactly one line', () => {
    const text = [
      'a;',                                            // Line 1.
      '/* x-test:coverage ignore next */',             // Line 2 — pragma, ignored.
      'b;',                                            // Line 3 — ignored by counter.
      'c;',                                            // Line 4 — counts again.
    ].join('\n');
    // Cover the first line only.
    const ranges = [{ start: 0, end: 2 }];
    const hits = XTestCliCoverage.computeLineHits(entry('u', text, ranges));
    assert(hits.total === 2);                          // Lines 1 and 4 — pragma and line-3 dropped.
    assert(hits.covered === 1);                        // Only line 1 is hit.
  });

  test('ignore next 3 — excludes three lines', () => {
    const text = [
      'a;',                                            // Line 1.
      '/* x-test:coverage ignore next 3 */',           // Line 2 — pragma.
      'b;', 'c;', 'd;',                                // Lines 3–5 — ignored.
      'e;',                                            // Line 6 — counts again.
    ].join('\n');
    const hits = XTestCliCoverage.computeLineHits(entry('u', text, all(text)));
    assert(hits.total === 2);                          // Lines 1, 6.
    assert(hits.covered === 2);
  });

  test('disable/enable — excludes the region in between', () => {
    const text = [
      'a;',                                            // Line 1 — counts.
      '/* x-test:coverage disable */',                 // Line 2 — pragma.
      'b;', 'c;',                                      // Lines 3–4 — ignored.
      '/* x-test:coverage enable */',                  // Line 5 — pragma.
      'd;',                                            // Line 6 — counts.
    ].join('\n');
    const hits = XTestCliCoverage.computeLineHits(entry('u', text, all(text)));
    assert(hits.total === 2);                          // Lines 1, 6.
    assert(hits.covered === 2);
  });

  test('disable inside ignore next N does not double-decrement the counter', () => {
    const text = [
      '/* x-test:coverage ignore next 3 */',           // Line 1 — pragma.
      'a;',                                            // Line 2 — ignored by counter (3 → 2).
      '/* x-test:coverage disable */',                 // Line 3 — pragma (counter NOT decremented).
      'b;',                                            // Line 4 — ignored by counter (2 → 1) AND by disable.
      'c;',                                            // Line 5 — ignored by counter (1 → 0) AND by disable.
      '/* x-test:coverage enable */',                  // Line 6 — pragma (counter is 0).
      'd;',                                            // Line 7 — counts again.
    ].join('\n');
    const hits = XTestCliCoverage.computeLineHits(entry('u', text, all(text)));
    assert(hits.total === 1);                          // Only line 7.
    assert(hits.covered === 1);
  });
});

suite('XTestCliCoverage.gradeCoverage', () => {
  const baseUrl = 'http://host/';

  test('all goals met → ok: true', () => {
    const text = 'a;\nb;\nc;';
    const entries = [entry('http://host/src/a.js', text, all(text))];
    const result = XTestCliCoverage.gradeCoverage({
      entries,
      baseUrl,
      goals:   { './src/a.js': { lines: 100 } },
    });
    assert(result.ok === true);
    assert(result.results.length === 1);
    assert(result.results[0].lines.met === true);
    assert(result.results[0].lines.percent === 100);
    assert(result.results[0].lines.missing === false);
  });

  test('goal above percent → not met, overall not ok', () => {
    const text = 'a;\nb;';
    // Cover only line 1 (indices 0..2 — "a;" then newline at 2).
    const entries = [entry('http://host/src/a.js', text, [{ start: 0, end: 2 }])];
    const result = XTestCliCoverage.gradeCoverage({
      entries,
      baseUrl,
      goals:   { './src/a.js': { lines: 100 } },
    });
    assert(result.ok === false);
    assert(result.results[0].lines.met === false);
    assert(result.results[0].lines.percent === 50);
  });

  test('missing goal file → row flagged missing, not met', () => {
    const result = XTestCliCoverage.gradeCoverage({
      entries: [],
      baseUrl,
      goals:   { './src/missing.js': { lines: 80 } },
    });
    assert(result.ok === false);
    assert(result.results[0].lines.missing === true);
    assert(result.results[0].lines.met === false);
    assert(result.results[0].lines.goal === 80);
  });

  test('percent uses two-decimal rounding', () => {
    const text = 'a;\nb;\nc;';                         // 3 countable lines.
    // Cover only line 1 → 1/3 = 33.33… → 33.33.
    const entries = [entry('http://host/src/a.js', text, [{ start: 0, end: 2 }])];
    const result = XTestCliCoverage.gradeCoverage({
      entries,
      baseUrl,
      goals:   { './src/a.js': { lines: 30 } },
    });
    assert(result.results[0].lines.percent === 33.33);
    assert(result.results[0].lines.met === true);
  });
});

suite('XTestCliCoverage.synthesizeMissingEntries', () => {
  let dir;

  before(async () => {
    dir = await mkdtemp(join(tmpdir(), 'x-test-cli-syn-'));
    const { writeFile, mkdir } = await import('node:fs/promises');
    await mkdir(join(dir, 'src'), { recursive: true });
    await writeFile(join(dir, 'src/onDisk.js'), 'const a = 1;\nconst b = 2;');
  });
  after(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test('returns synthetic entries for goals on disk but not in entries', async () => {
    const synthetic = await XTestCliCoverage.synthesizeMissingEntries({
      entries: [],
      baseUrl: 'http://host/',
      sourceRoot: dir,
      goals:   { './src/onDisk.js': { lines: 80 } },
    });
    assert(synthetic.length === 1);
    assert(synthetic[0].url === 'http://host/src/onDisk.js');
    assert(synthetic[0].ranges.length === 0);
    assert(synthetic[0].text === 'const a = 1;\nconst b = 2;');
  });

  test('skips goals already present in entries', async () => {
    const existing = {
      url: 'http://host/src/onDisk.js',
      text: 'const a = 1;',
      ranges: [{ start: 0, end: 12 }],
    };
    const synthetic = await XTestCliCoverage.synthesizeMissingEntries({
      entries: [existing],
      baseUrl: 'http://host/',
      sourceRoot: dir,
      goals:   { './src/onDisk.js': { lines: 80 } },
    });
    assert(synthetic.length === 0);
  });

  test('silently skips goals that are not on disk either', async () => {
    const synthetic = await XTestCliCoverage.synthesizeMissingEntries({
      entries: [],
      baseUrl: 'http://host/',
      sourceRoot: dir,
      goals:   { './src/does-not-exist.js': { lines: 80 } },
    });
    assert(synthetic.length === 0);
  });

  test('synthetic entries grade as 0/N not ok and flow into lcov', async () => {
    const synthetic = await XTestCliCoverage.synthesizeMissingEntries({
      entries: [],
      baseUrl: 'http://host/',
      sourceRoot: dir,
      goals:   { './src/onDisk.js': { lines: 80 } },
    });
    const graded = XTestCliCoverage.gradeCoverage({
      entries: synthetic,
      baseUrl: 'http://host/',
      goals:   { './src/onDisk.js': { lines: 80 } },
    });
    assert(graded.ok === false);
    assert(graded.results[0].lines.missing === false);
    assert(graded.results[0].lines.covered === 0);
    assert(graded.results[0].lines.total === 2);
    assert(graded.results[0].lines.percent === 0);
    assert(graded.results[0].lines.met === false);
  });
});

suite('XTestCliCoverage.writeLcov', () => {
  // `writeLcov` requires baseUrl + sourceRoot; production always supplies
  //  both. `sourceRoot` of '/' makes URL paths like '/x.js' decode + strip
  //  to 'x.js', which is what the SF assertions below expect.
  const baseUrl    = 'http://host/';
  const sourceRoot = '/';
  let dir;

  before(async () => {
    dir = await mkdtemp(join(tmpdir(), 'x-test-cli-lcov-'));
  });
  after(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test('writes TN/SF/DA/LF/LH/end_of_record in order, skipping blanks and pragmas', async () => {
    const text = [
      'a;',                                            // Line 1 — covered.
      '',                                              // Line 2 — blank, dropped.
      '/* x-test:coverage ignore next */',             // Line 3 — pragma, dropped.
      'b;',                                            // Line 4 — ignored, dropped.
      'c;',                                            // Line 5 — covered.
    ].join('\n');
    const entries = [entry('http://host/x.js', text, all(text))];
    const written = await XTestCliCoverage.writeLcov({ entries, outDir: dir, baseUrl, sourceRoot });
    const body = await readFile(written, 'utf8');
    const expected = [
      'TN:',
      'SF:x.js',
      'DA:1,1',
      'DA:5,1',
      'LF:2',
      'LH:2',
      'end_of_record',
      '',
    ].join('\n');
    assert(body === expected);
  });

  test('multiple entries → multiple records', async () => {
    const a = entry('http://host/a.js', 'x;', all('x;'));
    const b = entry('http://host/b.js', 'y;', all('y;'));
    const written = await XTestCliCoverage.writeLcov({ entries: [a, b], outDir: dir, baseUrl, sourceRoot });
    const body = await readFile(written, 'utf8');
    const records = body.split('end_of_record\n').filter(s => s !== '');
    assert(records.length === 2);
    assert(records[0] === dedent`
      TN:
      SF:a.js
      DA:1,1
      LF:1
      LH:1
    `);
    assert(records[1] === dedent`
      TN:
      SF:b.js
      DA:1,1
      LF:1
      LH:1
    `);
  });

  test('goals filter restricts lcov to configured files only', async () => {
    const targeted   = entry('http://host/src/app.js',  'x;', all('x;'));
    const untargeted = entry('http://host/test/t.html', 'y;', all('y;'));
    const written = await XTestCliCoverage.writeLcov({
      entries: [targeted, untargeted],
      outDir:  dir,
      baseUrl,
      sourceRoot,
      goals:   { './src/app.js': { lines: 50 } },
    });
    const body = await readFile(written, 'utf8');
    assert(body.includes('SF:src/app.js\n'));
    assert(body.includes('test/t.html') === false);
  });

  test('duplicate-URL entries are merged into one record with unioned ranges', async () => {
    const text = 'a;\nb;\nc;';
    // Two "executions" of the same URL: first covers line 1; second covers
    //  lines 2+3. Merged result: all three lines are covered.
    const first  = entry('http://host/x.js', text, [{ start: 0, end: 2 }]);
    const second = entry('http://host/x.js', text, [{ start: 3, end: 8 }]);
    const written = await XTestCliCoverage.writeLcov({
      entries: [first, second],
      outDir:  dir,
      baseUrl,
      sourceRoot,
      goals:   { './x.js': { lines: 100 } },
    });
    const body = await readFile(written, 'utf8');
    const records = body.split('end_of_record').filter(s => s.trim() !== '');
    assert(records.length === 1);
    assert(body.includes('LF:3\n'));
    assert(body.includes('LH:3\n'));
  });

  test('uncovered line records DA:N,0', async () => {
    const text = 'a;\nb;';
    // Cover only line 1.
    const entries = [entry('http://host/p.js', text, [{ start: 0, end: 2 }])];
    const written = await XTestCliCoverage.writeLcov({ entries, outDir: dir, baseUrl, sourceRoot });
    const body = await readFile(written, 'utf8');
    assert(body.includes('DA:1,1'));
    assert(body.includes('DA:2,0'));
    assert(body.includes('LF:2'));
    assert(body.includes('LH:1'));
    // Two-state file — no BRDA/BRF/BRH.
    assert(body.includes('BRDA:') === false);
    assert(body.includes('BRF:')  === false);
  });

  test('partial line → DA:N,1 plus synthesized BRDA pair', async () => {
    const text = 'abc def';                            // One line; "abc" covered, "def" not.
    const entries = [entry('http://host/partial.js', text, [{ start: 0, end: 3 }])];
    const written = await XTestCliCoverage.writeLcov({ entries, outDir: dir, baseUrl, sourceRoot });
    const body = await readFile(written, 'utf8');
    assert(body.includes('DA:1,1\n'));                 // Hit in lcov terms.
    assert(body.includes('BRDA:1,0,0,1\n'));           // Synthesized "taken" branch.
    assert(body.includes('BRDA:1,0,1,0\n'));           // Synthesized "not taken" branch.
    assert(body.includes('BRF:2\n'));
    assert(body.includes('BRH:1\n'));
    // LH counts any-coverage (the lcov convention), so the partial line
    //  contributes. The strict percentage reported in the TAP summary is
    //  independent — covered by gradeCoverage tests above.
    assert(body.includes('LF:1\n'));
    assert(body.includes('LH:1\n'));
  });

  test('fully-covered file has no BRDA records', async () => {
    const text = 'const x = 1;';
    const entries = [entry('http://host/clean.js', text, all(text))];
    const written = await XTestCliCoverage.writeLcov({ entries, outDir: dir, baseUrl, sourceRoot });
    const body = await readFile(written, 'utf8');
    assert(body.includes('BRDA:') === false);
    assert(body.includes('BRF:')  === false);
    assert(body.includes('BRH:')  === false);
  });

  test('SF resolves in-origin URLs to paths relative to sourceRoot', async () => {
    const entries = [entry('http://host:8080/src/a.js', 'x;', all('x;'))];
    const written = await XTestCliCoverage.writeLcov({
      entries,
      outDir: dir,
      baseUrl: 'http://host:8080/',
      sourceRoot: '/project/root',
    });
    const body = await readFile(written, 'utf8');
    assert(body.includes('SF:src/a.js\n'));
  });

  test('SF decodes percent-escapes in the pathname', async () => {
    const entries = [entry('http://host/src/a%20b.js', 'x;', all('x;'))];
    const written = await XTestCliCoverage.writeLcov({
      entries,
      outDir: dir,
      baseUrl: 'http://host/',
      sourceRoot: '/root',
    });
    const body = await readFile(written, 'utf8');
    assert(body.includes('SF:src/a b.js\n'));
  });
});

suite('XTestCliCoverage — CSS coverage entries', () => {
  // CSS coverage entries arrive in the same `{url, text, ranges}` shape as JS
  //  (after each driver's normalization) — only the `kind` tag distinguishes
  //  them. The line-hit / grading / lcov pipeline is language-agnostic, so
  //  these tests verify it works end-to-end on CSS-shaped input and on the
  //  edge case where a single URL has both JS and CSS entries.

  test('computeLineHits classifies a CSS file like any other', () => {
    const text = 'a { color: red; }\nb { color: blue; }';
    const ranges = [{ start: 0, end: 17 }];                // First rule only.
    const hits = XTestCliCoverage.computeLineHits({ url: 'u', text, ranges, kind: 'css' });
    assert(hits.total   === 2);
    assert(hits.covered === 1);
    assert(hits.hitMap.get(1) === 'full');
    assert(hits.hitMap.get(2) === 'none');
  });

  test('gradeCoverage scores a CSS goal', () => {
    const text = 'a { color: red; }\nb { color: blue; }';
    const entries = [{
      url: 'http://host/src/styles.css',
      text,
      ranges: [{ start: 0, end: 17 }],
      kind: 'css',
    }];
    const result = XTestCliCoverage.gradeCoverage({
      entries,
      baseUrl: 'http://host/',
      goals:  { './src/styles.css': { lines: 50 } },
    });
    assert(result.ok === true);
    assert(result.results[0].lines.percent === 50);
    assert(result.results[0].lines.met     === true);
  });

  test('CSS block-comment lines are stripped from the denominator', () => {
    // Header comment + two rules. With comment-stripping, only the rule
    //  lines count toward the total. CSS rule-usage tracking marks the
    //  matched rule's bytes as covered, so coverage = matched-rule lines /
    //  all-rule lines = 50%.
    const text = [
      '/* a multi-line',                                 // Comment-only — dropped.
      '   header comment',                               // Comment-only — dropped.
      '   describing this file. */',                     // Comment-only — dropped.
      'h1 {',                                            // Counts. Matched rule.
      '  color: red;',                                   // Counts. Matched rule.
      '}',                                               // Counts. Matched rule.
      '.unused {',                                       // Counts. Unmatched rule.
      '  color: blue;',                                  // Counts. Unmatched rule.
      '}',                                               // Counts. Unmatched rule.
    ].join('\n');
    const ranges = [{ start: 0, end: text.indexOf('.unused') }]; // h1 rule only.
    const hits = XTestCliCoverage.computeLineHits({ url: 'u', text, ranges, kind: 'css' });
    assert(hits.total   === 6);                          // 3 + 3, comment lines stripped.
    assert(hits.covered === 3);                          // Matched rule's lines.
  });

  test('JS comment lines still count (V8 already covers them)', () => {
    // Symmetry check: the comment-stripping pass is CSS-only. A JS file
    //  with a comment-only line that happens to be uncovered should
    //  remain in the denominator.
    const text = [
      '// not a real line comment in this test',         // Counts as JS.
      'const a = 1;',                                    // Counts.
    ].join('\n');
    // Cover only line 2.
    const ranges = [{ start: text.indexOf('const'), end: text.length }];
    const hits = XTestCliCoverage.computeLineHits({ url: 'u', text, ranges, kind: 'js' });
    assert(hits.total === 2);                            // No stripping.
  });

  test('mid-line CSS comment does not alter classification of significant chars', () => {
    // A rule with a trailing same-line comment: the rule's bytes are
    //  covered, the comment bytes are skipped from classification, so the
    //  line ends up `'full'` rather than `'partial'`.
    const text = 'h1 { color: red; } /* trailing */';
    const ruleEnd = text.indexOf('}') + 1;
    const ranges = [{ start: 0, end: ruleEnd }];
    const hits = XTestCliCoverage.computeLineHits({ url: 'u', text, ranges, kind: 'css' });
    assert(hits.total === 1);
    assert(hits.covered === 1);
    assert(hits.hitMap.get(1) === 'full');
  });

  test('unterminated CSS block comment masks to end of file', () => {
    const text = 'h1 { color: red; }\n/* never closed';
    const ranges = [{ start: 0, end: 18 }];
    const hits = XTestCliCoverage.computeLineHits({ url: 'u', text, ranges, kind: 'css' });
    assert(hits.total === 1);                            // Comment-only line dropped.
    assert(hits.covered === 1);
  });

  test('CSS pragmas (block-comment) exclude lines from grading', () => {
    const text = [
      'a { color: red; }',                                 // Line 1 — counts.
      '/* x-test:coverage disable */',                     // Line 2 — pragma.
      'b { color: blue; }',                                // Line 3 — disabled.
      '/* x-test:coverage enable */',                      // Line 4 — pragma.
      'c { color: green; }',                               // Line 5 — counts.
    ].join('\n');
    const hits = XTestCliCoverage.computeLineHits({ url: 'u', text, ranges: all(text), kind: 'css' });
    assert(hits.total   === 2);                            // Lines 1, 5.
    assert(hits.covered === 2);
  });

  test('same URL with both JS and CSS kinds does not collide in the merge', async () => {
    // Edge case: theoretically possible with CSS module scripts. Both entries
    //  must survive into lcov as separate records keyed off (url, kind).
    const tmp = await mkdtemp(join(tmpdir(), 'x-test-cli-mixed-'));
    try {
      const jsEntry = {
        url: 'http://host/x.module',
        text: 'export default 1;',
        ranges: [{ start: 0, end: 17 }],
        kind: 'js',
      };
      const cssEntry = {
        url: 'http://host/x.module',
        text: 'a { color: red; }',
        ranges: [{ start: 0, end: 17 }],
        kind: 'css',
      };
      const written = await XTestCliCoverage.writeLcov({
        entries: [jsEntry, cssEntry],
        outDir:  tmp,
        baseUrl: 'http://host/',
        sourceRoot: '/',
        goals:   { './x.module': { lines: 100 } },
      });
      const body = await readFile(written, 'utf8');
      // Two SF records for the same path — one per kind.
      const records = body.split('end_of_record').filter(s => s.trim() !== '');
      assert(records.length === 2);
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });
});
