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

const tap = new XTestCliTap({ stream: process.stdout, color: false });
tap.write(readFileSync(file, 'utf8'));
