#!/usr/bin/env node

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { XTestCliBrowserPuppeteer, XTestCliBrowserPlaywright } from './x-test-cli-browser.js';
import { XTestCliTap } from './x-test-cli-tap.js';
import { XTestCliConfig } from './x-test-cli-config.js';
import { XTestCliCoverage } from './x-test-cli-coverage.js';

const cwd = process.cwd();

const SUPPORTED_CLIENTS = ['puppeteer', 'playwright'];
const SUPPORTED_REPORTERS = ['tap', 'auto'];

// Value-taking flags (always `--key=value`). `--help` and `--version` are
//  handled as bare flags in the early-exit block below, so they’re not here.
const ALLOWED_ARGS = ['client', 'url', 'root', 'coverage', 'name-pattern', 'reporter', 'timeout'];
const ALLOWED_ARGS_DEBUG = ALLOWED_ARGS.map(arg => `"--${arg}"`).join(', ');

const HELP = `\
x-test — run TAP-compliant browser tests from the command line                                                                                                                           

  USAGE
    x-test --url=<url> --client=<name> --browser=<name> [options]

  REQUIRED OPTIONS
    --url <url>                 The test page to load (e.g. http://127.0.0.1:8080/test/).
                                (required, or set in x-test.config.js)

    --client <name>             Browser automation client. One of: puppeteer, playwright.
                                (required, or set in x-test.config.js)

    --browser <name>            Browser to launch. One of: chromium, firefox, webkit.
                                puppeteer supports chromium only.
                                (required, or set in x-test.config.js)

  OPTIONS
    --coverage <boolean>        Collect JS coverage via Chromium DevTools. Compares
                                against goals defined in the config file and emits a
                                diagnostic block after the run. Exits non-zero if a goal is
                                not met. See “COVERAGE” below. Default: false.
                                Only supported with chromium-based clients.

    --root <path>               Resource root of the URL origin — the directory the
                                dev server serves at “/”. Used to resolve
                                “coverageGoals” keys on disk. Must be “./”- or
                                “../”-prefixed (e.g. --root=./build). Default: cwd.

    --name-pattern <regex>      Regex pattern to filter tests by name. Tests whose
                                full path (file > describe > … > it) does not
                                match are skipped.
 
    --reporter <name>           Output format. One of: tap, spec, auto. Default: auto.
                                  tap  — raw TAP (machine-readable, CI-safe).
                                  spec — colorized, human-readable summary.
                                  auto — spec if stdout is a TTY, tap otherwise.

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

    The following pragmas (matching “node:coverage” patterns) are
    available and will be adhered to during coverage assessment:

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

    # CI matrix example
    x-test --client=playwright --browser=firefox --reporter=tap

  EXIT CODES
    0   All tests passed (and, if --coverage=true, all goals met).
    1   One or more tests failed, or a coverage goal was not met.
    2   Invocation error (bad flag, missing url, client not installed).

  SEE ALSO
    https://github.com/Netflix/x-test
    https://github.com/Netflix/x-test-cli`;

// Exit code 2 is reserved for invocation errors where the request itself is
//  malformed — distinct from a passing-but-not-ok run (1) or a successful
//  run (0). Only one path claims it this increment: `--coverage` without
//  `coverageGoals`. Other invocation errors still use 1 until a later
//  increment restructures the exit-code surface.
function fail(message, code = 1) {
  console.error(message); // eslint-disable-line no-console
  process.exit(code);
}

// Parse command line arguments
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

const cliOptions = {};

for (const arg of args) {
  if (arg.startsWith('--')) {
    const [key, value] = arg.slice(2).split('=', 2);

    if (!ALLOWED_ARGS.includes(key)) {
      fail(`Error: Unknown argument "--${key}".\nAllowed arguments: ${ALLOWED_ARGS_DEBUG}.`);
    }

    if (value === undefined) {
      fail(`Error: Argument "--${key}" requires a value (e.g., "--${key}=<value>").`);
    }

    // kebab-case flag → camelCase internal key, e.g. `name-pattern` → `namePattern`.
    const camelKey = key.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    cliOptions[camelKey] = value;
  } else {
    fail(`Error: Invalid argument "${arg}". All arguments must start with "--".`);
  }
}

