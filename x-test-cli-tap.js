/** @typedef {import('./x-test-cli-coverage.js').CoverageGradeRow} CoverageGradeRow */

/**
 * @typedef {object} TapResult
 * @property {boolean} ok
 * @property {number} testOk
 * @property {number} testNotOk
 * @property {number} testSkip
 * @property {number} testTodoOk
 * @property {number} testTodoNotOk
 * @property {number} testCount
 * @property {number | null} planStart
 * @property {number | null} planEnd
 * @property {boolean} bailed
 * @property {string | null} bailReason
 */

/** @typedef {{ breadcrumb: string[], stackLines: string[] }} PendingFailure */

/**
 * Single authority for TAP interpretation, result accumulation, and rendering.
 */
export class XTestCliTap {
  // Whole-line TAP patterns, iterated in declaration order. `subtest` and
  //  `testNotOk` carry named captures (name / description) that failure
  //  synthesis reads from the dispatch match — same precedent as `plan`
  //  and `bail` already use for their groups.
  static #patterns = {
    yamlOpen:       /^\s*---\s*$/,
    bail:           /^\s*Bail out!(?:\s+(?<reason>.*?))?\s*$/,
    subtest:        /^\s*# Subtest:\s*(?<name>.*?)\s*$/,
    version:        /^\s*TAP [Vv]ersion\b.*$/,
    plan:           /^\s*(?<start>\d+)\.\.(?<end>\d+)(?:\s+#.*)?$/,
    testSkip:       /^\s*ok\b.*#\s*SKIP\b.*$/,
    testTodoOk:     /^\s*ok\b.*#\s*TODO\b.*$/,
    testTodoNotOk:  /^\s*not ok\b.*#\s*TODO\b.*$/,
    testOk:         /^\s*ok\b.*$/,
    testNotOk:      /^\s*not ok\b(?:\s+\d+)?\s*(?:-\s*)?(?<description>.*?)\s*$/,
    comment:        /^\s*#.*$/,
    blank:          /^\s*$/,
    unknown:        /^/,
  };

  // YAML-specific, whole-line TAP patterns, iterated in declaration order.
  //  `yamlStackKey` matches the `stack: |-` block-scalar header inside a
  //  diagnostic; capture is the key's indent (synthesis uses it as the
  //  strip column for the lines beneath).
  static #inYamlPatterns = {
    yamlClose:    /^\s*\.\.\.\s*$/,
    yamlStackKey: /^(?<indent>\s*)stack:\s*\|-?\s*$/,
    yamlUnknown:  new RegExp(XTestCliTap.#patterns.unknown.source),
  };

