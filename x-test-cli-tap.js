/**
 * Single authority for TAP interpretation, result accumulation, and rendering.
 */
export class XTestCliTap {
  // Whole-line TAP patterns, iterated in declaration order.
  static #patterns = {
    yamlOpen:       /^\s*---\s*$/,
    bail:           /^\s*Bail out!(?:\s+(?<reason>.*?))?\s*$/,
    subtest:        /^\s*# Subtest:.*$/,
    failuresHeader: /^\s*# Failures:\s*$/,
    version:        /^\s*TAP [Vv]ersion\b.*$/,
    plan:           /^\s*(?<start>\d+)\.\.(?<end>\d+)(?:\s+#.*)?$/,
    testSkip:       /^\s*ok\b.*#\s*SKIP\b.*$/,
    testTodoOk:     /^\s*ok\b.*#\s*TODO\b.*$/,
    testTodoNotOk:  /^\s*not ok\b.*#\s*TODO\b.*$/,
    testOk:         /^\s*ok\b.*$/,
    testNotOk:      /^\s*not ok\b.*$/,
    comment:        /^\s*#.*$/,
    blank:          /^\s*$/,
    unknown:        /^/,
  };

  // Coverage-block patterns, used only by `writeCoverage`. The CLI writes its
  //  coverage diagnostic through a dedicated path so the styling applies
  //  regardless of whether the TAP stream has already ended.
  static #coveragePatterns = {
    coverageHeader:   /^\s*# Coverage:\s*$/,
    coverageRowOk:    /^\s*#\s+ok\s+-\s+\d+%\s+line coverage goal\b.*\|.*$/,
    coverageRowNotOk: /^\s*#\s+not ok\s+-\s+\d+%\s+line coverage goal\b.*\|.*$/,
    coverageReport:   /^\s*#\s+\(see\b.*\)\s*$/,
    coverageBlank:    /^\s*#\s*$/,
  };

  // YAML-specific, whole-line TAP patterns, iterated in declaration order.
  static #inYamlPatterns = {
    yamlClose:   /^\s*\.\.\.\s*$/,
    yamlUnknown: new RegExp(XTestCliTap.#patterns.unknown.source),
  };

  // Failure-specific, whole-line TAP patterns, iterated in declaration order.
  static #inFailurePatterns = {
    failureComment: new RegExp(XTestCliTap.#patterns.comment.source),
    failureBlank:   new RegExp(XTestCliTap.#patterns.blank.source),
    failureUnknown: new RegExp(XTestCliTap.#patterns.unknown.source),
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

  #stream;
  #color;
  #endStream;
  #state = {
    started:        false, // flipped true on `TAP version N`; gates all parsing
    inYaml:         false, // classification mode flag — inside a `---`/`...` block
    inFailureBlock: false, // classification mode flag — inside `# Failures:` trailer
    ended:          false, // set by terminal TAP line; gates write/result
    result:         null,  // frozen snapshot produced at end-of-stream
    planStart:      null,  // lower bound of the `N..M` plan (null = no plan seen)
    planEnd:        null,  // upper bound of the `N..M` plan
    testOk:         0,     // plain `ok` asserts
    testNotOk:      0,     // plain `not ok` asserts (drives exit code)
    testSkip:       0,     // `ok # SKIP` asserts
    testTodoOk:     0,     // `ok # TODO` asserts (unexpectedly passing)
    testTodoNotOk:  0,     // `not ok # TODO` asserts (expected failures)
    bailed:         false, // set on encountering a Bail out! line
    bailReason:     null,  // free text after `Bail out!`, if any
  };

  constructor({ stream, color, endStream }) {
    this.#stream    = stream;
    this.#color     = color;
    this.#endStream = endStream;
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
   * Render a CLI-produced `# Coverage:` diagnostic block. Styles header /
   * report / row lines regardless of whether the TAP stream has already ended —
   * the coverage block lands *after* the plan line by construction (driver
   * returns, CLI grades, CLI writes), so routing it through `write()` would put
   * it on the post-end raw-passthrough path.
   */
  writeCoverage(block) {
    const lines = block.split(/\r?\n/);
    if (lines.length > 0 && lines[lines.length - 1] === '') {
      lines.pop();
    }
    for (const line of lines) {
      let style;
      if (XTestCliTap.#coveragePatterns.coverageRowOk.test(line)) {
        style = XTestCliTap.#styles.green;
      } else if (XTestCliTap.#coveragePatterns.coverageRowNotOk.test(line)) {
        style = XTestCliTap.#styles.red;
      } else if (XTestCliTap.#coveragePatterns.coverageHeader.test(line)) {
        style = XTestCliTap.#styles.dim;
      } else if (XTestCliTap.#coveragePatterns.coverageReport.test(line)) {
        style = XTestCliTap.#styles.dim;
      } else if (XTestCliTap.#coveragePatterns.coverageBlank.test(line)) {
        style = XTestCliTap.#styles.dim;
      }
      this.#emit(line, style);
    }
  }

  /**
   * Aggregated result — available once the stream has ended (auto or
   * explicit). Accessing before that is a usage error.
   */
  get result() {
    if (!this.#state.ended) {
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
    if (planEnd !== null) {
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
    if (this.#endStream) {
      this.#endStream();
    }
  }

  /**
   * The single rendering path for every switch case. `style` is an ANSI opening
   * escape from `#styles` — omit it to pass the line through raw.
   */
  #emit(line, style) {
    const text = style && this.#color
      ? `${style}${line}${XTestCliTap.#styles.reset}`
      : line;
    this.#stream.write(text + '\n');
  }

  /**
   * Find the pattern that classifies `line`. State picks which set to
   * iterate; each set ends in a catch-all sentinel (`unknown`, `yamlUnknown`,
   * `failureUnknown`) so a hit is guaranteed.
   */
  #tryPatterns(line) {
    const patterns = this.#state.inYaml
      ? XTestCliTap.#inYamlPatterns
      : this.#state.inFailureBlock
        ? XTestCliTap.#inFailurePatterns
        : XTestCliTap.#patterns;
    for (const pattern of Object.values(patterns)) {
      const match = pattern.exec(line);
      if (match) {
        return { pattern, match };
      }
    }
    throw new Error('Invariant violated: every pattern set must end in a catch-all sentinel.');
  }

  /**
   * Classify one line, mutate state (counters, sticky flags, plan, bail), and
   * emit it through `#emit` with the style that matches its classification.
   * Every path through the switch sets `style` (or leaves it undefined for raw
   * passthrough), so the single call to `#emit` at the end renders uniformly.
   */
  #processLine(line) {
    // Only top-level plans and asserts feed counters; nested (indented) lines
    //  come from sub-tests that roll up to a parent assert. We render them but
    //  don’t count them.
    const atTopLevel = !/^\s/.test(line);
    const { pattern, match } = this.#tryPatterns(line);

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
        style = XTestCliTap.#styles.cyan;
        break;
      case XTestCliTap.#patterns.testSkip:
        this.#state.inFailureBlock = false;
        if (atTopLevel) {
          this.#state.testSkip++;
        }
        style = XTestCliTap.#styles.orange;
        break;
      case XTestCliTap.#patterns.testTodoOk:
        this.#state.inFailureBlock = false;
        if (atTopLevel) {
          this.#state.testTodoOk++;
        }
        style = XTestCliTap.#styles.yellow; // TODO that passed! Style yellow.
        break;
      case XTestCliTap.#patterns.testTodoNotOk:
        this.#state.inFailureBlock = false;
        if (atTopLevel) {
          this.#state.testTodoNotOk++;
        }
        style = XTestCliTap.#styles.orange;
        break;
      case XTestCliTap.#patterns.testOk:
        this.#state.inFailureBlock = false;
        if (atTopLevel) {
          this.#state.testOk++;
        }
        style = XTestCliTap.#styles.green;
        break;
      case XTestCliTap.#patterns.testNotOk:
        this.#state.inFailureBlock = false;
        if (atTopLevel) {
          this.#state.testNotOk++;
        }
        style = XTestCliTap.#styles.red;
        break;
      case XTestCliTap.#patterns.yamlOpen:
        this.#state.inYaml = true;
        style = XTestCliTap.#styles.dim;
        break;
      case XTestCliTap.#inYamlPatterns.yamlClose:
        this.#state.inYaml = false;
        style = XTestCliTap.#styles.dim;
        break;
      case XTestCliTap.#inYamlPatterns.yamlUnknown:
        // In-yaml body — dim the whole line regardless of its content.
        style = XTestCliTap.#styles.dim;
        break;
      case XTestCliTap.#patterns.failuresHeader:
        // Sticky: once the trailing failure re-iteration block starts,
        //  subsequent comments/blanks stay red until an assert fires.
        this.#state.inFailureBlock = true;
        style = XTestCliTap.#styles.red;
        break;
      case XTestCliTap.#inFailurePatterns.failureComment:
        style = XTestCliTap.#styles.red;
        break;
      case XTestCliTap.#inFailurePatterns.failureBlank:
        style = XTestCliTap.#styles.red;
        break;
      case XTestCliTap.#inFailurePatterns.failureUnknown:
        // Catch-all inside the failure block — everything reads as
        //  failure commentary regardless of shape.
        style = XTestCliTap.#styles.red;
        break;
      case XTestCliTap.#patterns.comment:
        style = XTestCliTap.#styles.dim;
        break;
      case XTestCliTap.#patterns.plan:
        if (atTopLevel) {
          this.#state.planStart = Number(match.groups.start);
          this.#state.planEnd   = Number(match.groups.end);
          this.#state.ended     = true; // Top-level plan is terminal.
        }
        style = XTestCliTap.#styles.dim;
        break;
      case XTestCliTap.#patterns.bail:
        this.#state.bailed = true;
        this.#state.bailReason = match.groups.reason ?? null;
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
