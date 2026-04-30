import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { relative as relativePath, resolve as resolvePath } from 'node:path';

/** @typedef {import('./x-test-cli-config.js').CoverageGoals} CoverageGoals */

/** @typedef {{ start: number, end: number }} CoverageRange */

/**
 * @typedef {object} CoverageEntry
 * @property {string} url
 * @property {string} text
 * @property {CoverageRange[]} ranges
 * @property {'js' | 'css'} kind
 */

/** @typedef {'full' | 'partial' | 'none'} LineState */

/**
 * @typedef {object} LineHits
 * @property {number} total
 * @property {number} covered
 * @property {Map<number, LineState>} hitMap
 * @property {Set<number>} ignoredLines
 */

/**
 * @typedef {object} CoverageGradeRow
 * @property {string} path
 * @property {string} resolvedUrl
 * @property {{ covered: number, total: number, percent: number, goal: number, met: boolean, missing: boolean }} lines
 */

/** @typedef {{ ok: boolean, results: CoverageGradeRow[] }} CoverageGradeResult */

/**
 * Coverage pipeline: V8 entries → per-line classification → grading +
 * lcov.info + TAP summary.
 */
export class XTestCliCoverage {
  // Source-level coverage pragmas. Mirrors `/* node:coverage ... */` directives
  //  so anyone fluent in Node’s test conventions is already fluent here.
  static #PRAGMA_DISABLE     = /\/\*\s*x-test:coverage\s+disable\s*\*\//;
  static #PRAGMA_ENABLE      = /\/\*\s*x-test:coverage\s+enable\s*\*\//;
  static #PRAGMA_IGNORE_NEXT = /\/\*\s*x-test:coverage\s+ignore\s+next(?:\s+(\d+))?\s*\*\//;

  // ASCII whitespace code points considered non-significant inside a line. We
  //  deliberately ignore Unicode whitespace — JS source files in practice use
  //  ASCII for indentation, and locale-dependent behavior isn’t worth the risk.
  static #CODE_SPACE    = 0x20; // ' '
  static #CODE_TAB      = 0x09; // '\t'
  static #CODE_VTAB     = 0x0b; // '\v'
  static #CODE_FORMFEED = 0x0c; // '\f'
  static #CODE_LF       = 0x0a; // '\n'
  static #CODE_CR       = 0x0d; // '\r'
  static #CODE_SLASH    = 0x2f; // '/'
  static #CODE_STAR     = 0x2a; // '*'

  /**
   * Per-line coverage for a single V8 entry.
   *
   * Input shape: the Puppeteer-normalized entry — `{ url, text, ranges }` where
   * each range is `{ start, end }` (character offsets into `text`). Playwright
   * entries are reshaped by the driver before reaching here, so this function
   * is driver-agnostic.
   *
   * Classification (per non-ignored, non-blank line):
   *   - `'full'`    — every non-whitespace character lies in a covered range.
   *   - `'partial'` — some non-whitespace characters are covered, some aren’t
   *                   (e.g., a single-line `if / else` where one branch ran).
   *   - `'none'`    — no non-whitespace character is covered.
   *
   * For **grading** we treat only `'full'` as covered — the strict rule,
   * honest about unseen branches that share a line with executed code, and
   * matches x-test’s prior behavior. For **lcov output** (see `#formatLcov`)
   * `'partial'` drives a third visual state via synthesized `BRDA` records,
   * so tools render partial lines yellow instead of red.
   *
   * Whitespace-only lines and pragma-ignored lines are excluded from both the
   * numerator and the denominator.
   * @param {CoverageEntry} entry
   * @returns {LineHits}
   */
  static computeLineHits(entry) {
    const { text, ranges, kind } = entry;
    const spans = XTestCliCoverage.#lineSpans(text);
    const lines = spans.map(([s, e]) => text.slice(s, e));
    const ignored = XTestCliCoverage.#parsePragmas(lines);
    const covered = XTestCliCoverage.#coverageMap(text.length, ranges);
    // CSS rule-usage tracking only marks matched-rule byte ranges as used,
    //  so lines that are entirely inside `/* ... */` block comments would
    //  otherwise drag the denominator down without ever being counted as
    //  covered. Strip them here, the same way blank lines and pragma-ignored
    //  lines are stripped. JS doesn't need this — V8's executed-scope ranges
    //  already cover comment bytes — so the mask is built only for CSS.
    const commentMask = kind === 'css' ? XTestCliCoverage.#cssCommentMask(text) : null;

    const hitMap = new Map();
    let total = 0;
    let hits =  0;

    for (let index = 0; index < spans.length; index++) {
      const lineNumber = index + 1; // 1-indexed for lcov.
      if (ignored.has(lineNumber)) {
        continue;
      }
      if (XTestCliCoverage.#isBlank(lines[index])) {
        continue;
      }
      if (commentMask && XTestCliCoverage.#isAllCommentOrBlank(text, spans[index], commentMask)) {
        continue;
      }
      total++;
      const state = XTestCliCoverage.#classifyLine(text, spans[index], covered, commentMask);
      if (state === 'full') {
        hits++;
      }
      hitMap.set(lineNumber, state);
    }

    return { total, covered: hits, hitMap, ignoredLines: ignored };
  }

