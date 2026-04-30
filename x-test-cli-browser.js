/** @typedef {import('./x-test-cli-coverage.js').CoverageRange} CoverageRange */

/** @typedef {import('./x-test-cli-coverage.js').CoverageEntry} CoverageEntry */

/** @typedef {{ startOffset: number, endOffset: number, count: number }} V8FunctionRange */

/**
 * @typedef {object} V8FunctionCoverage
 * @property {V8FunctionRange[]} [ranges]
 */

/**
 * Raw V8 coverage entry as Playwright reports it (one record per executed
 * script). Puppeteer's stop-coverage shape is different — see `CoverageEntry`.
 * `source` is typed optional to match Playwright's own declarations; in
 * practice the script tag is always set, so `normalizeCoverage` doesn't guard.
 * @typedef {object} PlaywrightV8Entry
 * @property {string} url
 * @property {string} scriptId
 * @property {string} [source]
 * @property {V8FunctionCoverage[]} [functions]
 */

/**
 * Raw CSS coverage entry from Playwright. Same shape as Puppeteer's CSS
 * coverage, so the normalizer is mostly a defensive shape copy. `text` is
 * typed optional to match Playwright's own declarations.
 * @typedef {object} PlaywrightCssEntry
 * @property {string} url
 * @property {string} [text]
 * @property {CoverageRange[]} [ranges]
 */

/**
 * @typedef {object} DriverOptions
 * @property {string} url
 * @property {string} browser
 * @property {boolean} coverage
 * @property {number} launchTimeout
 * @property {(text: string) => void} onConsole
 * @property {(entries: CoverageEntry[]) => void} onCoverage
 * @property {Promise<unknown>} ended
 */

/**
 * Puppeteer driver. `run(options)` launches Chromium via puppeteer, wires each
 * browser console line through `onConsole(text)`, awaits `ended` (the caller’s
 * signal that the TAP stream has terminated — typically a Promise resolved by
 * the TAP parser when it sees a top-level plan or `Bail out!`), surfaces V8
 * and CSS coverage via `onCoverage(entries)`, and closes. Entries are tagged
 * with `kind` (`'js'` or `'css'`) so downstream merging can disambiguate the
 * (theoretical) case of one URL appearing in both collectors.
 */
export class XTestCliBrowserPuppeteer {
  /**
   * @param {DriverOptions} options
   */
  static async run({ url, browser: browserName, coverage, launchTimeout, onConsole, onCoverage, ended }) {
    if (browserName !== 'chromium') {
      throw new Error(`"--client=puppeteer" only supports "--browser=chromium" (got "${browserName}").`);
    }
    let puppeteer;
    try {
      puppeteer = (await import('puppeteer')).default;
    } catch {
      throw new Error('"puppeteer" is not installed. Install it to use "--client=puppeteer".');
    }

    const browser = await puppeteer.launch({
      browser: 'chrome',
      timeout: launchTimeout,
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
    });
    try {
      const page = await browser.newPage();

      page.on('console', message => {
        onConsole(message.text());
      });

      if (coverage) {
        await Promise.all([
          page.coverage.startJSCoverage(),
          page.coverage.startCSSCoverage(),
        ]);
      }

      await page.setExtraHTTPHeaders({ Accept: 'text/html' });
      const response = await page.goto(url);
      if (response && response.status() >= 400) {
        throw new Error(`Got HTTP ${response.status()} for ${url}. Is the url correct?`);
      }

      await ended;

      if (coverage) {
        // Puppeteer already emits `{text, ranges}` for both JS and CSS — no
        //  normalization needed. Tag with `kind` and concatenate.
        const [js, css] = await Promise.all([
          page.coverage.stopJSCoverage(),
          page.coverage.stopCSSCoverage(),
        ]);
        /** @type {CoverageEntry[]} */
        const tagged = [
          ...js.map(entry  => ({ ...entry, kind: /** @type {const} */ ('js')  })),
          ...css.map(entry => ({ ...entry, kind: /** @type {const} */ ('css') })),
        ];
        onCoverage(tagged);
      }
    } finally {
      await browser.close();
    }
  }
}

/**
 * Playwright driver. `run(options)` launches Chromium via playwright, wires
 * each browser console line through `onConsole(text)`, awaits `ended` (the
 * caller’s signal that the TAP stream has terminated — typically a Promise
 * resolved by the TAP parser when it sees a top-level plan or `Bail out!`),
 * normalizes V8 coverage into Puppeteer’s shape, surfaces it via
 * `onCoverage(entries)`, and closes.
 */
