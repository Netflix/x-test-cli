#!/usr/bin/env node

import { readFileSync } from 'node:fs';

import { XTestCliBrowserPuppeteer, XTestCliBrowserPlaywright } from './x-test-cli-browser.js';
import { XTestCliTap } from './x-test-cli-tap.js';
import { XTestCliConfig } from './x-test-cli-config.js';
import { XTestCliCoverage } from './x-test-cli-coverage.js';

const cwd = process.cwd();

// Browser-launch timeout (ms). Applies only to the underlying puppeteer or
//  playwright `launch()` call — “fail fast if the browser can’t start.” Not a
//  run timeout.
const LAUNCH_TIMEOUT_MS = 10_000;

const HELP = `\
x-test — run TAP-compliant browser tests from the command line

  USAGE
    x-test --url=<url> --client=<name> --browser=<name> [options]

  REQUIRED OPTIONS
    --url <url>                 The test page to load (e.g. http://127.0.0.1:8080/test/).
                                (required, or set in x-test.config.js)

    --client <name>             Browser automation client. One of: puppeteer, playwright.
                                (required, or set in x-test.config.js)

    --browser <name>            Browser to launch.
                                  puppeteer:  chromium
                                  playwright: chromium, firefox, webkit
                                Coverage is supported only with chromium.
                                (required, or set in x-test.config.js)

  OPTIONS
    --coverage <boolean>        Collect JS and CSS coverage via Chromium DevTools.
                                Compares against goals defined in the config file
                                and emits a diagnostic block after the run. Exits
                                non-zero if a goal is not met. See “COVERAGE”
                                below. Default: false. Only supported with
                                “--browser=chromium”.

    --root <path>               Resource root of the URL origin — the directory the
                                dev server serves at “/”. Used to resolve
                                “coverageGoals” keys on disk. Must be “./”- or
                                “../”-prefixed (e.g. --root=./build). Default: cwd.

    --name-pattern <regex>      Regex pattern to filter tests by name. Tests whose
                                full path (file > describe > … > it) does not
                                match are skipped.

    --reporter <name>           Output format. One of: tap, auto. Default: auto.
                                  tap  — raw TAP (machine-readable, CI-safe).
                                  auto — colorized when stdout is a TTY, tap otherwise.

    --timeout <ms>              Per-test-file load timeout. Default: 30000.

    --help                      Print this message.
    --version                   Print the installed x-test version.

  CONFIG FILE
    If ./x-test.config.js exists in the current working directory, it is loaded
    automatically. CLI flags override config values.

    The “root” arg is the resource root of the URL origin — the directory the dev
    server serves at “/”. “coverageGoals” keys are paths inside that root, so
    they’re simultaneously root-relative on disk and origin-relative as URLs
    (the dev server mirrors the two). Both must be “./”- or “../”-prefixed.

      export default {
        url:      'http://127.0.0.1:8080/test/',
        root:     './src',
        client:   'playwright',
        browser:  'chromium',
        timeout:  30_000,
        coverage: true,
        coverageGoals: {
          './elements/emoji-picker.js':      { lines: 100 },
          './elements/subscribe-button.js':  { lines:  71 },
        },
      };

  COVERAGE
    A standard “./coverage/lcov.info” output will be produced when the
    coverage is active (config or via CLI arguments). Coverage is
    auto-disabled when “--name-pattern” is set — the numbers would only
    reflect the filtered subset of tests and misgrade the goals.

    The “coverageGoals” keys may target either JS or CSS files (or any path
    served by the dev server); the same { lines } axis applies to both.
    JS coverage comes from V8; CSS coverage comes from Chromium’s
    rule-usage tracker — both are reported as line percentages.

    The following pragmas (matching “node:coverage” patterns) are
    available and will be adhered to during coverage assessment.
    Block-comment syntax means they apply to JS and CSS alike:

      /* x-test:coverage disable */
      // ... region omitted from the report
      /* x-test:coverage enable */

      /* x-test:coverage ignore next */
      const unreachable = defensiveFallback;

      /* x-test:coverage ignore next 3 */
      if (process.env.NODE_ENV === 'development') {
        debugHelper();
      }

  NOTES
    In general, a development server must be running and responding to
    initiate tests via “x-test-cli”. The “--name-pattern” CLI argument
    maps to a browser-side “?x-test-name-pattern” search param on the
    resulting test page.

  EXAMPLES
    # Run with defaults from x-test.config.js
    x-test

    # One-off run, no config file
    x-test --url=http://127.0.0.1:8080/test/ --client=playwright --browser=chromium --coverage=true

    # Filter to a single describe block
    x-test --name-pattern="render"

    # CI matrix example — fan out across engines under playwright
    x-test --client=playwright --browser=chromium --reporter=tap
    x-test --client=playwright --browser=firefox  --reporter=tap
    x-test --client=playwright --browser=webkit   --reporter=tap

  EXIT CODES
    0   All tests passed (and, if --coverage=true, all goals met).
    1   Anything else — test failure, missed coverage goal, or invocation error.

  SEE ALSO
    https://github.com/Netflix/x-test
    https://github.com/Netflix/x-test-cli`;

/**
 * @param {string} message
 * @returns {never}
 */
function fail(message) {
  console.error(message); // eslint-disable-line no-console
  process.exit(1);
}

const args = process.argv.slice(2);

// Early-exit info flags — match anywhere in argv, ignore everything else,
//  exit 0. Standard CLI convention.
if (args.includes('--help')) {
  process.stdout.write(HELP + '\n');
  process.exit(0);
}
if (args.includes('--version')) {
  const pkgUrl = new URL('./package.json', import.meta.url);
  const pkg = JSON.parse(readFileSync(pkgUrl, 'utf8'));
  process.stdout.write(pkg.version + '\n');
  process.exit(0);
}

