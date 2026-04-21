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
  #state = {
    inYaml:         false, // classification mode flag — inside a `---`/`...` block
    inFailureBlock: false, // classification mode flag — inside `# Failures:` trailer
    ended:          false, // set by end(); gates write/end/result
    result:         null,  // frozen snapshot produced by end()
    plan:           null,  // captured at the 1..N line, checked at end
    pass:           0,     // passing asserts
    fail:           0,     // failing asserts (drives exit code)
    skip:           0,     // `# SKIP`-directive asserts
    todo:           0,     // `# TODO`-directive not-ok asserts (expected failures)
    count:          0,     // total asserts seen, validated against plan
    bailed:         false, // set on encountering a Bail out! line
    bailReason:     null,  // free text after `Bail out!`, if any
  };

  constructor({ stream, color }) {
    this.#stream = stream;
    this.#color = color;
  }

  /**
   * Feed a blob of TAP text. May contain embedded `\n` or `\r\n` — the browser
   * delivers multi-line YAML diagnostics as a single console.log call.
   * Splitting on `\r?\n` absorbs Windows line endings as part of the delimiter
   * so downstream classification sees clean lines with no trailing `\r`.
   */
  write(blob) {
    if (this.#state.ended) {
      throw new Error('XTestCliTap: write() called after end().');
    }
    // A trailing `\n` terminates the final line — don't treat it as a
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
   * Finalize. The aggregated result is thereafter available on `.result`.
   */
  end() {
    if (this.#state.ended) {
      throw new Error('XTestCliTap: end() called more than once.');
    }
    let ok = true;
    if (this.#state.bailed) {
      ok = false;
    }
    if (this.#state.fail > 0) {
      ok = false;
    }
    if (this.#state.plan) {
      const planned = this.#state.plan.end - this.#state.plan.start + 1;
      if (planned !== this.#state.count) {
        ok = false;
      }
    }
    this.#state.result = {
      ok,
      pass: this.#state.pass,
      fail: this.#state.fail,
      skip: this.#state.skip,
      todo: this.#state.todo,
      count: this.#state.count,
      plan: this.#state.plan,
      bailed: this.#state.bailed,
      bailReason: this.#state.bailReason,
    };
    this.#state.ended = true;
  }

  /**
   * Aggregated result, available only after `end()` has been called.
   */
  get result() {
    if (!this.#state.ended) {
      throw new Error('XTestCliTap: result accessed before end().');
    }
    return this.#state.result;
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
    const { pattern, match } = this.#tryPatterns(line);

    // Only top-level plans and asserts feed our counters / plan state. Indented
    //  lines come from nested sub-tests, which producers self-validate and roll
    //  up to a parent assert — so the top-level count + plan is the right
    //  signal for exit code. We render nested lines (colorize) but don’t factor
    //  them into `count`. If we ever want per-subtest stats, we’d need a scope
    //  stack. For a CLI exit-code, the top-level rollup is enough.
    const atTopLevel = !/^\s/.test(line);

    let style;
    switch (pattern) {
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
      case XTestCliTap.#patterns.bail:
        this.#state.bailed = true;
        this.#state.bailReason = match.groups.reason ?? null;
        style = XTestCliTap.#styles.boldRed;
        break;
      case XTestCliTap.#patterns.subtest:
        style = XTestCliTap.#styles.cyan;
        break;
      case XTestCliTap.#patterns.failuresHeader:
        // Sticky: once the trailing failure re-iteration block starts,
        //  subsequent comments/blanks stay red until an assert fires.
        this.#state.inFailureBlock = true;
        style = XTestCliTap.#styles.red;
        break;
      case XTestCliTap.#patterns.version:
        style = XTestCliTap.#styles.dim;
        break;
      case XTestCliTap.#patterns.plan:
        if (atTopLevel) {
          const start = Number(match.groups.start);
          const end = Number(match.groups.end);
          this.#state.plan = { start, end };
        }
        style = XTestCliTap.#styles.dim;
        break;
      case XTestCliTap.#patterns.testSkip:
        this.#state.inFailureBlock = false;
        if (atTopLevel) {
          this.#state.count++;
          this.#state.skip++;
        }
        style = XTestCliTap.#styles.orange;
        break;
      case XTestCliTap.#patterns.testTodoOk:
        this.#state.inFailureBlock = false;
        if (atTopLevel) {
          this.#state.count++;
          this.#state.pass++;
        }
        style = XTestCliTap.#styles.yellow; // TODO that passed! Style yellow.
        break;
      case XTestCliTap.#patterns.testTodoNotOk:
        this.#state.inFailureBlock = false;
        if (atTopLevel) {
          this.#state.count++;
          this.#state.todo++;
        }
        style = XTestCliTap.#styles.orange;
        break;
      case XTestCliTap.#patterns.testOk:
        this.#state.inFailureBlock = false;
        if (atTopLevel) {
          this.#state.count++;
          this.#state.pass++;
        }
        style = XTestCliTap.#styles.green;
        break;
      case XTestCliTap.#patterns.testNotOk:
        this.#state.inFailureBlock = false;
        if (atTopLevel) {
          this.#state.count++;
          this.#state.fail++;
        }
        style = XTestCliTap.#styles.red;
        break;
      case XTestCliTap.#patterns.comment:
        style = XTestCliTap.#styles.dim;
        break;
      case XTestCliTap.#inFailurePatterns.failureComment:
        style = XTestCliTap.#styles.red;
        break;
      case XTestCliTap.#patterns.blank:
        // Raw — leave `style` undefined.
        break;
      case XTestCliTap.#inFailurePatterns.failureBlank:
        style = XTestCliTap.#styles.red;
        break;
      case XTestCliTap.#inFailurePatterns.failureUnknown:
        // Catch-all inside the failure block — everything reads as
        //  failure commentary regardless of shape.
        style = XTestCliTap.#styles.red;
        break;
      case XTestCliTap.#patterns.unknown:
        // Non-TAP noise — leave `style` undefined to pass through raw.
        break;
    }
    this.#emit(line, style);
  }
}
