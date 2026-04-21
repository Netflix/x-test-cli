/**
 * Puppeteer driver. `run(options)` launches Chromium via puppeteer,
 * handshakes with x-test, forwards each browser console event through
 * `onConsole(text)`, and closes.
 */
export class XTestCliBrowserPuppeteer {
  static async run({ url, coverage, launchOptions, launchTimeout, onConsole }) {
    if (coverage) {
      const urlObj = new URL(url);
      urlObj.searchParams.set('x-test-run-coverage', '');
      url = urlObj.href;
    }

    let puppeteer;
    try {
      puppeteer = (await import('puppeteer')).default;
    } catch {
      throw new Error('"puppeteer" is not installed. Install it to use "--client=puppeteer".');
    }

    const browser = await puppeteer.launch({
      timeout: launchTimeout,
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
      ...launchOptions,
    });
    const page = await browser.newPage();

    if (coverage) {
      if (!page.coverage) {
        throw new Error('Coverage was requested but `page.coverage` is unavailable in this browser.');
      }
      await page.coverage.startJSCoverage();
    }

    page.on('console', message => {
      onConsole(message.text());
    });

    await page.goto(url);

    const { coverageRequested } = await page.evaluate(XTestCliBrowserPuppeteer.#runScript());

    if (coverage && coverageRequested) {
      // Puppeteer already emits `{text, ranges}` — no normalization needed.
      const js = await page.coverage.stopJSCoverage();
      await page.evaluate(XTestCliBrowserPuppeteer.#coverScript(), { js });
    }

    await browser.close();
  }

  /**
   * Browser-injected factory: handshakes with x-test over BroadcastChannel
   * and resolves once the run has ended (or coverage has been requested).
   */
  static #runScript() {
    return async () => {
      const channel = new BroadcastChannel('x-test');
      return new Promise(resolve => {
        const onMessage = evt => {
          const { type, data } = evt.data;
          let resolution = null;
          switch (type) {
            case 'x-test-root-coverage-request':
              resolution = { coverageRequested: true, ended: false };
              break;
            case 'x-test-root-end':
              resolution = { coverageRequested: false, ended: true };
              break;
            case 'x-test-root-pong':
              if (data.waiting || data.ended) {
                resolution = { coverageRequested: !!data.waiting, ended: !!data.ended };
              }
              break;
          }
          if (resolution) {
            channel.removeEventListener('message', onMessage);
            channel.close();
            resolve(resolution);
          }
        };
        channel.addEventListener('message', onMessage);
        channel.postMessage({ type: 'x-test-client-ping' });
      });
    };
  }

  /**
   * Browser-injected factory: posts coverage results back to the x-test root,
   * resolves when it signals end-of-run.
   */
  static #coverScript() {
    return async (data) => {
      const channel = new BroadcastChannel('x-test');
      return new Promise(resolve => {
        const onMessage = evt => {
          const { type } = evt.data;
          if (type === 'x-test-root-end') {
            channel.removeEventListener('message', onMessage);
            channel.close();
            resolve();
          }
        };
        channel.addEventListener('message', onMessage);
        channel.postMessage({ type: 'x-test-client-coverage-result', data });
      });
    };
  }
}

/**
 * Playwright driver. `run(options)` launches Chromium via playwright,
 * handshakes with x-test, forwards each browser console event through
 * `onConsole(text)`, normalizes V8 coverage to Puppeteer's shape, and closes.
 */
export class XTestCliBrowserPlaywright {
  static async run({ url, coverage, launchOptions, launchTimeout, onConsole }) {
    if (coverage) {
      const urlObj = new URL(url);
      urlObj.searchParams.set('x-test-run-coverage', '');
      url = urlObj.href;
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
      ...launchOptions,
    });
    const page = await browser.newPage();

    if (coverage) {
      if (!page.coverage) {
        throw new Error('Coverage was requested but `page.coverage` is unavailable in this browser.');
      }
      await page.coverage.startJSCoverage();
    }

    page.on('console', message => {
      onConsole(message.text());
    });

    await page.goto(url);

    const { coverageRequested } = await page.evaluate(XTestCliBrowserPlaywright.#runScript());

    if (coverage && coverageRequested) {
      const raw = await page.coverage.stopJSCoverage();
      const js = XTestCliBrowserPlaywright.normalizeCoverage(raw);
      await page.evaluate(XTestCliBrowserPlaywright.#coverScript(), { js });
    }

    await browser.close();
  }

  /**
   * Reshape Playwright's raw V8 coverage (`{source, functions}`) into
   * Puppeteer's `{text, ranges}` form so downstream x-test processing
   * sees identical input regardless of client.
   *
   * NOTE: first-pass normalization — flattens ranges with count > 0
   * without merging overlapping ranges or subtracting nested uncovered
   * blocks. Follow-up will port Puppeteer's `convertToDisjointRanges`.
   */
  static normalizeCoverage(entries) {
    return entries.map(({ url, scriptId, source, functions }) => {
      const ranges = [];
      for (const fn of functions ?? []) {
        for (const r of fn.ranges ?? []) {
          if (r.count > 0) {
            ranges.push({ start: r.startOffset, end: r.endOffset });
          }
        }
      }
      return { url, scriptId, text: source, ranges };
    });
  }

  /**
   * Browser-injected factory: handshakes with x-test over BroadcastChannel
   * and resolves once the run has ended (or coverage has been requested).
   */
  static #runScript() {
    return async () => {
      const channel = new BroadcastChannel('x-test');
      return new Promise(resolve => {
        const onMessage = evt => {
          const { type, data } = evt.data;
          let resolution = null;
          switch (type) {
            case 'x-test-root-coverage-request':
              resolution = { coverageRequested: true, ended: false };
              break;
            case 'x-test-root-end':
              resolution = { coverageRequested: false, ended: true };
              break;
            case 'x-test-root-pong':
              if (data.waiting || data.ended) {
                resolution = { coverageRequested: !!data.waiting, ended: !!data.ended };
              }
              break;
          }
          if (resolution) {
            channel.removeEventListener('message', onMessage);
            channel.close();
            resolve(resolution);
          }
        };
        channel.addEventListener('message', onMessage);
        channel.postMessage({ type: 'x-test-client-ping' });
      });
    };
  }

  /**
   * Browser-injected factory: posts coverage results back to the x-test root,
   * resolves when it signals end-of-run.
   */
  static #coverScript() {
    return async (data) => {
      const channel = new BroadcastChannel('x-test');
      return new Promise(resolve => {
        const onMessage = evt => {
          const { type } = evt.data;
          if (type === 'x-test-root-end') {
            channel.removeEventListener('message', onMessage);
            channel.close();
            resolve();
          }
        };
        channel.addEventListener('message', onMessage);
        channel.postMessage({ type: 'x-test-client-coverage-result', data });
      });
    };
  }
}
