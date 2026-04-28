#!/usr/bin/env node
// Pipe a TAP fixture through XTestCliTap with color off (raw passthrough).
// Output should be byte-identical to the fixture.
//
// Usage:  node demo/tap.js <path/to/fixture.tap>

import { readFileSync } from 'node:fs';
import { XTestCliTap } from '../x-test-cli-tap.js';
import { printHelp } from './help.js';

const file = process.argv[2];
if (!file) {
  printHelp('demo:tap');
  process.exit(0);
}

// Mirror the CLI's runtime behavior: rewrite the demo origin to bare cwd-
//  relative paths in the synthesized `# Failures:` block. Modern terminals
//  (VSCode, iTerm2 with cwd tracking, Ghostty) click-resolve `path:line:col`
//  against shell cwd. Fixtures whose stack frames don't reference this origin
//  pass through untouched.
const tap = new XTestCliTap({
  stream:     process.stdout,
  color:      false,
  baseUrl:    'http://127.0.0.1:8080/',
  sourceRoot: process.cwd() + '/',
  cwd:        process.cwd() + '/',
});
tap.write(readFileSync(file, 'utf8'));
