#!/usr/bin/env node
// Pipe a TAP fixture through XTestCliTap with color forced on.
//
// Usage:  node demo/color.js <path/to/fixture.tap>

import { readFileSync } from 'node:fs';
import { XTestCliTap } from '../x-test-cli-tap.js';
import { printHelp } from './help.js';

const file = process.argv[2];
if (!file) {
  printHelp('demo:color');
  process.exit(0);
}

const tap = new XTestCliTap({ stream: process.stdout, color: true });
tap.write(readFileSync(file, 'utf8'));
