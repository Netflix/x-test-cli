import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { relative as relativePath, resolve as resolvePath } from 'node:path';

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
   */
  static computeLineHits(entry) {
    const { text, ranges } = entry;
    const spans = XTestCliCoverage.#lineSpans(text);
    const lines = spans.map(([s, e]) => text.slice(s, e));
    const ignored = XTestCliCoverage.#parsePragmas(lines);
    const covered = XTestCliCoverage.#coverageMap(text.length, ranges);

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
      total++;
      const state = XTestCliCoverage.#classifyLine(text, spans[index], covered);
      if (state === 'full') {
        hits++;
      }
      hitMap.set(lineNumber, state);
    }

    return { total, covered: hits, hitMap, ignoredLines: ignored };
  }

  /**
   * Grade the configured `goals` against the collected V8 `entries`. Goal paths
   * are resolved against `origin` (the test URL’s origin) using the standard
   * URL-base algorithm, `'./src/foo.js'` maps to `http://<origin>/src/foo.js` —
   * which is exactly the form V8 reports for the served scripts.
   *
   * Returns `{ ok, rows }`. `ok` is true iff every goal was met.
   */
  static gradeCoverage({ entries, origin, goals }) {
    // Duplicate entries (same URL, different executions) merge into one so a
    //  file loaded twice is graded on the union of its observed coverage, not
    //  on whichever execution happened to be first in the list.
    const prepared = XTestCliCoverage.#filterAndMerge(entries, origin, goals);
    const rows = [];
    for (const [path, spec] of Object.entries(goals)) {
      const resolvedUrl = new URL(path, origin + '/').href;
      const entry = prepared.find(item => item.url === resolvedUrl);
      if (!entry) {
        rows.push({
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
      rows.push({
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
    return { ok: rows.every(row => row.lines.met), rows };
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
   */
  static async synthesizeMissingEntries({ entries, origin, sourceRoot, goals }) {
    const known = new Set(entries.map(item => item.url));
    const synthetic = [];
    for (const path of Object.keys(goals ?? {})) {
      const resolvedUrl = new URL(path, origin + '/').href;
      if (known.has(resolvedUrl)) {
        continue;
      }
      const diskPath = resolvePath(sourceRoot, path);
      try {
        const text = await readFile(diskPath, 'utf8');
        synthetic.push({ url: resolvedUrl, text, ranges: [] });
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
   * `origin` and `sourceRoot` together produce filesystem paths in `SF:`
   * records (what lcov consumers like VSCode Coverage Gutters expect). Paths
   * are emitted **relative to `sourceRoot`** so the report stays portable
   * across machines and CI uploads.
   *
   * Resolves to the absolute path written.
   */
  static async writeLcov({ entries, outDir, origin, sourceRoot, goals }) {
    const dir = resolvePath(outDir);
    await mkdir(dir, { recursive: true });
    const path = resolvePath(dir, 'lcov.info');
    const prepared = XTestCliCoverage.#filterAndMerge(entries, origin, goals);
    await writeFile(path, XTestCliCoverage.#formatLcov(prepared, { origin, sourceRoot }));
    return path;
  }

  /**
   * TAP `#` diagnostic block for the coverage summary. Returns a single
   * newline-joined string the caller writes to the TAP stream verbatim.
   * Status token is native TAP vocabulary — `ok` / `not ok` — so readers
   * who scan TAP already know what it means.
   */
  static formatCoverageBlock({ result, lcovPath }) {
    // Columns we pad to max width across all rows:
    //   status   — “ok” or “not ok”                 (max width: 6)
    //   goal     — “65%” or “100%”                  (max width: 4)
    //   got      — “(got 60.64%)” or “(missing)”
    // Padding keeps the `| <path>` column visually aligned regardless of
    //  which rows are missing or have short percentages.
    const statusWidth = Math.max(0, ...result.rows.map(row => XTestCliCoverage.#statusOf(row).length));
    const goalWidth   = Math.max(0, ...result.rows.map(row => `${row.lines.goal}%`.length));
    const gotWidth    = Math.max(0, ...result.rows.map(row => XTestCliCoverage.#gotOf(row.lines).length));

    const rows = result.rows.map(row => {
      const status = XTestCliCoverage.#statusOf(row).padEnd(statusWidth, ' ');
      const goal   = `${row.lines.goal}%`.padEnd(goalWidth, ' ');
      const got    = XTestCliCoverage.#gotOf(row.lines).padEnd(gotWidth, ' ');
      return `# ${status} - ${goal} line coverage goal ${got} | ${row.path}`;
    });

    return [
      '# Coverage:',
      '#',
      ...rows,
      '#',
      `# (see ${lcovPath})`,
    ].join('\n');
  }

  static #statusOf(row) {
    return row.lines.met ? 'ok' : 'not ok';
  }

  static #gotOf(lines) {
    if (lines.missing) {
      return '(missing)';
    }
    return `(got ${XTestCliCoverage.#formatPercent(lines.percent)}%)`;
  }

  /**
   * Two decimal places, trailing zeros trimmed — so `100` stays `100`, `60.6`
   * stays `60.6`, and `60.6333…` renders as `60.63`. Matches the shape the user
   * specified without carrying spurious zeros.
   */
  static #formatPercent(value) {
    return Number(value.toFixed(2)).toString();
  }

  /**
   * Split `text` into `[start, end)` character spans, one per line. The `end`
   * offset is exclusive and does not include the line terminator — spans are
   * the line’s payload bytes only. Handles `\n`, `\r\n`, and lone `\r`
   * delimiters. Trailing line with no terminator is included.
   */
  static #lineSpans(text) {
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
   */
  static #parsePragmas(lines) {
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

  /** True iff the line contains only whitespace (by `#isWhitespaceCode`). */
  static #isBlank(line) {
    for (let index = 0; index < line.length; index++) {
      if (!XTestCliCoverage.#isWhitespaceCode(line.charCodeAt(index))) {
        return false;
      }
    }
    return true;
  }

  /**
   * Three-state classification of a line, ignoring whitespace bytes. Returns
   * `'full'` when every non-whitespace byte lies in a covered range, `'none'`
   * when none do, and `'partial'` when the line straddles the boundary (e.g.,
   * a one-line `if / else` where only one branch ran).
   */
  static #classifyLine(text, span, covered) {
    const [start, end] = span;
    let anyCovered   = false;
    let anyUncovered = false;
    for (let index = start; index < end; index++) {
      if (XTestCliCoverage.#isWhitespaceCode(text.charCodeAt(index))) {
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

  static #isWhitespaceCode(code) {
    return code === XTestCliCoverage.#CODE_SPACE
      || code === XTestCliCoverage.#CODE_TAB
      || code === XTestCliCoverage.#CODE_VTAB
      || code === XTestCliCoverage.#CODE_FORMFEED;
  }

  /** Two decimal places, rounded. */
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
   */
  static #formatLcov(entries, { origin, sourceRoot } = {}) {
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
        `SF:${XTestCliCoverage.#sourceFile(entry.url, origin, sourceRoot)}`,
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
   */
  static #filterAndMerge(entries, origin, goals) {
    const goalUrls = (goals && origin)
      ? new Set(Object.keys(goals).map(path => new URL(path, origin + '/').href))
      : null;
    const byUrl = new Map();
    for (const entry of entries) {
      if (goalUrls && !goalUrls.has(entry.url)) {
        continue;
      }
      const existing = byUrl.get(entry.url);
      if (existing) {
        existing.ranges = existing.ranges.concat(entry.ranges);
      } else {
        byUrl.set(entry.url, { url: entry.url, text: entry.text, ranges: [...entry.ranges] });
      }
    }
    return [...byUrl.values()];
  }

  /**
   * Map a V8 entry URL to the `SF:` value for its lcov record. When the URL
   * shares `origin`, return a filesystem path **relative to `sourceRoot`** —
   * the convention every major lcov consumer (Codecov, Coveralls, SonarQube,
   * VSCode Coverage Gutters, genhtml) expects, since absolute paths break when
   * `lcov.info` is moved between machines or uploaded from CI. Cross-origin
   * entries — or entries whose URL parses awkwardly — fall back to the URL
   * verbatim so the record stays unambiguous.
   */
  static #sourceFile(url, origin, sourceRoot) {
    if (!origin || !sourceRoot) {
      return url;
    }
    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      return url;
    }
    if (parsed.origin !== origin) {
      return url;
    }
    // Decode %xx escapes so on-disk filenames match, then strip the leading
    //  `/` so the path joins cleanly under `sourceRoot`.
    const decoded = decodeURIComponent(parsed.pathname).replace(/^\/+/, '');
    return relativePath(sourceRoot, resolvePath(sourceRoot, decoded));
  }
}