// Validate config, validate CLI, merge (CLI > config), resolve everything once.
//  Any failure in this block is an invocation error → exit 2.
/** @type {ReturnType<typeof XTestCliConfig.resolve>} */
let resolved;
try {
  const cliOptions    = XTestCliConfig.parseCli(args);
  const configOptions = await XTestCliConfig.load(cwd);
  XTestCliConfig.validateConfig(configOptions);
  XTestCliConfig.validateCli(cliOptions);
  resolved = XTestCliConfig.resolve({
    config: configOptions,
    cli:    cliOptions,
    cwd,
    env:    process.env,
    isTTY:  process.stdout.isTTY,
  });
} catch (error) {
  fail(`Error: ${error instanceof Error ? error.message : String(error)}`);
}

if (resolved.coverageDisabledByPattern) {
  console.warn('Note: --coverage disabled because --name-pattern is set. Coverage requires a full run.'); // eslint-disable-line no-console
}

// Own the TAP reporter here — the driver just emits browser console lines. The
//  reporter auto-ends when it parses a terminal TAP line (top-level plan
//  satisfied, or `Bail out!`); we bridge that to the driver via `streamEnded`,
//  so the driver knows when to stop collecting coverage and close the browser.
/** @type {PromiseWithResolvers<void>} */
const { promise: streamEnded, resolve: endStream } = Promise.withResolvers();
const tap = new XTestCliTap({
  stream:     process.stdout,
  color:      resolved.color,
  endStream,
  baseUrl:    resolved.baseUrl,
  sourceRoot: resolved.sourceRoot,
  cwd:        resolved.cwd,
});

// Captures the raw V8 coverage the driver collects so we can grade it after
//  the run. Populated only when `coverage === true`.
/** @type {import('./x-test-cli-coverage.js').CoverageEntry[] | null} */
let rawCoverageEntries = null;

/** @type {import('./x-test-cli-browser.js').DriverOptions} */
const driverOptions = {
  url:           resolved.url,
  browser:       resolved.browser,
  coverage:      resolved.coverage,
  launchTimeout: LAUNCH_TIMEOUT_MS,
  onConsole:     text    => tap.write(text),
  onCoverage:    entries => { rawCoverageEntries = entries; },
  ended:         streamEnded,
};

/**
 * Global run timeout. Races the driver against a timer — covers launch,
 * navigation, handshake, and coverage uniformly. The losing promise keeps
 * running, but we `process.exit(1)` below and the driver packages install
 * exit handlers that tear down Chromium.
 * @template T
 * @param {Promise<T>} promise
 * @param {number} ms
 * @param {string} message
 */
function withTimeout(promise, ms, message) {
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let timer;
  /** @type {Promise<T>} */
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// Run the browser driver. On any catastrophic failure (browser launch,
//  navigation, etc.) emit `Bail out!` through the reporter so it gets colorized
//  and the scanner records the bailed state, then dump the error to stderr
//  (outside the TAP stream) and exit 1.
const timeoutMessage = `Timed out after ${resolved.runTimeout}ms waiting for x-test root at ${resolved.url}. Use --timeout=<ms> to extend.`;
try {
  switch (resolved.client) {
    case 'puppeteer':
      await withTimeout(XTestCliBrowserPuppeteer.run(driverOptions), resolved.runTimeout, timeoutMessage);
      break;
    case 'playwright':
      await withTimeout(XTestCliBrowserPlaywright.run(driverOptions), resolved.runTimeout, timeoutMessage);
      break;
  }
} catch (error) {
  tap.write(`Bail out! The ${resolved.client} client crashed.`);
  console.error(error); // eslint-disable-line no-console
  process.exit(1);
}

// Grade coverage and emit the `# Coverage:` summary *before* finalizing the TAP
//  stream so the block lands inside the captured TAP output. x-test’s own
//  in-browser coverage diagnostic still prints in parallel this increment; a
//  later increment removes that path.
// Skip coverage entirely when tests failed — the run is already not-ok and
//  layering coverage on top is noise. Coverage is a secondary signal that
//  only matters once the primary one (test pass/fail) is green.
let coverageOk = true;
if (resolved.coverage && rawCoverageEntries && tap.result.ok) {
  try {
    // Synthesize entries for goal files the browser never loaded but that
    //  exist on disk — so the summary shows `0.0 / goal  not ok` with a real
    //  denominator and lcov shows the file all-red, rather than a terse
    //  “missing” notation.
    const synthetic = await XTestCliCoverage.synthesizeMissingEntries({
      entries:    rawCoverageEntries,
      baseUrl:    resolved.baseUrl,
      sourceRoot: resolved.sourceRoot,
      goals:      resolved.coverageGoals,
    });
    const allEntries = [...rawCoverageEntries, ...synthetic];
    await XTestCliCoverage.writeLcov({
      entries:    allEntries,
      outDir:     './coverage',
      baseUrl:    resolved.baseUrl,        // In-origin entries map to on-disk paths.
      sourceRoot: resolved.sourceRoot,
      goals:      resolved.coverageGoals,  // Only goal files appear in lcov.
    });
    const graded = XTestCliCoverage.gradeCoverage({
      entries: allEntries,
      baseUrl: resolved.baseUrl,
      goals:   resolved.coverageGoals,
    });
    coverageOk = graded.ok;
    tap.writeCoverage(graded.results);
  } catch (error) {
    console.error(error); // eslint-disable-line no-console
    fail('Coverage processing failed.');
  }
}

if (!tap.result.ok || !coverageOk) {
  process.exit(1);
}