// Load `x-test.config.js` from cwd if present; empty object otherwise. CLI
//  flags override config values via the spread order below.
let configOptions;
try {
  configOptions = await XTestCliConfig.load(cwd);
} catch (error) {
  fail(`Error: failed to load x-test.config.js: ${error.message}`);
}
const options = { ...configOptions, ...cliOptions };

if (!options.client) {
  fail('Error: "--client" is required (e.g., "--client=puppeteer").');
}

if (!options.url) {
  fail('Error: "--url" is required (e.g., "--url=http://localhost:8080/test/").');
}

if (!SUPPORTED_CLIENTS.includes(options.client)) {
  const supported = SUPPORTED_CLIENTS.map(client => `"${client}"`).join(', ');
  fail(`Error: Unsupported client "${options.client}". Supported clients: ${supported}.`);
}

// Coverage flag. CLI flags arrive as strings; config may set a real boolean.
//  Either is accepted.
let coverage = false;
if (options.coverage === true || options.coverage === 'true') {
  coverage = true;
} else if (options.coverage !== undefined && options.coverage !== false && options.coverage !== 'false') {
  fail(`Error: --coverage must be "true" or "false", got "${options.coverage}".`);
}

// The `root` argument is validated unconditionally — bare / absolute paths are
//  config-shape errors regardless of coverage flag. The `coverageGoals` config
//  only matters with coverage, so it stays gated.
try {
  XTestCliConfig.validateRoot(options.root);
} catch (error) {
  fail(`Error: ${error.message}`, 2);
}

// Declare fully-qualified base url and source root for output mappings. All
//  three carry trailing `/` per `XTestCliTap`'s constructor contract.
const baseUrl    = new URL(options.url).origin + '/';
const sourceRoot = resolve(cwd, options.root ?? '.') + '/';

// Coverage requires goals. Without `coverageGoals` there is nothing to
//  grade against — treat as an invocation error so misconfiguration fails
//  loud instead of silently reporting “all ok”.
if (coverage && !options.coverageGoals) {
  fail('Error: --coverage=true requires coverageGoals in x-test.config.js.', 2);
}
if (coverage) {
  try {
    XTestCliConfig.validateCoverageGoals(options.coverageGoals);
  } catch (error) {
    fail(`Error: ${error.message}`, 2);
  }
}

// Coverage is a full-run metric — numbers are only meaningful when every test
//  has had a chance to exercise the source. Filtering tests by name would
//  grade a partial run against full-run goals and produce false misses, so
//  auto-disable coverage in that case and tell the user.
if (coverage && options.namePattern) {
  console.warn('Note: --coverage disabled because --name-pattern is set. Coverage requires a full run.'); // eslint-disable-line no-console
  coverage = false;
}

// Run timeout (ms). Bounds the handshake with the x-test root so a missing or
//  broken root can’t hang the CLI forever. Default 30s.
let runTimeout = 30_000;
if (options.timeout !== undefined) {
  const parsed = Number(options.timeout);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    fail(`Error: --timeout must be a positive number of milliseconds, got "${options.timeout}".`);
  }
  runTimeout = parsed;
}

const reporterMode = options.reporter ?? 'auto';
if (!SUPPORTED_REPORTERS.includes(reporterMode)) {
  const supported = SUPPORTED_REPORTERS.map(reporter => `"${reporter}"`).join(', ');
  fail(`Error: Unsupported reporter "${reporterMode}". Supported reporters: ${supported}.`);
}

// Resolve whether to colorize. Precedence (highest first):
//   1. `--reporter=tap` forces raw (explicit user intent on this run)
//   2. `NO_COLOR` env var (https://no-color.org)
//   3. `FORCE_COLOR` env var (ecosystem de facto)
//   4. TTY detection on stdout
const suppressColor = reporterMode === 'tap' || process.env.NO_COLOR;
const forceColor    = process.env.FORCE_COLOR || process.stdout.isTTY;
const color         = !suppressColor && !!forceColor;