  /**
   * Grade the configured `goals` against the collected V8 `entries`. Goal paths
   * are resolved against `baseUrl` (the test URL’s origin with trailing `/`)
   * using the standard URL-base algorithm, so `'./src/foo.js'` maps to
   * `<baseUrl>src/foo.js` — exactly the form V8 reports for the served scripts.
   *
   * Returns `{ ok, results }`. `ok` is true iff every goal was met.
   * @param {object} input
   * @param {CoverageEntry[]} input.entries
   * @param {string} input.baseUrl
   * @param {CoverageGoals | undefined} input.goals
   * @returns {CoverageGradeResult}
   */
  static gradeCoverage({ entries, baseUrl, goals }) {
    if (!goals) {
      // Unreachable from the entry script: `XTestCliConfig.resolve()` rejects
      //  `coverage=true` without `coverageGoals`, and the entry only calls
      //  this when `coverage` is on. Throw so a contract-breaking caller
      //  fails loudly instead of getting a silent ok-empty result.
      throw new Error('XTestCliCoverage.gradeCoverage: goals is required.');
    }
    // Duplicate entries (same URL, different executions) merge into one so a
    //  file loaded twice is graded on the union of its observed coverage, not
    //  on whichever execution happened to be first in the list.
    const prepared = XTestCliCoverage.#filterAndMerge(entries, baseUrl, goals);
    const results = [];
    for (const [path, spec] of Object.entries(goals)) {
      const resolvedUrl = new URL(path, baseUrl).href;
      const entry = prepared.find(item => item.url === resolvedUrl);
      if (!entry) {
        results.push({
          path,
          resolvedUrl,
          lines: {
            covered: 0,
            total:   0,
            percent: 0,
            goal:    spec.lines,
            met:     false,
            missing: true,
          },
        });
        continue;
      }
      const hits = XTestCliCoverage.computeLineHits(entry);
      const percent = hits.total === 0 ? 100 : XTestCliCoverage.#roundTwo(hits.covered / hits.total * 100);
      results.push({
        path,
        resolvedUrl,
        lines: {
          covered: hits.covered,
          total:   hits.total,
          percent,
          goal:    spec.lines,
          met:     percent >= spec.lines,
          missing: false,
        },
      });
    }
    return { ok: results.every(result => result.lines.met), results };
  }

