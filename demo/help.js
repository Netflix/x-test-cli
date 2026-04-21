import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const COMMANDS = {
  'demo:color': 'Colorize a TAP fixture (ANSI output)',
  'demo:tap':   'Pass a fixture through raw (byte-identical)',
};

function listFixtures() {
  const here = dirname(fileURLToPath(import.meta.url));
  return readdirSync(join(here, 'fixtures'))
    .filter(f => f.endsWith('.tap'))
    .sort()
    .map(f => `demo/fixtures/${f}`);
}

/**
 * Print demo help. With no argument: list the demo commands (copy-pasteable
 * as-is to drill in). With a command name: list one copy-pasteable command
 * per fixture.
 */
export function printHelp(command) {
  if (command && COMMANDS[command]) {
    process.stdout.write(`${COMMANDS[command]}\n\n`);
    for (const f of listFixtures()) {
      process.stdout.write(`  npm run ${command} -- ${f}\n`);
    }
    return;
  }

  process.stdout.write('Demos:\n\n');
  for (const name of Object.keys(COMMANDS)) {
    process.stdout.write(`  npm run ${name}\n`);
  }
}
