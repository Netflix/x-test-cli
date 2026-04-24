import { suite, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { XTestCliConfig } from '../../x-test-cli-config.js';

let tempDir;

before(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'x-test-cli-config-'));
});

after(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

/** Write `x-test.config.js` into a fresh subdir and return its path. */
async function writeConfig(name, body) {
  const dir = join(tempDir, name);
  await rm(dir, { recursive: true, force: true });
  const { mkdir } = await import('node:fs/promises');
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'x-test.config.js'), body);
  return dir;
}

suite('XTestCliConfig.load', () => {
  test('missing file → {}', async () => {
    const dir = join(tempDir, 'nope');
    const cfg = await XTestCliConfig.load(dir);
    assert.deepEqual(cfg, {});
  });

  test('valid default export is returned verbatim', async () => {
    const dir = await writeConfig('valid', `
      export default {
        url: 'http://host/',
        client: 'playwright',
        coverage: true,
        coverageTargets: {
          './src/a.js': { lines: 90 },
        },
      };
    `);
    const cfg = await XTestCliConfig.load(dir);
    assert(cfg.url === 'http://host/');
    assert(cfg.client === 'playwright');
    assert(cfg.coverage === true);
    assert.deepEqual(cfg.coverageTargets, { './src/a.js': { lines: 90 } });
  });

  test('syntax error propagates', async () => {
    const dir = await writeConfig('syntax', 'export default { this is not valid };');
    await assert.rejects(() => XTestCliConfig.load(dir));
  });

  test('no default export → {}', async () => {
    const dir = await writeConfig('no-default', `export const foo = 1;`);
    const cfg = await XTestCliConfig.load(dir);
    assert.deepEqual(cfg, {});
  });
});

suite('XTestCliConfig.validateCoverageBasePath', () => {
  test('undefined is a no-op', () => {
    XTestCliConfig.validateCoverageBasePath(undefined);
  });

  test('valid string passes', () => {
    XTestCliConfig.validateCoverageBasePath('./public');
    XTestCliConfig.validateCoverageBasePath('/abs/path');
  });

  test('empty string rejected', () => {
    assert.throws(() => XTestCliConfig.validateCoverageBasePath(''), /non-empty string/);
  });

  test('non-string rejected', () => {
    assert.throws(() => XTestCliConfig.validateCoverageBasePath(42),    /non-empty string/);
    assert.throws(() => XTestCliConfig.validateCoverageBasePath(null),  /non-empty string/);
    assert.throws(() => XTestCliConfig.validateCoverageBasePath({}),    /non-empty string/);
  });
});

suite('XTestCliConfig.validateCoverageTargets', () => {
  test('undefined is a no-op', () => {
    XTestCliConfig.validateCoverageTargets(undefined);
  });

  test('valid { lines: N } passes', () => {
    XTestCliConfig.validateCoverageTargets({
      './src/a.js': { lines: 100 },
      './src/b.js': { lines: 0 },
      './src/c.js': { lines: 50.5 },
    });
  });

  test('non-object root → throws', () => {
    assert.throws(() => XTestCliConfig.validateCoverageTargets('nope'), /must be an object/);
    assert.throws(() => XTestCliConfig.validateCoverageTargets([]), /must be an object/);
    assert.throws(() => XTestCliConfig.validateCoverageTargets(null), /must be an object/);
  });

  test('non-object entry → throws', () => {
    assert.throws(() => XTestCliConfig.validateCoverageTargets({ './a.js': 100 }), /must be an object/);
    assert.throws(() => XTestCliConfig.validateCoverageTargets({ './a.js': null }), /must be an object/);
  });

  test('branches/functions/statements → not yet supported', () => {
    assert.throws(
      () => XTestCliConfig.validateCoverageTargets({ './a.js': { branches: 50 } }),
      /'branches' not yet supported/,
    );
    assert.throws(
      () => XTestCliConfig.validateCoverageTargets({ './a.js': { functions: 90 } }),
      /'functions' not yet supported/,
    );
    assert.throws(
      () => XTestCliConfig.validateCoverageTargets({ './a.js': { statements: 80 } }),
      /'statements' not yet supported/,
    );
  });

  test('unknown axis → throws with "unknown axis"', () => {
    assert.throws(
      () => XTestCliConfig.validateCoverageTargets({ './a.js': { nonsense: 50 } }),
      /unknown axis/,
    );
  });

  test('lines out of range → throws', () => {
    assert.throws(
      () => XTestCliConfig.validateCoverageTargets({ './a.js': { lines: 150 } }),
      /must be a number in \[0, 100\]/,
    );
    assert.throws(
      () => XTestCliConfig.validateCoverageTargets({ './a.js': { lines: -1 } }),
      /must be a number in \[0, 100\]/,
    );
    assert.throws(
      () => XTestCliConfig.validateCoverageTargets({ './a.js': { lines: 'high' } }),
      /must be a number/,
    );
    assert.throws(
      () => XTestCliConfig.validateCoverageTargets({ './a.js': {} }),
      /must be a number/,
    );
  });
});
