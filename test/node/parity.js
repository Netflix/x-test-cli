#!/usr/bin/env node
//
// Parity check: run both browser drivers against the same URL and assert
// that the resulting `coverage/lcov.info` is byte-identical. Catches
// regressions in V8-coverage normalization (Puppeteer returns pre-flattened
// disjoint ranges; Playwright's raw shape is normalized by the CLI — the
// two paths must converge on the same final bytes).
//
// Requires the dev server to be running at the URL configured in
// `x-test.config.js` already (`npm start`).

import { spawn } from 'node:child_process';
import { copyFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** Run the CLI under one client; resolve only when it exits 0. */
function runCli(client) {
  return new Promise((resolve, reject) => {
    const child = spawn('node', [
      './x-test-cli.js',
      `--client=${client}`,
    ], { stdio: ['ignore', 'inherit', 'inherit'] });
    child.on('exit', code => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`${client} exited with code ${code}`));
      }
    });
    child.on('error', reject);
  });
}

async function captureLcovFor(client, destination) {
  await rm('coverage', { recursive: true, force: true });
  await runCli(client);
  await copyFile('coverage/lcov.info', destination);
}

const puppeteerLcov = join(tmpdir(), 'x-test-parity-puppeteer.lcov');
const playwrightLcov = join(tmpdir(), 'x-test-parity-playwright.lcov');

await captureLcovFor('puppeteer',  puppeteerLcov);
await captureLcovFor('playwright', playwrightLcov);

const [a, b] = await Promise.all([
  readFile(puppeteerLcov,  'utf8'),
  readFile(playwrightLcov, 'utf8'),
]);

/* eslint-disable no-console */
if (a !== b) {
  console.error('FAIL: puppeteer and playwright produced different lcov.info');
  console.error(`  puppeteer:  ${puppeteerLcov}`);
  console.error(`  playwright: ${playwrightLcov}`);
  console.error('Run `diff` on the two paths above to inspect.');
  process.exit(1);
}

console.log('OK: puppeteer and playwright produce byte-identical lcov.info');