// Own the TAP reporter here — the driver just emits browser console lines. The
//  reporter auto-ends when it parses a terminal TAP line (top-level plan
//  satisfied, or `Bail out!`); we bridge that to the driver via `streamEnded`,
//  so the driver knows when to stop collecting coverage and close the browser.
const { promise: streamEnded, resolve: endStream } = Promise.withResolvers();
const tap = new XTestCliTap({ stream: process.stdout, color, endStream, baseUrl, sourceRoot, cwd: cwd + '/' });

// Resolve the target URL. Apply the name-pattern filter if present.
let url = options.url;
if (options.namePattern) {
  const urlObj = new URL(url);
  urlObj.searchParams.set('x-test-name-pattern', options.namePattern);
  url = urlObj.href;
}

// Browser-launch timeout (ms). Applies only to the underlying puppeteer or
//  playwright `launch()` call — “fail fast if the browser can’t start.” Not a
//  run timeout.
const LAUNCH_TIMEOUT_MS = 10_000;

// Captures the raw V8 coverage the driver collects so we can grade it after
//  the run. Populated only when `coverage === true`.
let rawCoverageEntries = null;

const launchTimeout = LAUNCH_TIMEOUT_MS;
const onConsole = text => tap.write(text);
const onCoverage = entries => { rawCoverageEntries = entries; };
const ended = streamEnded;
const driverOptions = { url, coverage, launchTimeout, onConsole, onCoverage, ended };

// Global run timeout. Races the driver against a timer — covers launch,
//  navigation, handshake, and coverage uniformly. The losing promise keeps
//  running, but we `process.exit(1)` below and the driver packages install
//  exit handlers that tear down Chromium.
function withTimeout(promise, ms, message) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// Run the browser driver. On any catastrophic failure (browser launch,
//  navigation, etc.) emit `Bail out!` through the reporter so it gets colorized
//  and the scanner records the bailed state, then dump the error to stderr
//  (outside the TAP stream) and exit 1.
const timeoutMessage = `Timed out after ${runTimeout}ms waiting for x-test root at ${url}. Use --timeout=<ms> to extend.`;
try {
  switch (options.client) {
    case 'puppeteer':
      await withTimeout(XTestCliBrowserPuppeteer.run(driverOptions), runTimeout, timeoutMessage);
      break;
    case 'playwright':
      await withTimeout(XTestCliBrowserPlaywright.run(driverOptions), runTimeout, timeoutMessage);
      break;
  }
} catch (error) {
  tap.write(`Bail out! The ${options.client} client crashed.`);
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
if (coverage && rawCoverageEntries && tap.result.ok) {
  try {
    const origin = new URL(url).origin;
    // Synthesize entries for goal files the browser never loaded but that
    //  exist on disk — so the summary shows `0.0 / goal  not ok` with a real
    //  denominator and lcov shows the file all-red, rather than a terse
    //  “missing” notation.
    const synthetic = await XTestCliCoverage.synthesizeMissingEntries({
      entries: rawCoverageEntries,
      origin,
      sourceRoot,
      goals:   options.coverageGoals,
    });
    const allEntries = [...rawCoverageEntries, ...synthetic];
    await XTestCliCoverage.writeLcov({
      entries: allEntries,
      outDir:  './coverage',
      origin,                          // In-origin entries map to on-disk paths.
      sourceRoot,
      goals:   options.coverageGoals,  // Only goal files appear in lcov.
    });
    const graded = XTestCliCoverage.gradeCoverage({
      entries: allEntries,
      origin,
      goals:   options.coverageGoals,
    });
    coverageOk = graded.ok;
    tap.writeCoverage(XTestCliCoverage.formatCoverageBlock({ result: graded }), { ok: graded.ok });
  } catch (error) {
    tap.write('Bail out! Coverage processing failed.');
    console.error(error); // eslint-disable-line no-console
    process.exit(1);
  }
}

if (!tap.result.ok || !coverageOk) {
  process.exit(1);
}
