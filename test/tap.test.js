import { suite, test } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { XTestCliTap } from '../x-test-cli-tap.js';

function stripAnsi(string) {
  // eslint-disable-next-line no-control-regex
  return string.replace(/\x1b\[[0-9;]*m/g, '');
}

// Named ANSI styles — used to build the expected stylized output of the
//  reporter so tests can compare byte-for-byte instead of writing regexes
//  per line. Mirrors `XTestCliTap.#styles`.
const styles = {
  reset:   '\x1b[0m',
  dim:     '\x1b[2m',
  boldRed: '\x1b[1;31m',
  red:     '\x1b[31m',
  green:   '\x1b[32m',
  yellow:  '\x1b[33m',
  orange:  '\x1b[38;5;208m',
  cyan:    '\x1b[36m',
};

/** Strips common leading indentation from a tagged template literal. */
function dedent(strings, ...values) {
  let raw = strings[0];
  for (let index = 0; index < values.length; index++) {
    raw += String(values[index]) + strings[index + 1];
  }
  const lines = raw.split('\n');
  if (lines.length > 0 && lines[0].trim() === '') {
    lines.shift();
  }
  if (lines.length > 0 && lines[lines.length - 1].trim() === '') {
    lines.pop();
  }
  let minIndent = Infinity;
  for (const line of lines) {
    if (line.trim() === '') {
      continue;
    }
    const indent = line.match(/^(\s*)/)?.[0].length ?? 0;
    if (indent < minIndent) {
      minIndent = indent;
    }
  }
  if (minIndent > 0 && minIndent < Infinity) {
    return lines.map(line => line.slice(minIndent) + '\n').join('');
  }
  return lines.map(line => line + '\n').join('');
}

suite('result accumulation', () => {
  test('plan + passes → ok', () => {
    const text = dedent`
      TAP version 14
      1..2
      ok 1 - a
      ok 2 - b
    `;
    const tap = new XTestCliTap({ stream: new PassThrough(), color: false });
    tap.write(text);
    tap.end();
    assert.deepEqual(tap.result, {
      ok: true,
      pass: 2,
      fail: 0,
      skip: 0,
      todo: 0,
      count: 2,
      plan: { start: 1, end: 2 },
      bailed: false,
      bailReason: null,
    });
  });

  test('not ok → fail, overall not ok', () => {
    const text = dedent`
      1..1
      not ok 1 - broken
    `;
    const tap = new XTestCliTap({ stream: new PassThrough(), color: false });
    tap.write(text);
    tap.end();
    assert.deepEqual(tap.result, {
      ok: false,
      pass: 0,
      fail: 1,
      skip: 0,
      todo: 0,
      count: 1,
      plan: { start: 1, end: 1 },
      bailed: false,
      bailReason: null,
    });
  });

  test('plan mismatch → not ok', () => {
    const text = dedent`
      1..3
      ok 1
      ok 2
    `;
    const tap = new XTestCliTap({ stream: new PassThrough(), color: false });
    tap.write(text);
    tap.end();
    assert.deepEqual(tap.result, {
      ok: false,
      pass: 2,
      fail: 0,
      skip: 0,
      todo: 0,
      count: 2,
      plan: { start: 1, end: 3 },
      bailed: false,
      bailReason: null,
    });
  });

  test('1..0 is a valid "empty run" and stays ok', () => {
    const text = dedent`
      1..0
    `;
    const tap = new XTestCliTap({ stream: new PassThrough(), color: false });
    tap.write(text);
    tap.end();
    assert.deepEqual(tap.result, {
      ok: true,
      pass: 0,
      fail: 0,
      skip: 0,
      todo: 0,
      count: 0,
      plan: { start: 1, end: 0 },
      bailed: false,
      bailReason: null,
    });
  });

  test('1..0 followed by asserts → not ok (plan mismatch)', () => {
    const text = dedent`
      1..0
      ok 1 - surprise
    `;
    const tap = new XTestCliTap({ stream: new PassThrough(), color: false });
    tap.write(text);
    tap.end();
    assert.deepEqual(tap.result, {
      ok: false,
      pass: 1,
      fail: 0,
      skip: 0,
      todo: 0,
      count: 1,
      plan: { start: 1, end: 0 },
      bailed: false,
      bailReason: null,
    });
  });

  test('nested subtest asserts do not inflate top-level count', () => {
    const text = dedent`
      TAP version 14
      # Subtest: group
          ok 1 - inner1
          ok 2 - inner2
          1..2
      ok 1 - group
      1..1
    `;
    const tap = new XTestCliTap({ stream: new PassThrough(), color: false });
    tap.write(text);
    tap.end();
    const result = tap.result;
    // Only the top-level `ok 1 - group` should count. The inner asserts
    //  are rendered but ignored for plan-vs-count validation (they're
    //  the producer's concern; our scanner trusts the rollup).
    assert.deepEqual(result, {
      ok: true,
      pass: 1,
      fail: 0,
      skip: 0,
      todo: 0,
      count: 1,
      plan: { start: 1, end: 1 },
      bailed: false,
      bailReason: null,
    });
  });

  test('inner plan does not overwrite top-level plan', () => {
    const text = dedent`
      # Subtest: group
          ok 1 - inner
          1..1
      ok 1 - group
      1..1
    `;
    const tap = new XTestCliTap({ stream: new PassThrough(), color: false });
    tap.write(text);
    tap.end();
    assert.deepEqual(tap.result, {
      ok: true,
      pass: 1,
      fail: 0,
      skip: 0,
      todo: 0,
      count: 1,
      plan: { start: 1, end: 1 },
      bailed: false,
      bailReason: null,
    });
  });

  test('realistic x-test-style output: deeply nested subtests report ok', () => {
    // Mirrors the shape of real x-test output: multiple top-level URL
    //  subtests, each with inner describe-blocks, each with inner
    //  asserts and inner plans. The top-level plan (1..2) should match
    //  the count of top-level rollup asserts (2), regardless of how
    //  many nested asserts there are.
    const text = dedent`
      TAP version 14
      # Subtest: http://host/a/
          1..0
      ok 1 - http://host/a/
      # Subtest: http://host/b/
          # Subtest: describe-block
              ok 1 - inner a
              ok 2 - inner b
              ok 3 - inner c
              1..3
          ok 1 - describe-block
          # Subtest: another
              ok 1 - deep1
              ok 2 - deep2
              1..2
          ok 2 - another
          1..2
      ok 2 - http://host/b/
      1..2
    `;
    const tap = new XTestCliTap({ stream: new PassThrough(), color: false });
    tap.write(text);
    tap.end();
    assert.deepEqual(tap.result, {
      ok: true,
      pass: 2,
      fail: 0,
      skip: 0,
      todo: 0,
      count: 2,
      plan: { start: 1, end: 2 },
      bailed: false,
      bailReason: null,
    });
  });

  test('bail → not ok, captures reason', () => {
    const text = dedent`
      Bail out! launch timeout
    `;
    const tap = new XTestCliTap({ stream: new PassThrough(), color: false });
    tap.write(text);
    tap.end();
    assert.deepEqual(tap.result, {
      ok: false,
      pass: 0,
      fail: 0,
      skip: 0,
      todo: 0,
      count: 0,
      plan: null,
      bailed: true,
      bailReason: 'launch timeout',
    });
  });

  test('ok with description but no dash still parses', () => {
    const text = dedent`
      1..1
      ok 1 plain description
    `;
    const tap = new XTestCliTap({ stream: new PassThrough(), color: false });
    tap.write(text);
    tap.end();
    assert.deepEqual(tap.result, {
      ok: true,
      pass: 1,
      fail: 0,
      skip: 0,
      todo: 0,
      count: 1,
      plan: { start: 1, end: 1 },
      bailed: false,
      bailReason: null,
    });
  });

  test('ok without number or description still counts', () => {
    const text = dedent`
      1..1
      ok
    `;
    const tap = new XTestCliTap({ stream: new PassThrough(), color: false });
    tap.write(text);
    tap.end();
    assert.deepEqual(tap.result, {
      ok: true,
      pass: 1,
      fail: 0,
      skip: 0,
      todo: 0,
      count: 1,
      plan: { start: 1, end: 1 },
      bailed: false,
      bailReason: null,
    });
  });
});

suite('directives', () => {
  test('TODO on not ok does not count as failure', () => {
    const text = dedent`
      1..1
      not ok 1 - pending # TODO later
    `;
    const tap = new XTestCliTap({ stream: new PassThrough(), color: false });
    tap.write(text);
    tap.end();
    assert.deepEqual(tap.result, {
      ok: true,
      pass: 0,
      fail: 0,
      skip: 0,
      todo: 1,
      count: 1,
      plan: { start: 1, end: 1 },
      bailed: false,
      bailReason: null,
    });
  });

  test('SKIP on ok is counted as skip', () => {
    const text = dedent`
      1..1
      ok 1 - feature # SKIP not supported
    `;
    const tap = new XTestCliTap({ stream: new PassThrough(), color: false });
    tap.write(text);
    tap.end();
    assert.deepEqual(tap.result, {
      ok: true,
      pass: 0,
      fail: 0,
      skip: 1,
      todo: 0,
      count: 1,
      plan: { start: 1, end: 1 },
      bailed: false,
      bailReason: null,
    });
  });

});

suite('passthrough (color off) is byte-identical', () => {
  test('non-yaml lines emit unchanged', () => {
    const text = dedent`
      TAP version 14
      ok 1 - alpha
      not ok 2 - beta # TODO later
      ok 3 - gamma # SKIP because
      # Subtest: render
          ok 1 - inner
          1..1
      ok 4 - render
      Bail out! bad
      1..4
    `;
    const stream = new PassThrough();
    const tap = new XTestCliTap({ stream, color: false });
    tap.write(text);
    tap.end();
    const out = stream.read().toString();
    assert(out === text);
  });

  test('yaml blocks emit unchanged (no dimming when color off)', () => {
    const text = dedent`
      not ok 1 - boom
        ---
        message: it broke
        stack: trace
        ...
    `;
    const stream = new PassThrough();
    const tap = new XTestCliTap({ stream, color: false });
    tap.write(text);
    tap.end();
    const out = stream.read().toString();
    assert(out === text);
  });

  test('stripping ANSI from color-on output yields byte-identical input', () => {
    const text = dedent`
      TAP version 14
      ok 1 - a
      not ok 2 - b # TODO later
      ok 3 - c # SKIP nope
        ---
        body
        ...
      Bail out! reason
      1..3
    `;
    const stream = new PassThrough();
    const tap = new XTestCliTap({ stream, color: true });
    tap.write(text);
    tap.end();
    const out = stream.read().toString();
    assert(stripAnsi(out) === text);
  });
});

suite('colorization', () => {
  test('ok → green whole line', () => {
    const text = dedent`
      ok 1 - alpha
    `;
    const stylized = dedent`
      ${styles.green}ok 1 - alpha${styles.reset}
    `;
    const stream = new PassThrough();
    const tap = new XTestCliTap({ stream, color: true });
    tap.write(text);
    tap.end();
    const out = stream.read().toString();
    assert(out === stylized);
    assert(stripAnsi(out) === text);
  });

  test('not ok → red whole line', () => {
    const text = dedent`
      not ok 2 - boom
    `;
    const stylized = dedent`
      ${styles.red}not ok 2 - boom${styles.reset}
    `;
    const stream = new PassThrough();
    const tap = new XTestCliTap({ stream, color: true });
    tap.write(text);
    tap.end();
    const out = stream.read().toString();
    assert(out === stylized);
    assert(stripAnsi(out) === text);
  });

  test('ok + SKIP → orange', () => {
    const text = dedent`
      ok 1 - feature # SKIP nope
    `;
    const stylized = dedent`
      ${styles.orange}ok 1 - feature # SKIP nope${styles.reset}
    `;
    const stream = new PassThrough();
    const tap = new XTestCliTap({ stream, color: true });
    tap.write(text);
    tap.end();
    const out = stream.read().toString();
    assert(out === stylized);
    assert(stripAnsi(out) === text);
  });

  test('not ok + TODO → orange (expected failure)', () => {
    const text = dedent`
      not ok 1 - pending # TODO later
    `;
    const stylized = dedent`
      ${styles.orange}not ok 1 - pending # TODO later${styles.reset}
    `;
    const stream = new PassThrough();
    const tap = new XTestCliTap({ stream, color: true });
    tap.write(text);
    tap.end();
    const out = stream.read().toString();
    assert(out === stylized);
    assert(stripAnsi(out) === text);
  });

  test('ok + TODO → yellow (unexpectedly passing)', () => {
    const text = dedent`
      ok 1 - surprise # TODO meant to fail
    `;
    const stylized = dedent`
      ${styles.yellow}ok 1 - surprise # TODO meant to fail${styles.reset}
    `;
    const stream = new PassThrough();
    const tap = new XTestCliTap({ stream, color: true });
    tap.write(text);
    tap.end();
    const out = stream.read().toString();
    assert(out === stylized);
    assert(stripAnsi(out) === text);
  });

  test('Bail out! → bold red', () => {
    const text = dedent`
      Bail out! launch timeout
    `;
    const stylized = dedent`
      ${styles.boldRed}Bail out! launch timeout${styles.reset}
    `;
    const stream = new PassThrough();
    const tap = new XTestCliTap({ stream, color: true });
    tap.write(text);
    tap.end();
    const out = stream.read().toString();
    assert(out === stylized);
    assert(stripAnsi(out) === text);
  });

  test('# Subtest: → cyan', () => {
    const text = '    # Subtest: render\n';
    const stylized = `${styles.cyan}    # Subtest: render${styles.reset}\n`;
    const stream = new PassThrough();
    const tap = new XTestCliTap({ stream, color: true });
    tap.write(text);
    tap.end();
    const out = stream.read().toString();
    assert(out === stylized);
    assert(stripAnsi(out) === text);
  });

  test('plan and version → dim', () => {
    const text = dedent`
      TAP version 14
      1..3
    `;
    const stylized = dedent`
      ${styles.dim}TAP version 14${styles.reset}
      ${styles.dim}1..3${styles.reset}
    `;
    const stream = new PassThrough();
    const tap = new XTestCliTap({ stream, color: true });
    tap.write(text);
    tap.end();
    const out = stream.read().toString();
    assert(out === stylized);
    assert(stripAnsi(out) === text);
  });

  test('yaml body dimmed between fences', () => {
    const text = dedent`
          ---
          message: boom
          ...
      ok 1 - after
    `;
    const stylized = dedent`
      ${styles.dim}    ---${styles.reset}
      ${styles.dim}    message: boom${styles.reset}
      ${styles.dim}    ...${styles.reset}
      ${styles.green}ok 1 - after${styles.reset}
    `;
    const stream = new PassThrough();
    const tap = new XTestCliTap({ stream, color: true });
    tap.write(text);
    tap.end();
    const out = stream.read().toString();
    assert(out === stylized);
    assert(stripAnsi(out) === text);
  });

  test('indented asserts keep indent, whole content colored', () => {
    const text = '        ok 1 - deep\n';
    const stylized = `${styles.green}        ok 1 - deep${styles.reset}\n`;
    const stream = new PassThrough();
    const tap = new XTestCliTap({ stream, color: true });
    tap.write(text);
    tap.end();
    const out = stream.read().toString();
    assert(out === stylized);
    assert(stripAnsi(out) === text);
  });
});

suite('failure re-iteration block', () => {
  test('# Failures: enters the block; all subsequent `#` lines are red', () => {
    const text = dedent`
      # Failures:
      #
      # http://host/f.html
      # > initialize
      # Error: not ok
      #     at XTestSuite.assert (http://host/x-test-suite.js:112:15)
    `;
    const stylized = dedent`
      ${styles.red}# Failures:${styles.reset}
      ${styles.red}#${styles.reset}
      ${styles.red}# http://host/f.html${styles.reset}
      ${styles.red}# > initialize${styles.reset}
      ${styles.red}# Error: not ok${styles.reset}
      ${styles.red}#     at XTestSuite.assert (http://host/x-test-suite.js:112:15)${styles.reset}
    `;
    const stream = new PassThrough();
    const tap = new XTestCliTap({ stream, color: true });
    tap.write(text);
    tap.end();
    const out = stream.read().toString();
    assert(out === stylized);
    assert(stripAnsi(out) === text);
  });

  test('URL and breadcrumb are red only AFTER # Failures:', () => {
    const text = dedent`
      # http://host/somewhere.html
      # Failures:
      # http://host/failed.html
      # > leaf
    `;
    const stylized = dedent`
      ${styles.dim}# http://host/somewhere.html${styles.reset}
      ${styles.red}# Failures:${styles.reset}
      ${styles.red}# http://host/failed.html${styles.reset}
      ${styles.red}# > leaf${styles.reset}
    `;
    const stream = new PassThrough();
    const tap = new XTestCliTap({ stream, color: true });
    tap.write(text);
    tap.end();
    const out = stream.read().toString();
    assert(out === stylized);
    assert(stripAnsi(out) === text);
  });

  test('blank separator inside the block is red', () => {
    const text = dedent`
      # Failures:
      # http://host/first.html
      # > leaf
      #
      # http://host/second.html
    `;
    const stylized = dedent`
      ${styles.red}# Failures:${styles.reset}
      ${styles.red}# http://host/first.html${styles.reset}
      ${styles.red}# > leaf${styles.reset}
      ${styles.red}#${styles.reset}
      ${styles.red}# http://host/second.html${styles.reset}
    `;
    const stream = new PassThrough();
    const tap = new XTestCliTap({ stream, color: true });
    tap.write(text);
    tap.end();
    const out = stream.read().toString();
    assert(out === stylized);
    assert(stripAnsi(out) === text);
  });

  test('truly empty line inside the block is red', () => {
    const text = dedent`
      # Failures:
      # http://host/first.html

      # http://host/second.html
    `;
    const stylized = dedent`
      ${styles.red}# Failures:${styles.reset}
      ${styles.red}# http://host/first.html${styles.reset}
      ${styles.red}${styles.reset}
      ${styles.red}# http://host/second.html${styles.reset}
    `;
    const stream = new PassThrough();
    const tap = new XTestCliTap({ stream, color: true });
    tap.write(text);
    tap.end();
    const out = stream.read().toString();
    assert(out === stylized);
    assert(stripAnsi(out) === text);
  });

  test('block is terminal — everything after # Failures: reads as failure commentary', () => {
    const text = dedent`
      # Failures:
      # http://host/f.html
      # > leaf
      ok 1 - a stray test line
      # ordinary comment
    `;
    // Once entered, the block swallows subsequent lines — including
    //  things that look like test asserts — as failure commentary (red).
    //  x-test never emits test lines after `# Failures:`; this test
    //  locks in the defensive behavior if anything ever does.
    const stylized = dedent`
      ${styles.red}# Failures:${styles.reset}
      ${styles.red}# http://host/f.html${styles.reset}
      ${styles.red}# > leaf${styles.reset}
      ${styles.red}ok 1 - a stray test line${styles.reset}
      ${styles.red}# ordinary comment${styles.reset}
    `;
    const stream = new PassThrough();
    const tap = new XTestCliTap({ stream, color: true });
    tap.write(text);
    tap.end();
    const out = stream.read().toString();
    assert(out === stylized);
    assert(stripAnsi(out) === text);
  });

  test('summary `#` lines BEFORE the block stay dim', () => {
    const text = dedent`
      # tests 101
      # pass 91
      # fail 1
      # Failures:
    `;
    const stylized = dedent`
      ${styles.dim}# tests 101${styles.reset}
      ${styles.dim}# pass 91${styles.reset}
      ${styles.dim}# fail 1${styles.reset}
      ${styles.red}# Failures:${styles.reset}
    `;
    const stream = new PassThrough();
    const tap = new XTestCliTap({ stream, color: true });
    tap.write(text);
    tap.end();
    const out = stream.read().toString();
    assert(out === stylized);
    assert(stripAnsi(out) === text);
  });
});

suite('edge cases', () => {
  test('comments and non-TAP noise flow through', () => {
    const text = dedent`
      # a comment
      random console.log output
      ok 1 - real test
    `;
    const tap = new XTestCliTap({ stream: new PassThrough(), color: false });
    tap.write(text);
    tap.end();
    assert.deepEqual(tap.result, {
      ok: true,
      pass: 1,
      fail: 0,
      skip: 0,
      todo: 0,
      count: 1,
      plan: null,
      bailed: false,
      bailReason: null,
    });
  });

  test('handles \\r\\n (Windows) line endings', () => {
    const text = '1..1\r\nok 1 - hi\r\n';
    const tap = new XTestCliTap({ stream: new PassThrough(), color: false });
    tap.write(text);
    tap.end();
    assert.deepEqual(tap.result, {
      ok: true,
      pass: 1,
      fail: 0,
      skip: 0,
      todo: 0,
      count: 1,
      plan: { start: 1, end: 1 },
      bailed: false,
      bailReason: null,
    });
  });

  test('case-sensitive: OK / NOT OK are not asserts', () => {
    const text = dedent`
      OK 1
      NOT OK 1
    `;
    const tap = new XTestCliTap({ stream: new PassThrough(), color: false });
    tap.write(text);
    tap.end();
    assert.deepEqual(tap.result, {
      ok: true,
      pass: 0,
      fail: 0,
      skip: 0,
      todo: 0,
      count: 0,
      plan: null,
      bailed: false,
      bailReason: null,
    });
  });

  test('word boundary: "okay" is not an assert', () => {
    const text = dedent`
      okay then
    `;
    const tap = new XTestCliTap({ stream: new PassThrough(), color: false });
    tap.write(text);
    tap.end();
    assert.deepEqual(tap.result, {
      ok: true,
      pass: 0,
      fail: 0,
      skip: 0,
      todo: 0,
      count: 0,
      plan: null,
      bailed: false,
      bailReason: null,
    });
  });
});

suite('write() handles multi-line blobs (browser-bridge path)', () => {
  test('YAML-bearing blob emitted as one console.log does not crash', () => {
    const blob = dedent`
      not ok 1 - something failed
        ---
        message: not ok
        stack: |-
          Error: not ok
              at http://127.0.0.1:8080/x.js:1:1
        ...
    `;
    const stream = new PassThrough();
    const tap = new XTestCliTap({ stream, color: true });
    assert.doesNotThrow(() => tap.write(blob));
    assert(stream.read().toString().length > 0);
    tap.end();
    assert(tap.result.fail === 1);
  });

  test('blob output matches line-at-a-time output (color off)', () => {
    const text = dedent`
      TAP version 14
      ok 1 - a
        ---
        body
        ...
      1..1
    `;

    const streamA = new PassThrough();
    const tapA = new XTestCliTap({ stream: streamA, color: false });
    tapA.write(text);
    tapA.end();

    const streamB = new PassThrough();
    const tapB = new XTestCliTap({ stream: streamB, color: false });
    for (const line of text.split('\n')) {
      tapB.write(line);
    }
    tapB.end();

    assert(streamA.read().toString() === streamB.read().toString());
  });
});

suite('lifecycle guards', () => {
  test('.result before end() throws', () => {
    const tap = new XTestCliTap({ stream: new PassThrough(), color: false });
    assert.throws(() => tap.result, /result accessed before end/);
  });

  test('.result after end() returns the frozen result', () => {
    const tap = new XTestCliTap({ stream: new PassThrough(), color: false });
    tap.write('1..0');
    tap.end();
    assert.doesNotThrow(() => tap.result);
    // Repeated reads return the same object.
    assert(tap.result === tap.result);
  });

  test('write() after end() throws', () => {
    const tap = new XTestCliTap({ stream: new PassThrough(), color: false });
    tap.end();
    assert.throws(() => tap.write('ok 1 - late'), /write\(\) called after end/);
  });

  test('end() called twice throws', () => {
    const tap = new XTestCliTap({ stream: new PassThrough(), color: false });
    tap.end();
    assert.throws(() => tap.end(), /end\(\) called more than once/);
  });
});