export class XTestCliBrowserPlaywright {
  /**
   * @param {DriverOptions} options
   */
  static async run({ url, browser: browserName, coverage, launchTimeout, onConsole, onCoverage, ended }) {
    if (browserName !== 'chromium') {
      throw new Error(`"--client=playwright" only supports "--browser=chromium" (got "${browserName}").`);
    }
    let playwright;
    try {
      playwright = await import('playwright');
    } catch {
      throw new Error('"playwright" is not installed. Install it to use "--client=playwright".');
    }

    const browser = await playwright.chromium.launch({
      timeout: launchTimeout,
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
    });
    try {
      const page = await browser.newPage();

      page.on('console', message => {
        onConsole(message.text());
      });

      if (coverage) {
        await Promise.all([
          page.coverage.startJSCoverage(),
          page.coverage.startCSSCoverage(),
        ]);
      }

      await page.setExtraHTTPHeaders({ Accept: 'text/html' });
      const response = await page.goto(url);
      if (response && response.status() >= 400) {
        throw new Error(`Got HTTP ${response.status()} for ${url}. Is the url correct?`);
      }

      await ended;

      if (coverage) {
        const [rawJs, rawCss] = await Promise.all([
          page.coverage.stopJSCoverage(),
          page.coverage.stopCSSCoverage(),
        ]);
        const js  = XTestCliBrowserPlaywright.normalizeCoverage(rawJs)
          .map(entry => ({ ...entry, kind: /** @type {const} */ ('js') }));
        const css = XTestCliBrowserPlaywright.normalizeCssCoverage(rawCss)
          .map(entry => ({ ...entry, kind: /** @type {const} */ ('css') }));
        onCoverage([...js, ...css]);
      }
    } finally {
      await browser.close();
    }
  }

  /**
   * Reshape Playwright’s raw V8 coverage (`{source, functions}`) into
   * Puppeteer’s `{text, ranges}` form so downstream processing is
   * driver-agnostic. Runs `convertToDisjointRanges` over the union of every
   * function’s nested ranges so inner `count === 0` sub-blocks (e.g., unseen
   * branches of an executed function) are subtracted from their outer
   * `count > 0` parent. Without this step Playwright reports looser coverage
   * than Puppeteer for the same run.
   * @param {PlaywrightV8Entry[]} entries
   * @returns {{ url: string, scriptId: string, text: string, ranges: CoverageRange[] }[]}
   */
  static normalizeCoverage(entries) {
    return entries.map(({ url, scriptId, source, functions }) => {
      /** @type {V8FunctionRange[]} */
      const nested = [];
      for (const fn of functions ?? []) {
        for (const range of fn.ranges ?? []) {
          nested.push(range);
        }
      }
      return { url, scriptId, text: source ?? '', ranges: XTestCliBrowserPlaywright.convertToDisjointRanges(nested) };
    });
  }

  /**
   * Pass Playwright’s raw CSS coverage through with a defensive shape copy.
   * Playwright already emits `{url, text, ranges:[{start, end}]}` — same
   * shape as Puppeteer’s CSS coverage — so unlike `normalizeCoverage`
   * (which has to flatten V8’s nested function ranges) this is just a
   * shallow remap that drops any extra fields and guards against a
   * missing `ranges` array.
   * @param {PlaywrightCssEntry[]} entries
   * @returns {{ url: string, text: string, ranges: CoverageRange[] }[]}
   */
  static normalizeCssCoverage(entries) {
    return entries.map(({ url, text, ranges }) => ({
      url,
      text: text ?? '',
      ranges: (ranges ?? []).map(range => ({ start: range.start, end: range.end })),
    }));
  }

  /**
   * Flatten V8’s nested range tree into the disjoint `{start, end}` spans
   * Puppeteer returns directly. The algorithm is the same one Puppeteer uses
   * internally: a sweep over range start / end events, maintaining a stack of
   * currently-active ranges (outermost at bottom, innermost on top). Between
   * events, the innermost range’s count wins — so an enclosing `count=1` scope
   * is overridden by an `count=0` inner block for that block’s extent. We emit
   * only non-zero segments and merge adjacent same-count segments on the fly.
   * @param {V8FunctionRange[]} nested
   * @returns {CoverageRange[]}
   */
  static convertToDisjointRanges(nested) {
    /** @type {{ offset: number, delta: number, range: V8FunctionRange }[]} */
    const events = [];
    for (const range of nested) {
      events.push({ offset: range.startOffset, delta:  1, range });
      events.push({ offset: range.endOffset,   delta: -1, range });
    }
    // Sort rules at equal offset:
    //   - ends (delta=-1) fire before starts (delta=+1) so an ending range is
    //     off the stack before a new one begins;
    //   - among starts: wider ranges (outer) before narrower (inner), so the
    //     inner lands on top of the stack;
    //   - among ends: narrower ranges (inner) before wider (outer), so the
    //     inner comes off first.
    events.sort((a, b) => {
      if (a.offset !== b.offset) { return a.offset - b.offset; }
      if (a.delta  !== b.delta)  { return a.delta  - b.delta;  }
      const lenA = a.range.endOffset - a.range.startOffset;
      const lenB = b.range.endOffset - b.range.startOffset;
      return a.delta === 1 ? lenB - lenA : lenA - lenB;
    });

    /** @type {V8FunctionRange[]} */
    const stack    = [];
    /** @type {{ start: number, end: number, count: number }[]} */
    const segments = [];
    let lastOffset = 0;
    for (const event of events) {
      if (stack.length > 0 && event.offset > lastOffset) {
        const count    = stack[stack.length - 1].count;
        const previous = segments.length ? segments[segments.length - 1] : null;
        if (previous && previous.end === lastOffset && previous.count === count) {
          previous.end = event.offset;                // Merge adjacent same-count segments.
        } else {
          segments.push({ start: lastOffset, end: event.offset, count });
        }
      }
      lastOffset = event.offset;
      if (event.delta === 1) {
        stack.push(event.range);
      } else {
        const index = stack.lastIndexOf(event.range);
        if (index !== -1) {
          stack.splice(index, 1);
        }
      }
    }
    return segments
      .filter(segment => segment.count > 0)
      .map(segment => ({ start: segment.start, end: segment.end }));
  }
}
