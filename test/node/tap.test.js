import { suite, test } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { XTestCliTap } from '../../x-test-cli-tap.js';
import { dedent } from './common.js';

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


suite('result accumulation', () => {
  test('plan + passes → ok', () => {
    const text = dedent`
      TAP version 14
      ok 1 - a
      ok 2 - b
      1..2
    `;
    const tap = new XTestCliTap({ stream: new PassThrough(), color: false });
    tap.write(text);
    assert.deepEqual(tap.result, {
      ok: true,
      testOk:2,
      testNotOk:0,
      testSkip:0,
      testTodoOk: 0,
      testTodoNotOk:0,
      testCount:2,
      planStart: 1,
      planEnd:   2,
      bailed: false,
      bailReason: null,
    });
  });

  test('not ok → fail, overall not ok', () => {
    const text = dedent`
      TAP version 14
      not ok 1 - broken
      1..1
    `;
    const tap = new XTestCliTap({ stream: new PassThrough(), color: false });
    tap.write(text);
    assert.deepEqual(tap.result, {
      ok: false,
      testOk:0,
      testNotOk:1,
      testSkip:0,
      testTodoOk: 0,
      testTodoNotOk:0,
      testCount:1,
      planStart: 1,
      planEnd:   1,
      bailed: false,
      bailReason: null,
    });
  });

  test('plan mismatch → not ok', () => {
    const text = dedent`
      TAP version 14
      ok 1
      ok 2
      1..3
    `;
    const tap = new XTestCliTap({ stream: new PassThrough(), color: false });
    tap.write(text);
    assert.deepEqual(tap.result, {
      ok: false,
      testOk:2,
      testNotOk:0,
      testSkip:0,
      testTodoOk: 0,
      testTodoNotOk:0,
      testCount:2,
      planStart: 1,
      planEnd:   3,
      bailed: false,
      bailReason: null,
    });
  });

  test('1..0 is a valid "empty run" and stays ok', () => {
    const text = dedent`
      TAP version 14
      1..0
    `;
    const tap = new XTestCliTap({ stream: new PassThrough(), color: false });
    tap.write(text);
    assert.deepEqual(tap.result, {
      ok: true,
      testOk:0,
      testNotOk:0,
      testSkip:0,
      testTodoOk: 0,
      testTodoNotOk:0,
      testCount:0,
      planStart: 1,
      planEnd:   0,
      bailed: false,
      bailReason: null,
    });
  });

  test('1..0 auto-ends immediately; trailing asserts are post-end noise', () => {
    // An empty plan is terminal — the stream has no more asserts coming.
    //  If a buggy producer emits `1..0` and then spurious asserts, we render
    //  them (via pass-through) but the frozen result reflects the honest
    //  zero-plan snapshot at the moment the plan was seen.
    const text = dedent`
      TAP version 14
      1..0
      ok 1 - surprise
    `;
    const tap = new XTestCliTap({ stream: new PassThrough(), color: false });
    tap.write(text);
    assert.deepEqual(tap.result, {
      ok:         true,
      testOk:      0,
      testNotOk:      0,
      testSkip:      0,
      testTodoOk: 0,
      testTodoNotOk:      0,
      testCount:     0,
      planStart: 1,
      planEnd:   0,
      bailed:     false,
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
    const result = tap.result;
    // Only the top-level `ok 1 - group` should count. The inner asserts
    //  are rendered but ignored for plan-vs-count validation (they're
    //  the producer's concern; our scanner trusts the rollup).
    assert.deepEqual(result, {
      ok: true,
      testOk:1,
      testNotOk:0,
      testSkip:0,
      testTodoOk: 0,
      testTodoNotOk:0,
      testCount:1,
      planStart: 1,
      planEnd:   1,
      bailed: false,
      bailReason: null,
    });
  });

  test('inner plan does not overwrite top-level plan', () => {
    const text = dedent`
      TAP version 14
      # Subtest: group
          ok 1 - inner
          1..1
      ok 1 - group
      1..1
    `;
    const tap = new XTestCliTap({ stream: new PassThrough(), color: false });
    tap.write(text);
    assert.deepEqual(tap.result, {
      ok: true,
      testOk:1,
      testNotOk:0,
      testSkip:0,
      testTodoOk: 0,
      testTodoNotOk:0,
      testCount:1,
      planStart: 1,
      planEnd:   1,
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
    assert.deepEqual(tap.result, {
      ok: true,
      testOk:2,
      testNotOk:0,
      testSkip:0,
      testTodoOk: 0,
      testTodoNotOk:0,
      testCount:2,
      planStart: 1,
      planEnd:   2,
      bailed: false,
      bailReason: null,
    });
  });

  test('bail → not ok, captures reason', () => {
    const text = dedent`
      TAP version 14
      Bail out! launch timeout
    `;
    const tap = new XTestCliTap({ stream: new PassThrough(), color: false });
    tap.write(text);
    assert.deepEqual(tap.result, {
      ok: false,
      testOk:0,
      testNotOk:0,
      testSkip:0,
      testTodoOk: 0,
      testTodoNotOk:0,
      testCount:0,
      planStart: null,
      planEnd:   null,
      bailed: true,
      bailReason: 'launch timeout',
    });
  });

  test('ok with description but no dash still parses', () => {
    const text = dedent`
      TAP version 14
      ok 1 plain description
      1..1
    `;
    const tap = new XTestCliTap({ stream: new PassThrough(), color: false });
    tap.write(text);
    assert.deepEqual(tap.result, {
      ok: true,
      testOk:1,
      testNotOk:0,
      testSkip:0,
      testTodoOk: 0,
      testTodoNotOk:0,
      testCount:1,
      planStart: 1,
      planEnd:   1,
      bailed: false,
      bailReason: null,
    });
  });

  test('ok without number or description still counts', () => {
    const text = dedent`
      TAP version 14
      ok
      1..1
    `;
    const tap = new XTestCliTap({ stream: new PassThrough(), color: false });
    tap.write(text);
    assert.deepEqual(tap.result, {
      ok: true,
      testOk:1,
      testNotOk:0,
      testSkip:0,
      testTodoOk: 0,
      testTodoNotOk:0,
      testCount:1,
      planStart: 1,
      planEnd:   1,
      bailed: false,
      bailReason: null,
    });
  });
});

suite('directives', () => {
  test('TODO on not ok does not count as failure', () => {
    const text = dedent`
      TAP version 14
      not ok 1 - pending # TODO later
      1..1
    `;
    const tap = new XTestCliTap({ stream: new PassThrough(), color: false });
    tap.write(text);
    assert.deepEqual(tap.result, {
      ok: true,
      testOk:0,
      testNotOk:0,
      testSkip:0,
      testTodoOk: 0,
      testTodoNotOk:1,
      testCount:1,
      planStart: 1,
      planEnd:   1,
      bailed: false,
      bailReason: null,
    });
  });

  test('SKIP on ok is counted as skip', () => {
    const text = dedent`
      TAP version 14
      ok 1 - feature # SKIP not supported
      1..1
    `;
    const tap = new XTestCliTap({ stream: new PassThrough(), color: false });
    tap.write(text);
    assert.deepEqual(tap.result, {
      ok: true,
      testOk:0,
      testNotOk:0,
      testSkip:1,
      testTodoOk: 0,
      testTodoNotOk:0,
      testCount:1,
      planStart: 1,
      planEnd:   1,
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
      1..4
    `;
    const stream = new PassThrough();
    const tap = new XTestCliTap({ stream, color: false });
    tap.write(text);
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
      1..3
    `;
    const stream = new PassThrough();
    const tap = new XTestCliTap({ stream, color: true });
    tap.write(text);
    const out = stream.read().toString();
    assert(stripAnsi(out) === text);
  });
});

suite('colorization', () => {
  test('ok → green whole line', () => {
    const text = dedent`
      TAP version 14
      ok 1 - alpha
    `;
    const stylized = dedent`
      ${styles.dim}TAP version 14${styles.reset}
      ${styles.green}ok 1 - alpha${styles.reset}
    `;
    const stream = new PassThrough();
    const tap = new XTestCliTap({ stream, color: true });
    tap.write(text);
    const out = stream.read().toString();
    assert(out === stylized);
    assert(stripAnsi(out) === text);
  });

  test('not ok → red whole line', () => {
    const text = dedent`
      TAP version 14
      not ok 2 - boom
    `;
    const stylized = dedent`
      ${styles.dim}TAP version 14${styles.reset}
      ${styles.red}not ok 2 - boom${styles.reset}
    `;
    const stream = new PassThrough();
    const tap = new XTestCliTap({ stream, color: true });
    tap.write(text);
    const out = stream.read().toString();
    assert(out === stylized);
    assert(stripAnsi(out) === text);
  });

  test('ok + SKIP → orange', () => {
    const text = dedent`
      TAP version 14
      ok 1 - feature # SKIP nope
    `;
    const stylized = dedent`
      ${styles.dim}TAP version 14${styles.reset}
      ${styles.orange}ok 1 - feature # SKIP nope${styles.reset}
    `;
    const stream = new PassThrough();
    const tap = new XTestCliTap({ stream, color: true });
    tap.write(text);
    const out = stream.read().toString();
    assert(out === stylized);
    assert(stripAnsi(out) === text);
  });

  test('not ok + TODO → orange (expected failure)', () => {
    const text = dedent`
      TAP version 14
      not ok 1 - pending # TODO later
    `;
    const stylized = dedent`
      ${styles.dim}TAP version 14${styles.reset}
      ${styles.orange}not ok 1 - pending # TODO later${styles.reset}
    `;
    const stream = new PassThrough();
    const tap = new XTestCliTap({ stream, color: true });
    tap.write(text);
    const out = stream.read().toString();
    assert(out === stylized);
    assert(stripAnsi(out) === text);
  });

  test('ok + TODO → yellow (unexpectedly passing)', () => {
    const text = dedent`
      TAP version 14
      ok 1 - surprise # TODO meant to fail
    `;
    const stylized = dedent`
      ${styles.dim}TAP version 14${styles.reset}
      ${styles.yellow}ok 1 - surprise # TODO meant to fail${styles.reset}
    `;
    const stream = new PassThrough();
    const tap = new XTestCliTap({ stream, color: true });
    tap.write(text);
    const out = stream.read().toString();
    assert(out === stylized);
    assert(stripAnsi(out) === text);
  });

  test('Bail out! → bold red', () => {
    const text = dedent`
      TAP version 14
      Bail out! launch timeout
    `;
    const stylized = dedent`
      ${styles.dim}TAP version 14${styles.reset}
      ${styles.boldRed}Bail out! launch timeout${styles.reset}
    `;
    const stream = new PassThrough();
    const tap = new XTestCliTap({ stream, color: true });
    tap.write(text);
    const out = stream.read().toString();
    assert(out === stylized);
    assert(stripAnsi(out) === text);
  });

  test('# Subtest: → cyan', () => {
    const text = `TAP version 14\n    # Subtest: render\n`;
    const stylized = `${styles.dim}TAP version 14${styles.reset}\n${styles.cyan}    # Subtest: render${styles.reset}\n`;
    const stream = new PassThrough();
    const tap = new XTestCliTap({ stream, color: true });
    tap.write(text);
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
    const out = stream.read().toString();
    assert(out === stylized);
    assert(stripAnsi(out) === text);
  });

  test('yaml body dimmed between fences', () => {
    const text = dedent`
      TAP version 14
          ---
          message: boom
          ...
      ok 1 - after
    `;
    const stylized = dedent`
      ${styles.dim}TAP version 14${styles.reset}
      ${styles.dim}    ---${styles.reset}
      ${styles.dim}    message: boom${styles.reset}
      ${styles.dim}    ...${styles.reset}
      ${styles.green}ok 1 - after${styles.reset}
    `;
    const stream = new PassThrough();
    const tap = new XTestCliTap({ stream, color: true });
    tap.write(text);
    const out = stream.read().toString();
    assert(out === stylized);
    assert(stripAnsi(out) === text);
  });

  test('indented asserts keep indent, whole content colored', () => {
    const text = `TAP version 14\n        ok 1 - deep\n`;
    const stylized = `${styles.dim}TAP version 14${styles.reset}\n${styles.green}        ok 1 - deep${styles.reset}\n`;
    const stream = new PassThrough();
    const tap = new XTestCliTap({ stream, color: true });
    tap.write(text);
    const out = stream.read().toString();
    assert(out === stylized);
    assert(stripAnsi(out) === text);
  });
});

suite('coverage summary', () => {
  test('# Coverage: header → dim', () => {
    const text = '# Coverage:\n';
    const stylized = `${styles.dim}# Coverage:${styles.reset}\n`;
    const stream = new PassThrough();
    const tap = new XTestCliTap({ stream, color: true });
    tap.writeCoverage(text);
    const out = stream.read().toString();
    assert(out === stylized);
    assert(stripAnsi(out) === text);
  });

  test('coverage row starting with "ok" → green', () => {
    const text = '# ok     - 100% line coverage goal (got 100%)   | ./src/foo.js\n';
    const stylized = `${styles.green}# ok     - 100% line coverage goal (got 100%)   | ./src/foo.js${styles.reset}\n`;
    const stream = new PassThrough();
    const tap = new XTestCliTap({ stream, color: true });
    tap.writeCoverage(text);
    const out = stream.read().toString();
    assert(out === stylized);
    assert(stripAnsi(out) === text);
  });

  test('coverage row starting with "not ok" → red', () => {
    const text = '# not ok - 65%  line coverage goal (got 60.64%) | ./src/bar.js\n';
    const stylized = `${styles.red}# not ok - 65%  line coverage goal (got 60.64%) | ./src/bar.js${styles.reset}\n`;
    const stream = new PassThrough();
    const tap = new XTestCliTap({ stream, color: true });
    tap.writeCoverage(text);
    const out = stream.read().toString();
    assert(out === stylized);
    assert(stripAnsi(out) === text);
  });

  test('# (see ...) trailer → dim', () => {
    const text = '# (see ./coverage/lcov.info)\n';
    const stylized = `${styles.dim}# (see ./coverage/lcov.info)${styles.reset}\n`;
    const stream = new PassThrough();
    const tap = new XTestCliTap({ stream, color: true });
    tap.writeCoverage(text);
    const out = stream.read().toString();
    assert(out === stylized);
    assert(stripAnsi(out) === text);
  });

  test('blank `#` separator → dim', () => {
    const text = '#\n';
    const stylized = `${styles.dim}#${styles.reset}\n`;
    const stream = new PassThrough();
    const tap = new XTestCliTap({ stream, color: true });
    tap.writeCoverage(text);
    const out = stream.read().toString();
    assert(out === stylized);
    assert(stripAnsi(out) === text);
  });

  test('unknown lines inside a coverage block render raw', () => {
    // Anything the four coverage patterns don't classify slips through
    //  without style. Keeps the method forgiving about surprise content.
    const text = 'garbage line here\n';
    const stream = new PassThrough();
    const tap = new XTestCliTap({ stream, color: true });
    tap.writeCoverage(text);
    const out = stream.read().toString();
    assert(out === text);
  });

  test('coverage block renders raw when color is off', () => {
    const text = dedent`
      # Coverage:
      #
      # ok     - 100% line coverage goal (got 100%)   | ./src/foo.js
      # not ok - 65%  line coverage goal (got 60.64%) | ./src/bar.js
      #
      # (see ./coverage/lcov.info)
    `;
    const stream = new PassThrough();
    const tap = new XTestCliTap({ stream, color: false });
    tap.writeCoverage(text);
    const out = stream.read().toString();
    assert(out === text);
  });

  test('writeCoverage does not mutate tap.result', () => {
    // The coverage block arrives after auto-end; writeCoverage is a
    //  separate rendering path that never touches the parser state.
    const text = dedent`
      TAP version 14
      ok 1 - a
      1..1
    `;
    const tap = new XTestCliTap({ stream: new PassThrough(), color: false });
    tap.write(text);
    const resultBefore = tap.result;
    tap.writeCoverage(dedent`
      # Coverage:
      #
      # ok - 100% line coverage goal (got 100%) | ./src/foo.js
      #
      # (see ./coverage/lcov.info)
    `);
    assert(tap.result === resultBefore);               // Same frozen snapshot.
  });
});

suite('failure re-iteration block', () => {
  test('# Failures: enters the block; all subsequent `#` lines are red', () => {
    const text = dedent`
      TAP version 14
      # Failures:
      #
      # http://host/f.html
      # > initialize
      # Error: not ok
      #     at XTestSuite.assert (http://host/x-test-suite.js:112:15)
    `;
    const stylized = dedent`
      ${styles.dim}TAP version 14${styles.reset}
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
    const out = stream.read().toString();
    assert(out === stylized);
    assert(stripAnsi(out) === text);
  });

  test('URL and breadcrumb are red only AFTER # Failures:', () => {
    const text = dedent`
      TAP version 14
      # http://host/somewhere.html
      # Failures:
      # http://host/failed.html
      # > leaf
    `;
    const stylized = dedent`
      ${styles.dim}TAP version 14${styles.reset}
      ${styles.dim}# http://host/somewhere.html${styles.reset}
      ${styles.red}# Failures:${styles.reset}
      ${styles.red}# http://host/failed.html${styles.reset}
      ${styles.red}# > leaf${styles.reset}
    `;
    const stream = new PassThrough();
    const tap = new XTestCliTap({ stream, color: true });
    tap.write(text);
    const out = stream.read().toString();
    assert(out === stylized);
    assert(stripAnsi(out) === text);
  });

  test('blank separator inside the block is red', () => {
    const text = dedent`
      TAP version 14
      # Failures:
      # http://host/first.html
      # > leaf
      #
      # http://host/second.html
    `;
    const stylized = dedent`
      ${styles.dim}TAP version 14${styles.reset}
      ${styles.red}# Failures:${styles.reset}
      ${styles.red}# http://host/first.html${styles.reset}
      ${styles.red}# > leaf${styles.reset}
      ${styles.red}#${styles.reset}
      ${styles.red}# http://host/second.html${styles.reset}
    `;
    const stream = new PassThrough();
    const tap = new XTestCliTap({ stream, color: true });
    tap.write(text);
    const out = stream.read().toString();
    assert(out === stylized);
    assert(stripAnsi(out) === text);
  });

  test('truly empty line inside the block is red', () => {
    const text = dedent`
      TAP version 14
      # Failures:
      # http://host/first.html

      # http://host/second.html
    `;
    const stylized = dedent`
      ${styles.dim}TAP version 14${styles.reset}
      ${styles.red}# Failures:${styles.reset}
      ${styles.red}# http://host/first.html${styles.reset}
      ${styles.red}${styles.reset}
      ${styles.red}# http://host/second.html${styles.reset}
    `;
    const stream = new PassThrough();
    const tap = new XTestCliTap({ stream, color: true });
    tap.write(text);
    const out = stream.read().toString();
    assert(out === stylized);
    assert(stripAnsi(out) === text);
  });

  test('block is terminal — everything after # Failures: reads as failure commentary', () => {
    const text = dedent`
      TAP version 14
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
      ${styles.dim}TAP version 14${styles.reset}
      ${styles.red}# Failures:${styles.reset}
      ${styles.red}# http://host/f.html${styles.reset}
      ${styles.red}# > leaf${styles.reset}
      ${styles.red}ok 1 - a stray test line${styles.reset}
      ${styles.red}# ordinary comment${styles.reset}
    `;
    const stream = new PassThrough();
    const tap = new XTestCliTap({ stream, color: true });
    tap.write(text);
    const out = stream.read().toString();
    assert(out === stylized);
    assert(stripAnsi(out) === text);
  });

  test('summary `#` lines BEFORE the block stay dim', () => {
    const text = dedent`
      TAP version 14
      # tests 101
      # pass 91
      # fail 1
      # Failures:
    `;
    const stylized = dedent`
      ${styles.dim}TAP version 14${styles.reset}
      ${styles.dim}# tests 101${styles.reset}
      ${styles.dim}# pass 91${styles.reset}
      ${styles.dim}# fail 1${styles.reset}
      ${styles.red}# Failures:${styles.reset}
    `;
    const stream = new PassThrough();
    const tap = new XTestCliTap({ stream, color: true });
    tap.write(text);
    const out = stream.read().toString();
    assert(out === stylized);
    assert(stripAnsi(out) === text);
  });
});

suite('edge cases', () => {
  test('comments and non-TAP noise flow through', () => {
    const text = dedent`
      TAP version 14
      # a comment
      random console.log output
      ok 1 - real test
      1..1
    `;
    const tap = new XTestCliTap({ stream: new PassThrough(), color: false });
    tap.write(text);
    assert.deepEqual(tap.result, {
      ok: true,
      testOk:1,
      testNotOk:0,
      testSkip:0,
      testTodoOk: 0,
      testTodoNotOk:0,
      testCount:1,
      planStart: 1,
      planEnd:   1,
      bailed: false,
      bailReason: null,
    });
  });

  test('handles \\r\\n (Windows) line endings', () => {
    const text = 'TAP version 14\r\nok 1 - hi\r\n1..1\r\n';
    const tap = new XTestCliTap({ stream: new PassThrough(), color: false });
    tap.write(text);
    assert.deepEqual(tap.result, {
      ok: true,
      testOk:1,
      testNotOk:0,
      testSkip:0,
      testTodoOk: 0,
      testTodoNotOk:0,
      testCount:1,
      planStart: 1,
      planEnd:   1,
      bailed: false,
      bailReason: null,
    });
  });

  test('case-sensitive: OK / NOT OK are not asserts', () => {
    const text = dedent`
      TAP version 14
      OK 1
      NOT OK 1
      1..0
    `;
    const tap = new XTestCliTap({ stream: new PassThrough(), color: false });
    tap.write(text);
    assert.deepEqual(tap.result, {
      ok: true,
      testOk:0,
      testNotOk:0,
      testSkip:0,
      testTodoOk: 0,
      testTodoNotOk:0,
      testCount:0,
      planStart: 1,
      planEnd:   0,
      bailed: false,
      bailReason: null,
    });
  });

  test('word boundary: "okay" is not an assert', () => {
    const text = dedent`
      TAP version 14
      okay then
      1..0
    `;
    const tap = new XTestCliTap({ stream: new PassThrough(), color: false });
    tap.write(text);
    assert.deepEqual(tap.result, {
      ok: true,
      testOk:0,
      testNotOk:0,
      testSkip:0,
      testTodoOk: 0,
      testTodoNotOk:0,
      testCount:0,
      planStart: 1,
      planEnd:   0,
      bailed: false,
      bailReason: null,
    });
  });
});

suite('write() handles multi-line blobs (browser-bridge path)', () => {
  test('YAML-bearing blob emitted as one console.log does not crash', () => {
    const blob = dedent`
      TAP version 14
      not ok 1 - something failed
        ---
        message: not ok
        stack: |-
          Error: not ok
              at http://127.0.0.1:8080/x.js:1:1
        ...
      1..1
    `;
    const stream = new PassThrough();
    const tap = new XTestCliTap({ stream, color: true });
    assert.doesNotThrow(() => tap.write(blob));
    assert(stream.read().toString().length > 0);
    assert(tap.result.testNotOk === 1);
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

    const streamB = new PassThrough();
    const tapB = new XTestCliTap({ stream: streamB, color: false });
    for (const line of text.split('\n')) {
      tapB.write(line);
    }

    assert(streamA.read().toString() === streamB.read().toString());
  });
});

suite('lifecycle guards', () => {
  test('.result before the stream terminates throws', () => {
    const tap = new XTestCliTap({ stream: new PassThrough(), color: false });
    assert.throws(() => tap.result, /result accessed before end/);
  });

  test('.result after the stream terminates returns the frozen result', () => {
    const tap = new XTestCliTap({ stream: new PassThrough(), color: false });
    tap.write('TAP version 14\n1..0');
    assert.doesNotThrow(() => tap.result);
    // Repeated reads return the same object.
    assert(tap.result === tap.result);
  });

  test('write() after the stream terminates passes the line through raw', () => {
    const stream = new PassThrough();
    const tap = new XTestCliTap({ stream, color: false });
    tap.write('TAP version 14\nok 1 - a\n1..1');        // Plan terminates.
    const frozen = tap.result;
    tap.write('# trailing diagnostic\n');              // Post-end write.
    assert(tap.result === frozen);                     // Frozen result unchanged.
    const out = stream.read().toString();
    assert(out.includes('# trailing diagnostic\n'));   // But still rendered.
  });
});

suite('auto-end', () => {
  test('fires endStream on top-level plan (plan is terminal)', () => {
    let ended = 0;
    const tap = new XTestCliTap({
      stream: new PassThrough(),
      color:  false,
      endStream: () => { ended++; },
    });
    tap.write('TAP version 14\nok 1 - a\nok 2 - b\n1..2');
    assert(ended === 1);
    assert(tap.result.ok === true);
    assert(tap.result.testCount === 2);
  });

  test('fires endStream on Bail out!', () => {
    let ended = 0;
    const tap = new XTestCliTap({
      stream: new PassThrough(),
      color:  false,
      endStream: () => { ended++; },
    });
    tap.write('TAP version 14\nBail out! launch timeout');
    assert(ended === 1);
    assert(tap.result.ok === false);
    assert(tap.result.bailed === true);
  });

  test('fires on zero-plan (1..0) — empty runs are legitimate and must end promptly', () => {
    // Test files with no tests and filters that match nothing both legitimately
    //  produce `1..0`. Without auto-end here, those runs would hang to the
    //  global timeout.
    let ended = 0;
    const tap = new XTestCliTap({
      stream: new PassThrough(),
      color:  false,
      endStream: () => { ended++; },
    });
    tap.write('TAP version 14\n1..0');
    assert(ended === 1);
    assert(tap.result.ok === true);
    assert(tap.result.testCount === 0);
  });

  test('trailing asserts after auto-end render but do not re-fire endStream', () => {
    let ended = 0;
    const tap = new XTestCliTap({
      stream: new PassThrough(),
      color:  false,
      endStream: () => { ended++; },
    });
    tap.write('TAP version 14\nok 1 - a\n1..1');        // Auto-ends on plan line.
    tap.write('ok 2 - surprise');                      // Post-end, not counted.
    assert(ended === 1);
    assert(tap.result.testCount === 1);                // Frozen.
  });
});
