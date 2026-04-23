# @netflix/x-test-cli

a simple cli for `x-test`

## Installation

```bash
# Pick one (or both) alongside the CLI:
npm install --save-dev @netflix/x-test-cli puppeteer
npm install --save-dev @netflix/x-test-cli playwright
```

See [Bring your own browser](#bring-your-own-browser) for why.

## Bring your own browser

The `@netflix/x-test-cli` package doesn’t bundle a browser driver. Both
`puppeteer` and `playwright` are declared as **optional peer dependencies** —
the CLI installs no extra weight on its own, and you pull in only the driver
you actually use.

- Install **`puppeteer`** → use `--client=puppeteer`
- Install **`playwright`** → use `--client=playwright`
  (see [Configuring Playwright](#configuring-playwright) for more details)
- Install both → either `--client` works

**Why it’s structured this way:** most consumers already have one of these
installed for their own e2e testing. Making them optional peer deps means this
CLI doesn’t force a second browser download on your machine, doesn’t impose a
version of puppeteer / playwright you have to match, and doesn’t penalize you
for picking the driver you prefer.

## Command-line usage

```
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
    automatically. CLI flags override config values. Coverage file paths are
    resolved relative to url origin.

      export default {
        url:      'http://127.0.0.1:8080/test/',
        client:   'playwright',
        browser:  'chromium',
        timeout:  30_000,
        coverage: true,
        coverageBasePath: './public',
        coverageTargets: {
          './browser/x-test.js':           { lines: 100 },
          './browser/x-test-root.js':      { lines: 71 },
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
    https://github.com/Netflix/x-test-cli
```

### Puppeteer

Puppeteer launches a bundled Chromium.

```bash
# Install:
npm install --save-dev @netflix/x-test-cli puppeteer

# Run:
x-test --client=puppeteer --url=http://localhost:8080/test/
x-test --client=puppeteer --url=http://localhost:8080/test/ --coverage=true
x-test --client=puppeteer --url=http://localhost:8080/test/ --name-pattern='^render '
```

### Playwright

Playwright launches Chromium too (we hard-code the Chromium channel for parity
with Puppeteer). You need the `playwright` package **and** the Chromium binary —
see [Configuring Playwright](#configuring-playwright) for more details.

```bash
# Install:
npm install --save-dev @netflix/x-test-cli playwright

# Run:
x-test --client=playwright --url=http://localhost:8080/test/
x-test --client=playwright --url=http://localhost:8080/test/ --coverage=true
x-test --client=playwright --url=http://localhost:8080/test/ --name-pattern='^render '
```

### Test filtering

`--name-pattern` accepts a regex pattern that matches against the full test name
(parent `describe` names joined with spaces). The pattern is forwarded to the
browser-side runner via the `x-test-name-pattern` URL query param.

### Coverage

When `--coverage=true`, the CLI collects V8 JS coverage via Chromium's DevTools
Protocol, grades per-file goals declared in `x-test.config.js`, writes
`./coverage/lcov.info`, and appends a `# Coverage:` diagnostic block to the
TAP output.

#### Config file

`x-test.config.js` at the project root declares which files to grade and
the line-coverage percentage each one must meet. Full example with every
supported key:

```js
// x-test.config.js
export default {
  // OPTIONAL — disk directory the web server serves as its root.
  //  `coverageTargets` keys resolve against this on disk. Defaults to
  //  `process.cwd()`. Set it when the server root isn't cwd (e.g. when
  //  serving `./public` or `./dist`).
  coverageBasePath: './public',

  // REQUIRED when `--coverage=true`. Per-file line-coverage goals.
  //  Keys are paths relative to `coverageBasePath`. Values are `{ lines: N }`
  //  where N is the minimum percent (0–100) required for the run to pass.
  coverageTargets: {
    './src/foo.js':        { lines: 100 },
    './src/bar.js':        { lines:  80 },
    './src/flaky-util.js': { lines:  60 },
  },
};
```

Behavior of each target:

- **Loaded and above goal** → `ok`, exit 0.
- **Loaded and below goal** → `not ok`, exit 1.
- **In config but not loaded by the test page** → `0% / goal`, exit 1. The
  file is read from disk to give a real denominator, and appears in
  `lcov.info` as all-red so the gap is visible in editor integrations.
- **In config and not on disk** → `(missing)`, exit 1. Catches typos.
- `--coverage=true` without any `coverageTargets` is an invocation error
  (exit code `2`).

#### Pragmas

Inline directives exclude lines from the report — same shape as
`node --test`'s `/* node:coverage ... */` directives:

```js
/* x-test:coverage disable */
// ... region omitted from the report
/* x-test:coverage enable */

/* x-test:coverage ignore next */
const unreachable = defensiveFallback;

/* x-test:coverage ignore next 3 */
if (process.env.NODE_ENV === 'development') {
  debugHelper();
}
```

Ignored lines are absent from `lcov.info` entirely — VSCode Coverage
Gutters (and friends) simply show no mark.

#### Output

A `./coverage/lcov.info` file is emitted in standard LCOV format with paths
relative to cwd. Third-party tooling — editor integrations, CI uploaders, HTML
report generators — reads files in this format out-of-the-box.

The TAP summary shows got vs. goal per target:

```
# Coverage:
#
# ok     - 80% line coverage goal (got 91.3%)  | ./src/foo.js
# not ok - 60% line coverage goal (got 54.1%)  | ./src/flaky-util.js
#
# (see ./coverage/lcov.info)
```

#### Scope: non-transpiled code only

Coverage uses V8's view of the loaded scripts, so paths and line numbers
have to match source on disk. Bundlers, minifiers, and TypeScript emit
rewrite both — `coverageTargets` won't resolve and `lcov.info` line
numbers won't line up. This feature is intended for small, non-transpiled
library packages.

### Reporters

The CLI emits TAP14 to stdout.

- `--reporter=tap` — raw passthrough. Use this when piping to another TAP
  consumer (CI log collectors, `faucet`, etc.).
- `--reporter=auto` (default) — ANSI colorization when stdout is a TTY, raw when
  piped. Stripping the ANSI codes yields byte-identical TAP, so the output is
  safe for anything downstream even in auto mode.

Colorization respects [`NO_COLOR`](https://no-color.org) and `FORCE_COLOR`
environment variables.

### Exit codes

- `0` — all tests passed (and, when `--coverage=true`, all coverage goals met).
- `1` — a test failed, the plan didn’t match the asserts seen, the browser
  emitted a `Bail out!`, the driver crashed, or a coverage goal was missed.
- `2` — invocation error (e.g., `--coverage=true` without `coverageTargets`
  in `x-test.config.js`).

## Configuring Playwright

Playwright ships as an npm package that knows *how* to drive a browser but
doesn’t include the browser binary itself — you install those separately. The
CLI hard-codes Chromium, so that’s what you need.

### One-time local setup

If you just want to get started, run this once in your project:

```bash
npx playwright install chromium
```

### Automatic install on `npm install`

Encode in your project's `package.json` so teammates and CI can't forget:

```json
{
  "scripts": {
    "postinstall": "playwright install chromium"
  }
}
```

This is Playwright’s recommended pattern.

### Explicit setup script

If you’d rather not add machinery to `postinstall`, name it explicitly:

```json
{
  "scripts": {
    "setup": "playwright install chromium"
  }
}
```

Then document `npm run setup` as a one-time-per-clone step.

### CI with OS dependencies

Headless Linux environments often lack the shared libraries Chromium needs
(fonts, graphics stack, etc.). Pass `--with-deps`:

```bash
npx playwright install --with-deps chromium
```

Playwright will `apt-get` the required packages alongside the browser. Only
needed on fresh CI images; local dev machines typically have them.

## Browser vs. CLI packages

- [`@netflix/x-test`](https://github.com/Netflix/x-test) — browser-side test
  runner and utilities. Use this to write tests.
- `@netflix/x-test-cli` — Node.js automation for running those tests headlessly
  and collecting coverage. Use this to drive them from CI or your terminal.
