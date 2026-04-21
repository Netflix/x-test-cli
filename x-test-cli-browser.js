import { Parser } from 'tap-parser';

export class XTestCliBrowserPuppeteer {
  /**
   * Run tests with optional coverage collection.
   * @param {Object} options - Configuration options
   * @param {string} options.url - Test page URL
   * @param {boolean} options.coverage - Whether to collect coverage
   * @param {Object} options.launchOptions - Puppeteer launch options
   */
  static async run(options) {
    let url = options?.url ?? null;
    const coverage = options?.coverage ?? false;
    const launchOptions = options?.launchOptions ?? {};

    let puppeteer;
    try {
      puppeteer = (await import('puppeteer')).default;
    } catch {
      const message = 'Error: "puppeteer" is not installed. Install it to use "--client=puppeteer".';
      console.error(new Error(message)); // eslint-disable-line no-console
      process.exit(1);
    }

    if (coverage) {
      const urlObj = new URL(url);
      urlObj.searchParams.set('x-test-run-coverage', '');
      url = urlObj.href;
    }

    try {
      // Launch browser
      const browser = await puppeteer.launch({
        timeout: 10_000,
        args: ['--no-sandbox', '--disable-setuid-sandbox'],
        ...launchOptions,
      });

      const page = await browser.newPage();

      // Start coverage collection if supported and requested
      if (coverage && page.coverage) {
        await page.coverage.startJSCoverage();
      }

      // Set up TAP parser for validation
      const parser = new Parser(results => {
        if (!results.ok) {
          process.exit(1);
        }
      });

      // Capture console output and parse as TAP
      page.on('console', message => {
        const text = message.text();
        console.log(text); // eslint-disable-line no-console
        parser.write(text + '\n');
      });

      // Navigate to test page
      await page.goto(url);

      // Wait for test readiness. The browser tells us whether it’s asking
      //  for coverage data — only call `cover()` when it is, otherwise we
      //  hang forever waiting for a second `x-test-root-end` that never comes.
      const { coverageRequested } = await page.evaluate(XTestCliBrowserPuppeteer.#runScript());

      // Handle coverage if the browser requested it.
      if (coverage && page.coverage && coverageRequested) {
        const js = await page.coverage.stopJSCoverage();
        await page.evaluate(XTestCliBrowserPuppeteer.#coverScript(), { js });
      }

      // Close parser
      parser.end();

      // Close browser
      await browser.close();
    } catch (error) {
      XTestCliBrowserPuppeteer.#bail(error);
    }
  }

  /**
   * Browser-injected factory: handshakes with x-test over BroadcastChannel
   * and resolves with `{ coverageRequested, ended }` — telling the caller
   * which terminal event fired, so coverage can be skipped when the root
   * didn’t ask for it.
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

  /**
   * Emit TAP `Bail out!` and exit non-zero on a catastrophic driver failure
   * (browser launch, navigation, etc. — anything thrown before or during run).
   */
  static #bail(error) {
    console.log('Bail out!'); // eslint-disable-line no-console
    console.error(error); // eslint-disable-line no-console
    process.exit(1);
  }
}

export class XTestCliBrowserPlaywright {
  /**
   * Run tests with optional coverage collection.
   * @param {Object} options - Configuration options
   * @param {string} options.url - Test page URL
   * @param {boolean} options.coverage - Whether to collect coverage
   * @param {Object} options.launchOptions - Playwright launch options
   */
  static async run(options) {
    let url = options?.url ?? null;
    const coverage = options?.coverage ?? false;
    const launchOptions = options?.launchOptions ?? {};

    let playwright;
    try {
      playwright = await import('playwright');
    } catch {
      const message = 'Error: "playwright" is not installed. Install it to use "--client=playwright".';
      console.error(new Error(message)); // eslint-disable-line no-console
      process.exit(1);
    }

    if (coverage) {
      const urlObj = new URL(url);
      urlObj.searchParams.set('x-test-run-coverage', '');
      url = urlObj.href;
    }

    try {
      // Launch browser
      const browser = await playwright.chromium.launch({
        timeout: 10_000,
        args: ['--no-sandbox', '--disable-setuid-sandbox'],
        ...launchOptions,
      });

      const page = await browser.newPage();

      // Start coverage collection if supported and requested
      if (coverage && page.coverage) {
        await page.coverage.startJSCoverage();
      }

      // Set up TAP parser for validation
      const parser = new Parser(results => {
        if (!results.ok) {
          process.exit(1);
        }
      });

      // Capture console output and parse as TAP
      page.on('console', message => {
        const text = message.text();
        console.log(text); // eslint-disable-line no-console
        parser.write(text + '\n');
      });

      // Navigate to test page
      await page.goto(url);

      // Wait for test readiness. The browser tells us whether it’s asking
      //  for coverage data — only call `cover()` when it is, otherwise we
      //  hang forever waiting for a second `x-test-root-end` that never comes.
      const { coverageRequested } = await page.evaluate(XTestCliBrowserPlaywright.#runScript());

      // Handle coverage if the browser requested it. Playwright’s raw V8
      //  shape needs to be normalized to match what Puppeteer emits so the
      //  downstream x-test code sees identical input regardless of client.
      if (coverage && page.coverage && coverageRequested) {
        const raw = await page.coverage.stopJSCoverage();
        const js = XTestCliBrowserPlaywright.#normalizeCoverage(raw);
        await page.evaluate(XTestCliBrowserPlaywright.#coverScript(), { js });
      }

      // Close parser
      parser.end();

      // Close browser
      await browser.close();
    } catch (error) {
      XTestCliBrowserPlaywright.#bail(error);
    }
  }

  /**
   * Reshape Playwright’s raw V8 coverage (`{source, functions}`) into
   * Puppeteer’s simplified `{text, ranges}` form.
   *
   * NOTE: first-pass normalization — flattens ranges with count > 0 without
   * merging overlapping ranges or subtracting nested uncovered blocks.
   * Follow-up will port Puppeteer’s `convertToDisjointRanges`.
   */
  static #normalizeCoverage(entries) {
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
   * and resolves with `{ coverageRequested, ended }` — telling the caller
   * which terminal event fired, so coverage can be skipped when the root
   * didn’t ask for it.
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

  /**
   * Emit TAP `Bail out!` and exit non-zero on a catastrophic driver failure
   * (browser launch, navigation, etc. — anything thrown before or during run).
   */
  static #bail(error) {
    console.log('Bail out!'); // eslint-disable-line no-console
    console.error(error); // eslint-disable-line no-console
    process.exit(1);
  }
}
