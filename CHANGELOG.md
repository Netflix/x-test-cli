# Changelog
All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Multi-browser support via Playwright. `--browser` accepts `chromium`,
  `firefox`, and `webkit` when `--client=playwright`; Puppeteer remains
  `chromium`-only. Coverage is gated to `chromium` (V8/CSS coverage isn't
  available on the other engines) and rejected at config-resolution time on
  any non-`chromium` browser (#34).
- JSDoc-based TypeScript checking. `tsc --noEmit` runs over the Node source
  via `npm run type` (also wired into CI). No `.d.ts` files are emitted —
  the package’s interface is the binary, so types stay internal (#21).
- CSS coverage. `coverageGoals` keys may now target `.css` files alongside
  `.js`; same `{ lines }` axis, same `lcov.info` output. Block-comment lines are
  stripped from the CSS denominator (#29).

## [1.0.0-rc.7] - 2026-04-28

### Changed

- Config key `coverageBasePath` renamed to `root`. Stricter validation: must
  be a `./`- or `../`-prefixed string (#22).
- Config key `coverageTargets` renamed to `coverageGoals`. Each key is now
  also required to be `./`- or `../`-prefixed (#22).

### Added

- `# Failures:` block is now synthesized by the CLI from the streamed TAP
  rather than re-iterated by the in-browser test runner. Stack-trace URLs
  are rewritten to bare cwd-relative paths so modern terminals can just resolve
  them as local files (#22).
- `--root=<path>` CLI flag. Mirrors the config key for ad-hoc overrides
  (e.g. `--root=./build` to point at a vite-built dist without editing
  config). Validated unconditionally (#22).

## [1.0.0-rc.5] - 2026-04-23

### Changed

- `--test-name` renamed to `--name-pattern` to match Node test CLI (#22).
- `--coverage` is auto-disabled when `--name-pattern` is set; coverage
  numbers from a filtered run would misgrade per-file goals (#22).

### Added

- `x-test.config.js` config file support (#22).
- Support for `--coverage` from CLI (handled in the CLI, not in `x-test`) (#22).

## [1.0.0-rc.4] - 2026-04-22

### Added

- `--timeout=<ms>` flag bounding the full run launch, navigate, handshake, and
  coverage — defaults to 30s (#14).
- Fail-fast on obviously-wrong URLs: the CLI now bails immediately when the
  initial navigation returns a `>= 400` HTTP status (#14).
- NPM token lives in a GH environment for publish action (more secure).

## [1.0.0-rc.3] - 2026-04-21

### Added

- `--reporter=tap|auto` flag. `tap` is raw passthrough; `auto` (default)
  adds ANSI colorization for TTY stdout and stays raw when piped.
  Colorization never alters content — stripping the ANSI codes yields
  byte-identical TAP (#7).
- Added support for `playwright` as a `--client` option (#6).

### Changed

- The `tap-parser` dependency is removed. It’s been replaced by a minimal,
  internal implementation (#4).
- Library moves to bring-your-own-browser. This means `puppeteer` moved from
  `dependencies` to `peerDependencies` with `optional: true` (#5).

### Fixed

- CLI no longer hangs if `--coverage` is passed, but test suite never calls
  `coverage()` (#3).

## [1.0.0-rc.2] - 2025-10-24

### Fixed

- Pathing from splitting this out of x-test repository missed one import case.
  Just a simple import path rename.

## [1.0.0-rc.1] - 2025-10-24

### Added

- Initial feature set.