  /**
   * Produce synthetic V8-shape entries for `coverageGoals` that the browser
   * never loaded but which exist on disk. This lets a file listed in config but
   * not actually imported by the test page fail the grading gracefully with
   * `0.0 / goal  not ok` rather than a terse “missing” notation — and also
   * makes the file show up in `lcov.info` with all lines red, which is the
   * honest signal for “you said to cover this but it never ran.”
   *
   * Goals that match no V8 entry AND don’t exist on disk fall through to
   * `gradeCoverage`’s `missing` path, which keeps the explicit “file not
   * found” notation for true typos in config.
   * @param {object} input
   * @param {CoverageEntry[]} input.entries
   * @param {string} input.baseUrl
   * @param {string} input.sourceRoot
   * @param {CoverageGoals | undefined} input.goals
   * @returns {Promise<CoverageEntry[]>}
   */
  static async synthesizeMissingEntries({ entries, baseUrl, sourceRoot, goals }) {
    const known = new Set(entries.map(item => item.url));
    /** @type {CoverageEntry[]} */
    const synthetic = [];
    for (const path of Object.keys(goals ?? {})) {
      const resolvedUrl = new URL(path, baseUrl).href;
      if (known.has(resolvedUrl)) {
        continue;
      }
      const diskPath = resolvePath(sourceRoot, path);
      try {
        const text = await readFile(diskPath, 'utf8');
        // `kind` defaults to `'js'`. Synthesized entries always carry empty
        //  ranges, so the value only matters as the merge-key suffix in
        //  `#filterAndMerge`; default is correct for any non-collision case.
        synthetic.push({ url: resolvedUrl, text, ranges: [], kind: 'js' });
      } catch {
        // Goal’s file doesn’t exist on disk either — leave it to
        //  gradeCoverage’s “missing” path so the row shows “file not found”.
      }
    }
    return synthetic;
  }

  /**
   * Write `lcov.info` into `outDir` (created if necessary). Only entries
   * matching a `coverageGoals` URL are emitted — lcov should describe what
   * the user asked to cover, nothing more, so editor integrations don’t show
   * coverage for test harness files or ad-hoc imports.
   *
   * When the browser loads the same script multiple times (iframe re-runs,
   * etc.) V8 reports a separate entry per execution. These are merged by URL so
   * each targeted file appears once in `lcov.info`, with the union of all
   * observed covered ranges.
   *
   * `baseUrl` and `sourceRoot` together produce filesystem paths in `SF:`
   * records (what lcov consumers like VSCode Coverage Gutters expect). Paths
   * are emitted **relative to `sourceRoot`** so the report stays portable
   * across machines and CI uploads.
   *
   * Resolves to the absolute path written.
   * @param {object} input
   * @param {CoverageEntry[]} input.entries
   * @param {string} input.outDir
   * @param {string} input.baseUrl
   * @param {string} input.sourceRoot
   * @param {CoverageGoals | undefined} input.goals
   */
  static async writeLcov({ entries, outDir, baseUrl, sourceRoot, goals }) {
    const dir = resolvePath(outDir);
    await mkdir(dir, { recursive: true });
    const path = resolvePath(dir, 'lcov.info');
    const prepared = XTestCliCoverage.#filterAndMerge(entries, baseUrl, goals);
    await writeFile(path, XTestCliCoverage.#formatLcov(prepared, { sourceRoot }));
    return path;
  }

  /**
   * Split `text` into `[start, end)` character spans, one per line. The `end`
   * offset is exclusive and does not include the line terminator — spans are
   * the line’s payload bytes only. Handles `\n`, `\r\n`, and lone `\r`
   * delimiters. Trailing line with no terminator is included.
   * @param {string} text
   */
  static #lineSpans(text) {
    /** @type {[number, number][]} */
    const spans = [];
    let start = 0;
    for (let index = 0; index < text.length; index++) {
      const code = text.charCodeAt(index);
      if (code === XTestCliCoverage.#CODE_LF) {
        spans.push([start, index]);
        start = index + 1;
      } else if (code === XTestCliCoverage.#CODE_CR) {
        spans.push([start, index]);
        if (index + 1 < text.length && text.charCodeAt(index + 1) === XTestCliCoverage.#CODE_LF) {
          index++;
        }
        start = index + 1;
      }
    }
    spans.push([start, text.length]); // Final line — may be empty.
    return spans;
  }

