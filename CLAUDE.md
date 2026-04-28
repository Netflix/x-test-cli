# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

`@netflix/x-test-cli` is a Node.js CLI tool that automates browser testing for the `@netflix/x-test` browser-side test runner. It launches browsers (currently Puppeteer/Chrome), runs tests, collects coverage, and outputs TAP-compliant results.

## Architecture

- **x-test-cli.js**: Entry point. Parses CLI args, loads `x-test.config.js`, constructs the TAP reporter, dispatches to a driver.
- **x-test-cli-browser.js**: Driver classes — `XTestCliBrowserPuppeteer` and `XTestCliBrowserPlaywright`. Each `run()` launches a browser, navigates, awaits a caller-supplied `ended` Promise, collects V8 coverage, closes.
- **x-test-cli-tap.js** (`XTestCliTap`): Line-by-line TAP parser + renderer. Auto-ends on the first terminal signal (top-level plan satisfied, or `Bail out!`) and fires the `endStream` callback.
- **x-test-cli-coverage.js**: V8 → line hits + lcov writer + grading + TAP summary formatter.
- **x-test-cli-config.js**: `x-test.config.js` loader and validator.

### Communication Flow

The entire interface between the CLI and `@netflix/x-test` runs over the browser console, plus one optional URL query param. No BroadcastChannel handshake; no scripts injected into the page.

1. CLI launches browser, attaches `page.on('console', …)` before navigation.
2. CLI navigates to the test URL (with optional `?x-test-name-pattern=<regex>`).
3. x-test runs tests, writes TAP 14 to `console.log`.
4. CLI's `onConsole(text)` forwards each line to `tap.write(text)`.
5. `XTestCliTap` auto-ends on parsing a top-level `1..N` plan or `Bail out!`, firing `endStream`.
6. Driver awakens from `await ended`, stops coverage, closes browser.

### URL Parameters

- `x-test-name-pattern`: Test-name filter (regex), added when `--name-pattern` is provided.

## Development Commands

**Linting:**
```bash
npm run lint          # Check for lint errors (max 0 warnings)
npm run lint-fix      # Auto-fix lint errors
```

**Version Bumping:**
```bash
npm run bump          # Display current version
npm run bump 1.0.0    # Bump to specific version (also supports major/minor/patch)
```

**Testing the CLI:**
```bash
node x-test-cli.js --client=puppeteer --url=http://localhost:8080/test/ --coverage=true
```

## Publishing

Uses GitHub Actions to publish from tags. Two workflows:

1. **Manual**: Edit `package.json`, `jsr.json` versions → commit → tag → push → create GitHub release
2. **Assisted**: Run `npm run bump <version>` (handles all file updates and git operations) → push with `git push origin main --follow-tags` → create GitHub release

The bump script automatically updates `package.json`, `package-lock.json`, and `jsr.json`, then commits and tags.

## Code Conventions

- ES modules (`"type": "module"` in package.json)
- Kebab-case CLI args are converted to camelCase internally (e.g., `--name-pattern` → `namePattern`)
- TAP output flows through stdout; errors and notes through stderr
- Exit codes: 0 = all pass (incl. coverage goals), 1 = test failure / coverage miss / bail / crash, 2 = invocation error (bad config, e.g. `--coverage=true` without `coverageGoals`)
- All publishable files listed in `package.json` "files" array
