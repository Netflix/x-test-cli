# Changelog
All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
