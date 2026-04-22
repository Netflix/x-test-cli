#!/usr/bin/env node

import { XTestCliBrowserPuppeteer, XTestCliBrowserPlaywright } from './x-test-cli-browser.js';
import { XTestCliTap } from './x-test-cli-tap.js';

const SUPPORTED_CLIENTS = ['puppeteer', 'playwright'];
const SUPPORTED_REPORTERS = ['tap', 'auto'];

const ALLOWED_ARGS = ['client', 'url', 'coverage', 'test-name', 'reporter', 'timeout'];
const ALLOWED_ARGS_DEBUG = ALLOWED_ARGS.map(arg => `"--${arg}"`).join(', ');

function fail(message) {
  console.error(message); // eslint-disable-line no-console
  process.exit(1);
}

// Parse command line arguments
const args = process.argv.slice(2);
const options = {};

for (const arg of args) {
  if (arg.startsWith('--')) {
    const [key, value] = arg.slice(2).split('=', 2);

    if (!ALLOWED_ARGS.includes(key)) {
      fail(`Error: Unknown argument "--${key}".\nAllowed arguments: ${ALLOWED_ARGS_DEBUG}.`);
    }

    if (value === undefined) {
      fail(`Error: Argument "--${key}" requires a value (e.g., "--${key}=<value>").`);
    }

    // kebab-case flag → camelCase internal key, e.g. `test-name` → `testName`.
    const camelKey = key.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    options[camelKey] = value;
  } else {
    fail(`Error: Invalid argument "${arg}". All arguments must start with "--".`);
  }
}

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

// Convert coverage string to boolean. Default is false; `--coverage=true`
//  enables, `--coverage=false` is an explicit no-op (kept for symmetry).
let coverage = false;
if (options.coverage === 'true') {
  coverage = true;
} else if (options.coverage !== undefined && options.coverage !== 'false') {
  fail(`Error: --coverage must be "true" or "false", got "${options.coverage}".`);
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

// Own the TAP reporter here — the driver just emits browser console lines. This
//  entry point decides what to do with them.
const tap = new XTestCliTap({ stream: process.stdout, color });

// Resolve the target URL (apply the test-name filter if present).
let url = options.url;
if (options.testName) {
  const urlObj = new URL(url);
  urlObj.searchParams.set('x-test-name', options.testName);
  url = urlObj.href;
}

// Browser-launch timeout (ms). Applies only to the underlying puppeteer or
//  playwright `launch()` call — “fail fast if the browser can’t start.” Not a
//  run timeout.
const LAUNCH_TIMEOUT_MS = 10_000;

const driverOptions = {
  url,
  coverage,
  launchTimeout: LAUNCH_TIMEOUT_MS,
  onConsole: text => tap.write(text),
};

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

tap.end();
if (!tap.result.ok) {
  process.exit(1);
}