  // Named ANSI styles to colorize / stylize stdout text.
  static #styles = {
    reset:   '\x1b[0m',
    dim:     '\x1b[2m',
    boldRed: '\x1b[1;31m',
    red:     '\x1b[31m',
    green:   '\x1b[32m',
    yellow:  '\x1b[33m',
    orange:  '\x1b[38;5;208m',
    cyan:    '\x1b[36m',
  };

  /** @type {{ write: (chunk: string) => unknown }} */
  #stream;
  /** @type {boolean} */
  #color;
  /** @type {(() => void) | undefined} */
  #endStream;
  // All three carry a trailing `/` — caller's contract. `#rewriteUrl` chains
  //  substring substitutions and a missing slash would corrupt the output.
  /** @type {string} */
  #baseUrl;                             // URL prefix — paired with `#sourceRoot` to project stack-line URLs to disk paths
  /** @type {string} */
  #sourceRoot;                          // absolute fs path — the disk projection of `#baseUrl`
  /** @type {string} */
  #cwd;                                 // absolute fs path — output paths render relative to this
  /** @type {string[]} */
  #parents          = [];               // currently-active subtest names: pushed on `# Subtest:`, popped on the inner `1..N` plan that closes it
  /** @type {PendingFailure[]} */
  #failures         = [];               // accumulated `{ breadcrumb, stackLines }` — drained by `#finalize`
  /** @type {PendingFailure | null} */
  #pendingFailure   = null;             // set on a leaf `not ok`; promoted to `#failures` on yamlClose iff we collected stack lines
  /** @type {number | null} */
  #stackIndent      = null;             // strip column for stack lines, set when `yamlStackKey` fires inside a pendingFailure's yaml
  #state = {
    started:        false,                  // flipped true on `TAP version N`; gates all parsing
    inYaml:         false,                  // classification mode flag — inside a `---`/`...` block
    ended:          false,                  // set by terminal TAP line; gates write/result
    /** @type {TapResult | null} */
    result:         null,                   // frozen snapshot produced at end-of-stream
    /** @type {number | null} */
    planStart:      null,                   // lower bound of the `N..M` plan (null = no plan seen)
    /** @type {number | null} */
    planEnd:        null,                   // upper bound of the `N..M` plan
    testOk:         0,                      // plain `ok` asserts
    testNotOk:      0,                      // plain `not ok` asserts (drives exit code)
    testSkip:       0,                      // `ok # SKIP` asserts
    testTodoOk:     0,                      // `ok # TODO` asserts (unexpectedly passing)
    testTodoNotOk:  0,                      // `not ok # TODO` asserts (expected failures)
    bailed:         false,                  // set on encountering a Bail out! line
    /** @type {string | null} */
    bailReason:     null,                   // free text after `Bail out!`, if any
  };

  /**
   * @param {object} options
   * @param {{ write: (chunk: string) => unknown }} options.stream
   * @param {boolean} options.color
   * @param {(() => void) | undefined} options.endStream
   * @param {string} options.baseUrl
   * @param {string} options.sourceRoot
   * @param {string} options.cwd
   */
  constructor({ stream, color, endStream, baseUrl, sourceRoot, cwd }) {
    this.#stream     = stream;
    this.#color      = color;
    this.#endStream  = endStream;
    this.#baseUrl    = baseUrl;
    this.#sourceRoot = sourceRoot;
    this.#cwd        = cwd;
  }

  /**
   * Feed a blob of TAP text. May contain embedded `\n` or `\r\n` — the browser
   * delivers multi-line YAML diagnostics as a single console.log call.
   * Splitting on `\r?\n` absorbs Windows line endings as part of the delimiter
   * so downstream classification sees clean lines with no trailing `\r`.
   *
   * Lines are accepted even after the stream has auto-ended — TAP allows
   * trailing diagnostics after `Bail out!` and (non-canonically) after the
   * plan. We still render them but the frozen `result` is not updated.
   * @param {string} blob
   */
  write(blob) {
    // A trailing `\n` terminates the final line — don’t treat it as a
    //  separator that opens a phantom empty line after it.
    const lines = blob.split(/\r?\n/);
    if (lines.length > 0 && lines[lines.length - 1] === '') {
      lines.pop();
    }
    for (const line of lines) {
      this.#processLine(line);
    }
  }

  /**
   * Synthesize and render the `# Coverage:` block from structured grading
   * rows. Styles every line uniformly — `red` when any goal failed, `dim`
   * otherwise. Caller gates on test-pass: when tests fail, coverage is
   * skipped (don't muddy a failing run with secondary signals). Routing
   * this through `write()` would put it on the post-end raw-passthrough
   * path, hence the dedicated entry point. Mirrors `#emitFailureBlock`'s
   * "structured-data → comment-block" shape.
   * @param {CoverageGradeRow[]} results
   */
  writeCoverage(results) {
    const ok = results.every(result => result.lines.met);
    const style = ok ? XTestCliTap.#styles.dim : XTestCliTap.#styles.red;
    // Columns padded to max width across all results:
    //   status — "ok" or "not ok"           (max width: 6)
    //   goal   — "65%" or "100%"            (max width: 4)
    //   got    — "(got 60.64%)" or "(missing)"
    // Padding keeps the `| <path>` column aligned regardless of which
    //  results are missing or have short percentages.
    /** @param {CoverageGradeRow} result */
    const statusOf = result => result.lines.met ? 'ok' : 'not ok';
    /** @param {CoverageGradeRow} result */
    const gotOf    = result => result.lines.missing
      ? '(missing)'
      : `(got ${Number(result.lines.percent.toFixed(2))}%)`;
    const statusWidth = Math.max(0, ...results.map(result => statusOf(result).length));
    const goalWidth   = Math.max(0, ...results.map(result => `${result.lines.goal}%`.length));
    const gotWidth    = Math.max(0, ...results.map(result => gotOf(result).length));

    this.#emit('# Coverage:', style);
    this.#emit('#',           style);
    for (const result of results) {
      const status = statusOf(result).padEnd(statusWidth, ' ');
      const goal   = `${result.lines.goal}%`.padEnd(goalWidth, ' ');
      const got    = gotOf(result).padEnd(gotWidth, ' ');
      this.#emit(`# ${status} - ${goal} line coverage goal ${got} | ${result.path}`, style);
    }
  }

  /**
   * Aggregated result — available once the stream has ended (auto or
   * explicit). Accessing before that is a usage error.
   * @returns {TapResult}
   */
  get result() {
    if (!this.#state.ended || !this.#state.result) {
      throw new Error('XTestCliTap: result accessed before end().');
    }
    return this.#state.result;
  }

  /**
   * Snapshot the current state as `result` and invoke the `endStream`
   * callback. Called from `#processLine` after a terminal TAP line
   * (top-level plan, or `Bail out!`) flipped `#state.ended`.
   */
  #finalize() {
    let ok = true;
    const {
      testOk, testNotOk, testSkip, testTodoOk, testTodoNotOk,
      planStart, planEnd, bailed, bailReason,
    } = this.#state;
    if (bailed) {
      ok = false;
    }
    if (testNotOk > 0) {
      ok = false;
    }
    const testCount = testOk + testNotOk + testSkip + testTodoOk + testTodoNotOk;
    if (planEnd !== null && planStart !== null) {
      const planned = planEnd - planStart + 1;
      if (planned !== testCount) {
        ok = false;
      }
    }
    this.#state.result = {
      ok,
      testOk, testNotOk, testSkip, testTodoOk, testTodoNotOk, testCount,
      planStart, planEnd, bailed, bailReason,
    };
    this.#emitFailureBlock();
    if (this.#endStream) {
      this.#endStream();
    }
  }

  /**
   * Render the trailing `# Failures:` summary from accumulated leaf failures.
   * Owned by the CLI (not the in-browser test runner) so we can rewrite stack
   * URLs to local paths, keep x-test minimal, and avoid a fragile contract
   * where two layers must agree on the format.
   */
  #emitFailureBlock() {
    if (this.#failures.length === 0) {
      return;
    }
    this.#emit('# Failures:', XTestCliTap.#styles.red);
    for (const failure of this.#failures) {
      this.#emit('# ', XTestCliTap.#styles.red);
      const [url, ...descriptions] = failure.breadcrumb;
      // Leave the top url form intact. Rewriting it to a path lands on a
      //  directory (the URL is typically served as `index.html`), and the
      //  original URL is the actual link a developer would open to repro the
      //  failure in a browser.
      this.#emit(`# ${url}`, XTestCliTap.#styles.red);
      for (const description of descriptions) {
        this.#emit(`# > ${description}`, XTestCliTap.#styles.red);
      }
      for (const line of failure.stackLines) {
        this.#emit(line === '' ? '#' : `# ${line}`, XTestCliTap.#styles.red);
      }
    }
  }

  /**
   * Two-step substring rewrite:
   *   1. `<baseUrl>` → `<sourceRoot>/` projects the served URL into its on-
   *      disk location (both fully-qualified, so the swap is honest).
   *   2. `<cwd>/`     → `''`            strips the cwd prefix so output is
   *      bare cwd-relative (`x-test-cli-tap.js:200:5`).
   * Each step no-ops when its substring isn't present — frames from another
   * host or node:internal URLs pass through verbatim. Splitting steps lets
   * `sourceRoot` and `cwd` differ (e.g. `root: './public'` puts sourceRoot
   * one level below cwd, and output renders `public/foo.js` rather than
   * losing the `public/` prefix).
   * @param {string} text
   */
  #rewriteUrl(text) {
    return text.split(this.#baseUrl).join(this.#sourceRoot).split(this.#cwd).join('');
  }

  /**
   * The single rendering path for every switch case. `style` is an ANSI opening
   * escape from `#styles` — omit it to pass the line through raw.
   * @param {string} line
   * @param {string} [style]
   */
  #emit(line, style) {
    const text = style && this.#color
      ? `${style}${line}${XTestCliTap.#styles.reset}`
      : line;
    this.#stream.write(text + '\n');
  }

  /**
   * Find the pattern that classifies `line`. State picks which set to
   * iterate; each set ends in a catch-all sentinel (`unknown`, `yamlUnknown`)
   * so a hit is guaranteed.
   * @param {string} line
   * @returns {{ pattern: RegExp, match: RegExpExecArray }}
   */
  #tryPatterns(line) {
    // Yaml mode picks the yaml set, otherwise the main set. Both end in a
    //  catch-all sentinel (`/^/`) so a hit is guaranteed.
    const patterns = this.#state.inYaml ? XTestCliTap.#inYamlPatterns : XTestCliTap.#patterns;
    for (const pattern of Object.values(patterns)) {
      const match = pattern.exec(line);
      if (match) {
        return { pattern, match };
      }
    }
    // Unreachable — every pattern set ends in a catch-all sentinel.
    throw new Error('XTestCliTap: no pattern matched (catch-all sentinel missing).');
  }

  /**
   * Classify one line, mutate state (counters, sticky flags, plan, bail), and
   * emit it through `#emit` with the style that matches its classification.
   * Every path through the switch sets `style` (or leaves it undefined for raw
   * passthrough), so the single call to `#emit` at the end renders uniformly.
   * @param {string} line
   */
  #processLine(line) {
    // Only top-level plans and asserts feed counters; nested (indented) lines
    //  come from sub-tests that roll up to a parent assert. We render them but
    //  don’t count them.
    const atTopLevel = !/^\s/.test(line);
    const { pattern, match } = this.#tryPatterns(line);
    const groups = match.groups ?? {};

    if (this.#state.ended) {
      // Post-end: lines that arrive after the terminal TAP line pass
      //  through raw. The CLI’s `# Coverage:` block is written via
      //  `writeCoverage()` so it gets styled there, not here.
      this.#emit(line);
      return;
    } else if (!this.#state.started && pattern !== XTestCliTap.#patterns.version) {
      // Pre-start: before `TAP version N`, nothing is meaningful TAP —
      //  pass lines through raw without classification.
      this.#emit(line);
      return;
    }

    let style;
    switch (pattern) {
      case XTestCliTap.#patterns.version:
        this.#state.started = true; // TAP version kicks things off.
        style = XTestCliTap.#styles.dim;
        break;
      case XTestCliTap.#patterns.subtest:
        // Push entering the subtest; the matching inner `1..N` plan pops.
        this.#parents.push(groups.name ?? '');
        this.#pendingFailure = null;                    // rollups never trail a subtest header
        style = XTestCliTap.#styles.cyan;
        break;
      case XTestCliTap.#patterns.testSkip:
        if (atTopLevel) {
          this.#state.testSkip++;
        }
        style = XTestCliTap.#styles.orange;
        break;
      case XTestCliTap.#patterns.testTodoOk:
        if (atTopLevel) {
          this.#state.testTodoOk++;
        }
        style = XTestCliTap.#styles.yellow; // TODO that passed! Style yellow.
        break;
      case XTestCliTap.#patterns.testTodoNotOk:
        if (atTopLevel) {
          this.#state.testTodoNotOk++;
        }
        style = XTestCliTap.#styles.orange;
        break;
      case XTestCliTap.#patterns.testOk:
        if (atTopLevel) {
          this.#state.testOk++;
        }
        style = XTestCliTap.#styles.green;
        break;
      case XTestCliTap.#patterns.testNotOk: {
        if (atTopLevel) {
          this.#state.testNotOk++;
        }
        // Stash a candidate failure. Promoted to `#failures` only if a yaml
        //  block follows AND its `stack: |-` collects lines — that's how we
        //  distinguish a leaf from a subtest rollup like
        //  `not ok 3 - http://.../test-suite.html`.
        const description = (groups.description ?? '').trim();
        const breadcrumb = [...this.#parents, description];
        /** @type {string[]} */
        const stackLines = [];
        this.#pendingFailure = { breadcrumb, stackLines };
        style = XTestCliTap.#styles.red;
        break;
      }
      case XTestCliTap.#patterns.yamlOpen:
        this.#state.inYaml = true;
        style = XTestCliTap.#styles.dim;
        break;
      case XTestCliTap.#inYamlPatterns.yamlClose:
        this.#state.inYaml = false;
        if (this.#pendingFailure) {
          this.#failures.push(this.#pendingFailure);
        }
        this.#pendingFailure   = null;
        this.#stackIndent = null;
        style = XTestCliTap.#styles.dim;
        break;
      case XTestCliTap.#inYamlPatterns.yamlStackKey:
        if (this.#pendingFailure) {
          // The block-scalar header sits at `<keyIndent>stack: |-`; lines
          //  beneath are indented by keyIndent + 2 (yaml convention).
          this.#stackIndent = (groups.indent ?? '').length + 2;
        }
        style = XTestCliTap.#styles.dim;
        break;
      case XTestCliTap.#inYamlPatterns.yamlUnknown:
        // In-yaml body — dim the whole line regardless of its content.
        //  When we're inside the active stack block, also collect each line
        //  (stripped + URL-rewritten) into the pending failure's stackLines.
        if (this.#pendingFailure && this.#stackIndent !== null) {
          if (line.trim() === '') {
            this.#pendingFailure.stackLines.push('');
          } else if (line.length >= this.#stackIndent) {
            this.#pendingFailure.stackLines.push(this.#rewriteUrl(line.slice(this.#stackIndent)));
          }
        }
        style = XTestCliTap.#styles.dim;
        break;
      case XTestCliTap.#patterns.comment:
        style = XTestCliTap.#styles.dim;
        break;
      case XTestCliTap.#patterns.plan:
        if (atTopLevel) {
          this.#state.planStart = Number(groups.start);
          this.#state.planEnd   = Number(groups.end);
          this.#state.ended     = true; // Top-level plan is terminal.
        } else {
          // Inner plan closes the most recently opened subtest. Pairs with
          //  the `push` in the subtest arm so the stack always reflects
          //  currently-active subtests.
          this.#parents.pop();
        }
        style = XTestCliTap.#styles.dim;
        break;
      case XTestCliTap.#patterns.bail:
        this.#state.bailed = true;
        this.#state.bailReason = groups.reason ?? null;
        this.#state.ended = true; // Bail is terminal.
        style = XTestCliTap.#styles.boldRed;
        break;
      case XTestCliTap.#patterns.blank:
        // Raw — leave `style` undefined.
        break;
      case XTestCliTap.#patterns.unknown:
        // Non-TAP noise — leave `style` undefined to pass through raw.
        break;
    }
    this.#emit(line, style);
    if (this.#state.ended) {
      this.#finalize();
    }
  }
}
