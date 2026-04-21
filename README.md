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
Usage: x-test --client=<client> --url=<url> [options]

Required:
  --client=<puppeteer|playwright>  Browser driver. The matching package must be installed.
  --url=<url>                      Entry-point URL of the test harness (the page that loads @netflix/x-test).

Options:
  --coverage=<true|false>          Enable V8 JS coverage collection. Default: false.
  --test-name=<regex>              Filter tests by name (regex, matched against full name including describe chain).

Examples:
  x-test --client=puppeteer  --url=http://localhost:8080/test/
  x-test --client=puppeteer  --url=http://localhost:8080/test/ --coverage=true
  x-test --client=playwright --url=http://localhost:8080/test/ --test-name='^render '
```

### Puppeteer

Puppeteer launches a bundled Chromium.

```bash
# Install:
npm install --save-dev @netflix/x-test-cli puppeteer

# Run:
x-test --client=puppeteer --url=http://localhost:8080/test/
x-test --client=puppeteer --url=http://localhost:8080/test/ --coverage=true
x-test --client=puppeteer --url=http://localhost:8080/test/ --test-name='^render '
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
x-test --client=playwright --url=http://localhost:8080/test/ --test-name='^render '
```

### Test filtering

`--test-name` accepts a regex pattern that matches against the full test name
(parent `describe` names joined with spaces). The pattern is forwarded to the
browser-side runner via the `x-test-name` URL query param.

### Coverage

When `--coverage=true` and the browser exposes V8 coverage (Chromium does), the
CLI collects coverage and hands it to the x-test root for processing.
Playwright and Puppeteer emit coverage in different shapes; the CLI normalizes
Playwright’s raw V8 output to Puppeteer’s `{text, ranges}` shape so the
downstream x-test code sees identical input regardless of client.

### Exit code

Non-zero if any test failed, the browser emitted a `Bail out!`, or the driver
crashed. `0` otherwise.

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
