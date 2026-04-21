import { suite, test } from 'node:test';
import assert from 'node:assert/strict';
import { XTestCliBrowserPlaywright } from '../x-test-cli-browser.js';

suite('XTestCliBrowserPlaywright.normalizeCoverage', () => {
  test('maps source->text and preserves url/scriptId', () => {
    const input = [{
      url: 'http://example/a.js',
      scriptId: '1',
      source: 'const x = 1;',
      functions: [],
    }];
    const [entry] = XTestCliBrowserPlaywright.normalizeCoverage(input);
    assert.equal(entry.url, 'http://example/a.js');
    assert.equal(entry.scriptId, '1');
    assert.equal(entry.text, 'const x = 1;');
    assert.deepEqual(entry.ranges, []);
  });

  test('flattens ranges with count > 0', () => {
    const input = [{
      url: 'u', scriptId: 's', source: 'abcdefghij',
      functions: [
        { ranges: [{ startOffset: 0, endOffset: 5, count: 1 }] },
        { ranges: [{ startOffset: 5, endOffset: 10, count: 2 }] },
      ],
    }];
    const [entry] = XTestCliBrowserPlaywright.normalizeCoverage(input);
    assert.deepEqual(entry.ranges, [
      { start: 0, end: 5 },
      { start: 5, end: 10 },
    ]);
  });

  test('drops ranges with count === 0', () => {
    const input = [{
      url: 'u', scriptId: 's', source: 'src',
      functions: [
        { ranges: [
          { startOffset: 0, endOffset: 10, count: 1 },
          { startOffset: 3, endOffset: 7, count: 0 },
        ] },
      ],
    }];
    const [entry] = XTestCliBrowserPlaywright.normalizeCoverage(input);
    assert.deepEqual(entry.ranges, [{ start: 0, end: 10 }]);
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
    assert.equal(out.length, 2);
    assert.deepEqual(out[0].ranges, [{ start: 0, end: 1 }]);
    assert.deepEqual(out[1].ranges, []);
  });
});
