import { suite, test } from 'node:test';
import assert from 'node:assert/strict';
import { XTestCliBrowserPlaywright } from '../../x-test-cli-browser.js';

suite('XTestCliBrowserPlaywright.normalizeCoverage', () => {
  test('maps source->text and preserves url/scriptId', () => {
    const input = [{
      url: 'http://example/a.js',
      scriptId: '1',
      source: 'const x = 1;',
      functions: [],
    }];
    const [entry] = XTestCliBrowserPlaywright.normalizeCoverage(input);
    assert(entry.url === 'http://example/a.js');
    assert(entry.scriptId === '1');
    assert(entry.text === 'const x = 1;');
    assert.deepEqual(entry.ranges, []);
  });

  test('adjacent covered sibling ranges with same count merge', () => {
    const input = [{
      url: 'u', scriptId: 's', source: 'abcdefghij',
      functions: [
        { ranges: [{ startOffset: 0, endOffset:  5, count: 1 }] },
        { ranges: [{ startOffset: 5, endOffset: 10, count: 1 }] },
      ],
    }];
    const [entry] = XTestCliBrowserPlaywright.normalizeCoverage(input);
    assert.deepEqual(entry.ranges, [{ start: 0, end: 10 }]);
  });

  test('adjacent covered sibling ranges with different counts stay separate', () => {
    // Matches Puppeteer's behavior: only merge segments carrying the same
    //  effective count, since they come from differently-reached branches.
    const input = [{
      url: 'u', scriptId: 's', source: 'abcdefghij',
      functions: [
        { ranges: [{ startOffset: 0, endOffset:  5, count: 1 }] },
        { ranges: [{ startOffset: 5, endOffset: 10, count: 2 }] },
      ],
    }];
    const [entry] = XTestCliBrowserPlaywright.normalizeCoverage(input);
    assert.deepEqual(entry.ranges, [
      { start: 0, end:  5 },
      { start: 5, end: 10 },
    ]);
  });

  test('inner count=0 block is subtracted from its outer count>0 parent', () => {
    // The crux of matching Puppeteer: an executed function with an untaken
    //  branch must report the branch's bytes as uncovered, not glossed over.
    const input = [{
      url: 'u', scriptId: 's', source: 'src',
      functions: [
        { ranges: [
          { startOffset: 0, endOffset: 10, count: 1 },
          { startOffset: 3, endOffset:  7, count: 0 },
        ] },
      ],
    }];
    const [entry] = XTestCliBrowserPlaywright.normalizeCoverage(input);
    assert.deepEqual(entry.ranges, [
      { start: 0, end:  3 },
      { start: 7, end: 10 },
    ]);
  });

  test('handles missing functions array', () => {
    const input = [{ url: 'u', scriptId: 's', source: 'x' }];
    const [entry] = XTestCliBrowserPlaywright.normalizeCoverage(input);
    assert.deepEqual(entry.ranges, []);
  });

  test('handles empty input', () => {
    assert.deepEqual(XTestCliBrowserPlaywright.normalizeCoverage([]), []);
  });

  test('handles multiple entries independently', () => {
    const input = [
      { url: 'a', scriptId: '1', source: 'a', functions: [
        { ranges: [{ startOffset: 0, endOffset: 1, count: 1 }] },
      ] },
      { url: 'b', scriptId: '2', source: 'bb', functions: [
        { ranges: [{ startOffset: 0, endOffset: 2, count: 0 }] },
      ] },
    ];
    const out = XTestCliBrowserPlaywright.normalizeCoverage(input);
    assert(out.length === 2);
    assert.deepEqual(out[0].ranges, [{ start: 0, end: 1 }]);
    assert.deepEqual(out[1].ranges, []);
  });
});

suite('XTestCliBrowserPlaywright.normalizeCssCoverage', () => {
  test('preserves url, text, and {start, end} ranges', () => {
    const input = [{
      url: 'http://example/a.css',
      text: 'a { color: red; }',
      ranges: [{ start: 0, end: 17 }],
    }];
    const [entry] = XTestCliBrowserPlaywright.normalizeCssCoverage(input);
    assert(entry.url === 'http://example/a.css');
    assert(entry.text === 'a { color: red; }');
    assert.deepEqual(entry.ranges, [{ start: 0, end: 17 }]);
  });

  test('handles missing ranges array', () => {
    const input = [{ url: 'u', text: 'x' }];
    const [entry] = XTestCliBrowserPlaywright.normalizeCssCoverage(input);
    assert.deepEqual(entry.ranges, []);
  });

  test('handles empty input', () => {
    assert.deepEqual(XTestCliBrowserPlaywright.normalizeCssCoverage([]), []);
  });

  test('handles multiple ranges within an entry', () => {
    const input = [{
      url: 'u', text: 'abcdefghij',
      ranges: [{ start: 0, end: 3 }, { start: 5, end: 7 }],
    }];
    const [entry] = XTestCliBrowserPlaywright.normalizeCssCoverage(input);
    assert.deepEqual(entry.ranges, [
      { start: 0, end: 3 },
      { start: 5, end: 7 },
    ]);
  });

  test('drops extra fields on ranges (defensive shape copy)', () => {
    const input = [{
      url: 'u', text: 'x',
      ranges: [{ start: 0, end: 1, extra: 'unexpected' }],
    }];
    const [entry] = XTestCliBrowserPlaywright.normalizeCssCoverage(input);
    assert.deepEqual(entry.ranges, [{ start: 0, end: 1 }]);
  });
});

suite('XTestCliBrowserPlaywright.convertToDisjointRanges', () => {
  test('single covered range passes through', () => {
    const out = XTestCliBrowserPlaywright.convertToDisjointRanges([
      { startOffset: 0, endOffset: 10, count: 1 },
    ]);
    assert.deepEqual(out, [{ start: 0, end: 10 }]);
  });

  test('single uncovered range → no output', () => {
    const out = XTestCliBrowserPlaywright.convertToDisjointRanges([
      { startOffset: 0, endOffset: 10, count: 0 },
    ]);
    assert.deepEqual(out, []);
  });

  test('multiple inner uncovered blocks each subtract independently', () => {
    const out = XTestCliBrowserPlaywright.convertToDisjointRanges([
      { startOffset:  0, endOffset: 100, count: 1 },
      { startOffset: 20, endOffset:  30, count: 0 },
      { startOffset: 60, endOffset:  70, count: 0 },
    ]);
    assert.deepEqual(out, [
      { start:  0, end:  20 },
      { start: 30, end:  60 },
      { start: 70, end: 100 },
    ]);
  });

  test('deeply nested: outer=1, middle=0, inner=1 → inner re-covered', () => {
    const out = XTestCliBrowserPlaywright.convertToDisjointRanges([
      { startOffset:  0, endOffset: 100, count: 1 },
      { startOffset: 20, endOffset:  80, count: 0 },
      { startOffset: 40, endOffset:  60, count: 1 },
    ]);
    assert.deepEqual(out, [
      { start:  0, end:  20 },
      { start: 40, end:  60 },
      { start: 80, end: 100 },
    ]);
  });

  test('disjoint ranges keep their left-to-right order', () => {
    const out = XTestCliBrowserPlaywright.convertToDisjointRanges([
      { startOffset: 10, endOffset: 20, count: 1 },
      { startOffset:  0, endOffset:  5, count: 1 },
    ]);
    assert.deepEqual(out, [
      { start:  0, end:  5 },
      { start: 10, end: 20 },
    ]);
  });
});
