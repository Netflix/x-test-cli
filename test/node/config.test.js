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
        coverageGoals: {
          './src/a.js': { lines: 90 },
        },
      };
    `);
    const cfg = await XTestCliConfig.load(dir);
    assert(cfg.url === 'http://host/');
    assert(cfg.client === 'playwright');
    assert(cfg.coverage === true);
    assert.deepEqual(cfg.coverageGoals, { './src/a.js': { lines: 90 } });
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

suite('XTestCliConfig.validateRoot', () => {
  test('undefined is a no-op', () => {
    XTestCliConfig.validateRoot(undefined);
  });

  test('relative-prefixed strings pass', () => {
    XTestCliConfig.validateRoot('./public');
    XTestCliConfig.validateRoot('../sibling/dist');
  });

  test('empty string rejected', () => {
    assert.throws(() => XTestCliConfig.validateRoot(''), /non-empty string/);
  });

  test('absolute and bare paths rejected', () => {
    // Bare ("public") and absolute ("/abs/path") forms are rejected so output
    //  formatting stays uniform with `coverageGoals` keys (Node-style `./`).
    assert.throws(() => XTestCliConfig.validateRoot('/abs/path'), /relative path/);
    assert.throws(() => XTestCliConfig.validateRoot('public'),    /relative path/);
  });

  test('non-string rejected', () => {
    assert.throws(() => XTestCliConfig.validateRoot(42),    /non-empty string/);
    assert.throws(() => XTestCliConfig.validateRoot(null),  /non-empty string/);
    assert.throws(() => XTestCliConfig.validateRoot({}),    /non-empty string/);
  });
});

suite('XTestCliConfig.validateCoverageGoals', () => {
  test('undefined is a no-op', () => {
    XTestCliConfig.validateCoverageGoals(undefined);
  });

  test('valid { lines: N } passes', () => {
    XTestCliConfig.validateCoverageGoals({
      './src/a.js': { lines: 100 },
      './src/b.js': { lines: 0 },
      './src/c.js': { lines: 50.5 },
    });
  });

  test('non-object root → throws', () => {
    assert.throws(() => XTestCliConfig.validateCoverageGoals('nope'), /must be an object/);
    assert.throws(() => XTestCliConfig.validateCoverageGoals([]), /must be an object/);
    assert.throws(() => XTestCliConfig.validateCoverageGoals(null), /must be an object/);
  });

  test('non-object entry → throws', () => {
    assert.throws(() => XTestCliConfig.validateCoverageGoals({ './a.js': 100 }), /must be an object/);
    assert.throws(() => XTestCliConfig.validateCoverageGoals({ './a.js': null }), /must be an object/);
  });

  test('branches/functions/statements → not yet supported', () => {
    assert.throws(
      () => XTestCliConfig.validateCoverageGoals({ './a.js': { branches: 50 } }),
      /'branches' not yet supported/,
    );
    assert.throws(
      () => XTestCliConfig.validateCoverageGoals({ './a.js': { functions: 90 } }),
      /'functions' not yet supported/,
    );
    assert.throws(
      () => XTestCliConfig.validateCoverageGoals({ './a.js': { statements: 80 } }),
      /'statements' not yet supported/,
    );
  });

  test('unknown axis → throws with "unknown axis"', () => {
    assert.throws(
      () => XTestCliConfig.validateCoverageGoals({ './a.js': { nonsense: 50 } }),
      /unknown axis/,
    );
  });

  test('lines out of range → throws', () => {
    assert.throws(
      () => XTestCliConfig.validateCoverageGoals({ './a.js': { lines: 150 } }),
      /must be a number in \[0, 100\]/,
    );
    assert.throws(
      () => XTestCliConfig.validateCoverageGoals({ './a.js': { lines: -1 } }),
      /must be a number in \[0, 100\]/,
    );
    assert.throws(
      () => XTestCliConfig.validateCoverageGoals({ './a.js': { lines: 'high' } }),
      /must be a number/,
    );
    assert.throws(
      () => XTestCliConfig.validateCoverageGoals({ './a.js': {} }),
      /must be a number/,
    );
  });

  test('keys must be `./`- or `../`-prefixed', () => {
    // Bare (`a.js`) and absolute (`/a.js`) keys are rejected so the coverage
    //  table renders Node-style relative paths uniformly with `root`.
    assert.throws(
      () => XTestCliConfig.validateCoverageGoals({ 'a.js': { lines: 50 } }),
      /relative path/,
    );
    assert.throws(
      () => XTestCliConfig.validateCoverageGoals({ '/a.js': { lines: 50 } }),
      /relative path/,
    );
    XTestCliConfig.validateCoverageGoals({ './a.js':  { lines: 50 } });
    XTestCliConfig.validateCoverageGoals({ '../b.js': { lines: 50 } });
  });
});