  /**
   * Build a boolean character-map: `covered[i] === 1` iff character `i` in the
   * source text falls in at least one range. Puppeteer delivers disjoint
   * `{start, end}` ranges so no merging is needed.
   * @param {number} length
   * @param {CoverageRange[]} ranges
   */
  static #coverageMap(length, ranges) {
    const map = new Uint8Array(length);
    for (const range of ranges) {
      const rangeStart = Math.max(0, range.start);
      const rangeEnd   = Math.min(length, range.end);
      for (let index = rangeStart; index < rangeEnd; index++) {
        map[index] = 1;
      }
    }
    return map;
  }

  /**
   * Walk the source line-by-line, honoring pragmas. Returns the set of
   * 1-indexed line numbers that should be excluded from coverage counting.
   *
   * Pragma lines are always excluded (they can’t be “covered” themselves).
   * `disable`/`enable` bracket a region. `ignore next N` applies to the next
   * N non-pragma lines — pragma lines inside the window don’t consume the
   * counter, which keeps `disable` inside `ignore next N` from double-counting.
   * @param {string[]} lines
   */
  static #parsePragmas(lines) {
    /** @type {Set<number>} */
    const ignored = new Set();
    let disabled        = false;
    let ignoreRemaining = 0;
    for (let index = 0; index < lines.length; index++) {
      const lineNumber  = index + 1;
      const line        = lines[index];
      const ignoreMatch = XTestCliCoverage.#PRAGMA_IGNORE_NEXT.exec(line);
      const isDisable   = XTestCliCoverage.#PRAGMA_DISABLE.test(line);
      const isEnable    = XTestCliCoverage.#PRAGMA_ENABLE.test(line);
      const isPragma    = isDisable || isEnable || ignoreMatch !== null;

      if (isPragma || disabled || ignoreRemaining > 0) {
        ignored.add(lineNumber);
      }
      if (!isPragma && ignoreRemaining > 0) {
        ignoreRemaining--;
      }
      if (isDisable) {
        disabled = true;
      } else if (isEnable) {
        disabled = false;
      } else if (ignoreMatch !== null) {
        const count = ignoreMatch[1] ? Number(ignoreMatch[1]) : 1;
        if (count > ignoreRemaining) {
          ignoreRemaining = count;
        }
      }
    }
    return ignored;
  }

  /**
   * True iff the line contains only whitespace (by `#isWhitespaceCode`).
   * @param {string} line
   */
  static #isBlank(line) {
    for (let index = 0; index < line.length; index++) {
      if (!XTestCliCoverage.#isWhitespaceCode(line.charCodeAt(index))) {
        return false;
      }
    }
    return true;
  }

  /**
   * Three-state classification of a line, ignoring whitespace bytes — and,
   * when a `commentMask` is supplied, bytes that fall inside CSS block
   * comments. Returns `'full'` when every significant byte lies in a covered
   * range, `'none'` when none do, and `'partial'` when the line straddles
   * the boundary (e.g., a one-line `if / else` where only one branch ran).
   * @param {string} text
   * @param {[number, number]} span
   * @param {Uint8Array} covered
   * @param {Uint8Array | null} commentMask
   */
  static #classifyLine(text, span, covered, commentMask) {
    const [start, end] = span;
    let anyCovered   = false;
    let anyUncovered = false;
    for (let index = start; index < end; index++) {
      if (XTestCliCoverage.#isWhitespaceCode(text.charCodeAt(index))) {
        continue;
      }
      if (commentMask && commentMask[index]) {
        continue;
      }
      if (covered[index]) {
        anyCovered = true;
      } else {
        anyUncovered = true;
      }
      if (anyCovered && anyUncovered) {
        return 'partial';
      }
    }
    return anyCovered ? 'full' : 'none';
  }

  /**
   * True iff every byte on `[span.start, span.end)` is whitespace or part of
   * a CSS block comment per `commentMask`. Used to drop comment-only lines
   * from the denominator the same way `#isBlank` drops whitespace-only lines.
   * @param {string} text
   * @param {[number, number]} span
   * @param {Uint8Array} commentMask
   */
  static #isAllCommentOrBlank(text, span, commentMask) {
    const [start, end] = span;
    for (let index = start; index < end; index++) {
      if (XTestCliCoverage.#isWhitespaceCode(text.charCodeAt(index))) {
        continue;
      }
      if (commentMask[index]) {
        continue;
      }
      return false;
    }
    return true;
  }

  /**
   * Build a byte-mask for CSS block comments: `mask[i] === 1` iff char `i`
   * lies within a slash-star … star-slash span (markers themselves
   * included). CSS has no line-comment syntax and no nested comments, so
   * the algorithm is a simple scan for an opener and the next closer.
   * Unterminated comments mark to end of text — defensive, since
   * unterminated comments are also a parse error for the browser, but
   * harmless here either way.
   *
   * Strings (`"…"` / `'…'`) are not tracked. CSS rarely embeds comment
   * markers inside string values, and the worst case if it ever happens is
   * over-stripping — at most a line or two excluded that arguably shouldn't
   * be. Not worth the parser complexity to handle precisely.
   * @param {string} text
   */
  static #cssCommentMask(text) {
    const mask = new Uint8Array(text.length);
    let index = 0;
    while (index < text.length - 1) {
      if (text.charCodeAt(index) === XTestCliCoverage.#CODE_SLASH
        && text.charCodeAt(index + 1) === XTestCliCoverage.#CODE_STAR) {
        let close = index + 2;
        while (close < text.length - 1) {
          if (text.charCodeAt(close) === XTestCliCoverage.#CODE_STAR
            && text.charCodeAt(close + 1) === XTestCliCoverage.#CODE_SLASH) {
            break;
          }
          close++;
        }
        const stop = close < text.length - 1 ? close + 2 : text.length;
        for (let mark = index; mark < stop; mark++) {
          mask[mark] = 1;
        }
        index = stop;
      } else {
        index++;
      }
    }
    return mask;
  }

  /**
   * @param {number} code
   */
  static #isWhitespaceCode(code) {
    return code === XTestCliCoverage.#CODE_SPACE
      || code === XTestCliCoverage.#CODE_TAB
      || code === XTestCliCoverage.#CODE_VTAB
      || code === XTestCliCoverage.#CODE_FORMFEED;
  }

  /**
   * Two decimal places, rounded.
   * @param {number} value
   */
  static #roundTwo(value) {
    return Math.round(value * 100) / 100;
  }

  /**
   * Serialize an array of entries to LCOV tracefile format.
   *
   * Per line, the classification from `computeLineHits` drives output:
   *   - `'full'`    → `DA:N,1`
   *   - `'partial'` → `DA:N,1` + synthesized `BRDA:N,0,0,1` + `BRDA:N,0,1,0`
   *                   so consumers (genhtml, VSCode Coverage Gutters, IntelliJ)
   *                   render the line yellow rather than red or green.
   *   - `'none'`    → `DA:N,0`
   *
   * `LF` / `LH` follow the LCOV convention (“any coverage counts as hit”) so
   * tools report the line total/hit pair internally consistent with the DA
   * records. The **strict** percentage surfaced in the TAP `# Coverage:`
   * summary is separate — see `gradeCoverage`.
   *
   * Whitespace-only and pragma-ignored lines are omitted from all records.
   * @param {CoverageEntry[]} entries
   * @param {{ sourceRoot: string }} options
   */
  static #formatLcov(entries, { sourceRoot }) {
    const records = [];
    for (const entry of entries) {
      const hits = XTestCliCoverage.computeLineHits(entry);
      const sortedLines = [...hits.hitMap.entries()].sort((a, b) => a[0] - b[0]);

      const daRecords   = [];
      const brdaRecords = [];
      let lineTotal  = 0;
      let lineHits   = 0;
      let branchTot  = 0;
      let branchHit  = 0;

      for (const [lineNumber, state] of sortedLines) {
        lineTotal++;
        const executed = state !== 'none';
        daRecords.push(`DA:${lineNumber},${executed ? 1 : 0}`);
        if (executed) {
          lineHits++;
        }
        if (state === 'partial') {
          // Synthesized: not real JS branches, just a byte-level partialness
          //  signal. One taken + one not-taken is the minimum pair genhtml et
          //  al. need to render the line yellow.
          brdaRecords.push(`BRDA:${lineNumber},0,0,1`);
          brdaRecords.push(`BRDA:${lineNumber},0,1,0`);
          branchTot += 2;
          branchHit += 1;
        }
      }

      const body = [
        'TN:',
        `SF:${XTestCliCoverage.#sourceFile(entry.url, sourceRoot)}`,
        ...daRecords,
        `LF:${lineTotal}`,
        `LH:${lineHits}`,
      ];
      if (brdaRecords.length > 0) {
        body.push(...brdaRecords, `BRF:${branchTot}`, `BRH:${branchHit}`);
      }
      body.push('end_of_record');
      records.push(body.join('\n'));
    }
    return records.join('\n') + '\n';
  }

  /**
   * Narrow `entries` to just the URLs named in `coverageGoals` (if any) and
   * collapse duplicate-URL entries into one with the union of their ranges.
   *
   * The deduping matters because V8 emits a separate entry per script load — a
   * test page that re-runs itself in an iframe would otherwise produce two
   * records per targeted file. We concatenate ranges without merging
   * overlapping spans: `#coverageMap` ORs them together, so any overlap is
   * already handled correctly at the byte level.
   *
   * Merge key is `(url, kind)` rather than `url` alone so the (theoretical)
   * case of a single URL producing both JS and CSS coverage entries — e.g. a
   * CSS module script — keeps the two streams separate. Each kind grades and
   * renders independently in lcov.
   * @param {CoverageEntry[]} entries
   * @param {string | undefined} baseUrl
   * @param {CoverageGoals | undefined} goals
   * @returns {CoverageEntry[]}
   */
  static #filterAndMerge(entries, baseUrl, goals) {
    const goalUrls = (goals && baseUrl)
      ? new Set(Object.keys(goals).map(path => new URL(path, baseUrl).href))
      : null;
    const byKey = new Map();
    for (const entry of entries) {
      if (goalUrls && !goalUrls.has(entry.url)) {
        continue;
      }
      const key = `${entry.url}::${entry.kind}`;
      const existing = byKey.get(key);
      if (existing) {
        existing.ranges = existing.ranges.concat(entry.ranges);
      } else {
        const { url, text, ranges, kind } = entry;
        byKey.set(key, { url, text, ranges: [...ranges], kind });
      }
    }
    return [...byKey.values()];
  }

  /**
   * Map a V8 entry URL to the `SF:` value for its lcov record: a filesystem
   * path **relative to `sourceRoot`** — the convention every major lcov
   * consumer expects, since absolute paths break when `lcov.info` is moved
   * between machines or uploaded from CI.
   *
   * Entries reaching this function are always same-origin with `baseUrl`:
   * `#filterAndMerge` only retains entries whose URLs are in the goal-URL
   * set, and goal URLs are constructed from `coverageGoals` keys (relative
   * paths) resolved against `baseUrl`.
   * @param {string} url
   * @param {string} sourceRoot
   */
  static #sourceFile(url, sourceRoot) {
    // Decode %xx escapes so on-disk filenames match, then strip the leading
    //  `/` so the path joins cleanly under `sourceRoot`.
    const decoded = decodeURIComponent(new URL(url).pathname).replace(/^\/+/, '');
    return relativePath(sourceRoot, resolvePath(sourceRoot, decoded));
  }
}
