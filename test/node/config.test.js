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

  test('no default export → undefined (validateConfig surfaces it as an error)', async () => {
    const dir = await writeConfig('no-default', `export const foo = 1;`);
    const cfg = await XTestCliConfig.load(dir);
    assert(cfg === undefined);
    assert.throws(() => XTestCliConfig.validateConfig(cfg), /must be an object/);
  });
});

suite('XTestCliConfig.validateConfig — root', () => {
  test('absent is a no-op', () => {
    XTestCliConfig.validateConfig({});
  });

  test('relative-prefixed strings pass', () => {
    XTestCliConfig.validateConfig({ root: './public' });
    XTestCliConfig.validateConfig({ root: '../sibling/dist' });
  });

  test('empty string rejected', () => {
    assert.throws(() => XTestCliConfig.validateConfig({ root: '' }), /non-empty string/);
  });

  test('absolute and bare paths rejected', () => {
    // Bare ("public") and absolute ("/abs/path") forms are rejected so output
    //  formatting stays uniform with `coverageGoals` keys (Node-style `./`).
    assert.throws(() => XTestCliConfig.validateConfig({ root: '/abs/path' }), /relative path/);
    assert.throws(() => XTestCliConfig.validateConfig({ root: 'public' }),    /relative path/);
  });

  test('non-string rejected', () => {
    assert.throws(() => XTestCliConfig.validateConfig({ root: 42 }),   /non-empty string/);
    assert.throws(() => XTestCliConfig.validateConfig({ root: null }), /non-empty string/);
    assert.throws(() => XTestCliConfig.validateConfig({ root: {} }),   /non-empty string/);
  });
});

suite('XTestCliConfig.validateConfig — coverageGoals', () => {
  test('absent is a no-op', () => {
    XTestCliConfig.validateConfig({});
  });

  test('valid { lines: N } passes', () => {
    XTestCliConfig.validateConfig({
      coverageGoals: {
        './src/a.js': { lines: 100 },
        './src/b.js': { lines: 0 },
        './src/c.js': { lines: 50.5 },
      },
    });
  });

  test('non-object root → throws', () => {
    assert.throws(() => XTestCliConfig.validateConfig({ coverageGoals: 'nope' }), /must be an object/);
    assert.throws(() => XTestCliConfig.validateConfig({ coverageGoals: [] }),     /must be an object/);
    assert.throws(() => XTestCliConfig.validateConfig({ coverageGoals: null }),   /must be an object/);
  });

  test('non-object entry → throws', () => {
    assert.throws(() => XTestCliConfig.validateConfig({ coverageGoals: { './a.js': 100 } }),  /must be an object/);
    assert.throws(() => XTestCliConfig.validateConfig({ coverageGoals: { './a.js': null } }), /must be an object/);
  });

  test('branches/functions/statements → not yet supported', () => {
    assert.throws(
      () => XTestCliConfig.validateConfig({ coverageGoals: { './a.js': { branches: 50 } } }),
      /'branches' not yet supported/,
    );
    assert.throws(
      () => XTestCliConfig.validateConfig({ coverageGoals: { './a.js': { functions: 90 } } }),
      /'functions' not yet supported/,
    );
    assert.throws(
      () => XTestCliConfig.validateConfig({ coverageGoals: { './a.js': { statements: 80 } } }),
      /'statements' not yet supported/,
    );
  });

  test('unknown axis → throws with "unknown axis"', () => {
    assert.throws(
      () => XTestCliConfig.validateConfig({ coverageGoals: { './a.js': { nonsense: 50 } } }),
      /unknown axis/,
    );
  });

  test('lines out of range → throws', () => {
    assert.throws(
      () => XTestCliConfig.validateConfig({ coverageGoals: { './a.js': { lines: 150 } } }),
      /must be a number in \[0, 100\]/,
    );
    assert.throws(
      () => XTestCliConfig.validateConfig({ coverageGoals: { './a.js': { lines: -1 } } }),
      /must be a number in \[0, 100\]/,
    );
    assert.throws(
      () => XTestCliConfig.validateConfig({ coverageGoals: { './a.js': { lines: 'high' } } }),
      /must be a number/,
    );
    assert.throws(
      () => XTestCliConfig.validateConfig({ coverageGoals: { './a.js': {} } }),
      /must be a number/,
    );
  });

  test('keys must be `./`- or `../`-prefixed', () => {
    // Bare (`a.js`) and absolute (`/a.js`) keys are rejected so the coverage
    //  table renders Node-style relative paths uniformly with `root`.
    assert.throws(
      () => XTestCliConfig.validateConfig({ coverageGoals: { 'a.js': { lines: 50 } } }),
      /relative path/,
    );
    assert.throws(
      () => XTestCliConfig.validateConfig({ coverageGoals: { '/a.js': { lines: 50 } } }),
      /relative path/,
    );
    XTestCliConfig.validateConfig({ coverageGoals: { './a.js':  { lines: 50 } } });
    XTestCliConfig.validateConfig({ coverageGoals: { '../b.js': { lines: 50 } } });
  });
});

suite('XTestCliConfig.validateConfig — top-level shape', () => {
  test('unknown keys throw', () => {
    assert.throws(
      () => XTestCliConfig.validateConfig({ coverageGoal: {} }),
      /Unknown config key "coverageGoal"/,
    );
    assert.throws(
      () => XTestCliConfig.validateConfig({ foo: 1 }),
      /Unknown config key "foo"/,
    );
  });

  test('non-object input throws', () => {
    assert.throws(() => XTestCliConfig.validateConfig(null),  /must be an object/);
    assert.throws(() => XTestCliConfig.validateConfig([]),    /must be an object/);
    assert.throws(() => XTestCliConfig.validateConfig('hi'),  /must be an object/);
  });

  test('client/browser/reporter enums', () => {
    XTestCliConfig.validateConfig({ client: 'puppeteer' });
    XTestCliConfig.validateConfig({ client: 'playwright' });
    XTestCliConfig.validateConfig({ browser: 'chromium' });
    XTestCliConfig.validateConfig({ browser: 'firefox' });
    XTestCliConfig.validateConfig({ browser: 'webkit' });
    XTestCliConfig.validateConfig({ reporter: 'tap' });
    XTestCliConfig.validateConfig({ reporter: 'auto' });
    assert.throws(() => XTestCliConfig.validateConfig({ client:   'bogus' }),  /must be one of/);
    assert.throws(() => XTestCliConfig.validateConfig({ browser:  'opera' }), /must be one of/);
    assert.throws(() => XTestCliConfig.validateConfig({ reporter: 'spec' }),    /must be one of/);
  });

  test('coverage must be a real boolean', () => {
    XTestCliConfig.validateConfig({ coverage: true });
    XTestCliConfig.validateConfig({ coverage: false });
    assert.throws(() => XTestCliConfig.validateConfig({ coverage: 'true' }), /must be a boolean/);
    assert.throws(() => XTestCliConfig.validateConfig({ coverage: 1 }),      /must be a boolean/);
  });

  test('timeout must be a positive finite number', () => {
    XTestCliConfig.validateConfig({ timeout: 1 });
    XTestCliConfig.validateConfig({ timeout: 30_000 });
    assert.throws(() => XTestCliConfig.validateConfig({ timeout: 0 }),       /positive finite number/);
    assert.throws(() => XTestCliConfig.validateConfig({ timeout: -1 }),      /positive finite number/);
    assert.throws(() => XTestCliConfig.validateConfig({ timeout: '30000' }), /positive finite number/);
    assert.throws(() => XTestCliConfig.validateConfig({ timeout: Infinity }),/positive finite number/);
  });

  test('url must be a parseable URL string', () => {
    XTestCliConfig.validateConfig({ url: 'http://localhost:8080/test/' });
    assert.throws(() => XTestCliConfig.validateConfig({ url: 'not a url' }), /valid URL/);
    assert.throws(() => XTestCliConfig.validateConfig({ url: '' }),          /non-empty string/);
  });
});

suite('XTestCliConfig.parseCli', () => {
  test('kebab-case keys → camelCase', () => {
    const opts = XTestCliConfig.parseCli(['--name-pattern=foo', '--client=puppeteer']);
    assert(opts.namePattern === 'foo');
    assert(opts.client === 'puppeteer');
  });

  test('non--- arg throws', () => {
    assert.throws(() => XTestCliConfig.parseCli(['bare']), /must start with "--"/);
  });

  test('flag without value throws', () => {
    assert.throws(() => XTestCliConfig.parseCli(['--client']), /requires a value/);
  });
});

suite('XTestCliConfig.validateCli', () => {
  test('unknown flags throw with kebab-case in message', () => {
    assert.throws(() => XTestCliConfig.validateCli({ foo: 'x' }),         /Unknown argument "--foo"/);
    assert.throws(() => XTestCliConfig.validateCli({ coverageGoals: {} }), /Unknown argument "--coverage-goals"/);
  });

  test('values are strings; coverage must be "true"/"false"', () => {
    XTestCliConfig.validateCli({ coverage: 'true' });
    XTestCliConfig.validateCli({ coverage: 'false' });
    assert.throws(() => XTestCliConfig.validateCli({ coverage: 'maybe' }), /must be "true" or "false"/);
  });

  test('timeout parses string', () => {
    XTestCliConfig.validateCli({ timeout: '30000' });
    assert.throws(() => XTestCliConfig.validateCli({ timeout: '-5' }), /positive number/);
    assert.throws(() => XTestCliConfig.validateCli({ timeout: 'abc' }), /positive number/);
  });

  test('client/browser/reporter enums', () => {
    assert.throws(() => XTestCliConfig.validateCli({ client:   'bogus' }),    /must be one of/);
    assert.throws(() => XTestCliConfig.validateCli({ browser:  'opera' }),    /must be one of/);
    assert.throws(() => XTestCliConfig.validateCli({ reporter: 'spec' }),     /must be one of/);
    XTestCliConfig.validateCli({ browser: 'chromium' });
    XTestCliConfig.validateCli({ browser: 'firefox' });
    XTestCliConfig.validateCli({ browser: 'webkit' });
  });
});

suite('XTestCliConfig.resolve', () => {
  const baseArgs = { cwd: '/tmp/x', env: {}, isTTY: false };

  test('CLI overrides config', () => {
    const r = XTestCliConfig.resolve({
      ...baseArgs,
      config: { client: 'playwright', browser: 'chromium', url: 'http://a/' },
      cli:    { client: 'puppeteer' },
    });
    assert(r.client === 'puppeteer');
    assert(r.url === 'http://a/');
  });

  test('missing client/url throws', () => {
    assert.throws(
      () => XTestCliConfig.resolve({ ...baseArgs, config: {}, cli: { url: 'http://a/' } }),
      /"--client" is required/,
    );
    assert.throws(
      () => XTestCliConfig.resolve({ ...baseArgs, config: {}, cli: { client: 'puppeteer' } }),
      /"--url" is required/,
    );
  });

  test('puppeteer rejects non-chromium browsers', () => {
    assert.throws(
      () => XTestCliConfig.resolve({
        ...baseArgs,
        config: {},
        cli:    { client: 'puppeteer', browser: 'firefox', url: 'http://a/' },
      }),
      /"--client=puppeteer" does not support "--browser=firefox"/,
    );
    assert.throws(
      () => XTestCliConfig.resolve({
        ...baseArgs,
        config: {},
        cli:    { client: 'puppeteer', browser: 'webkit', url: 'http://a/' },
      }),
      /"--client=puppeteer" does not support "--browser=webkit"/,
    );
  });

  test('playwright accepts chromium, firefox, webkit', () => {
    for (const browser of ['chromium', 'firefox', 'webkit']) {
      const r = XTestCliConfig.resolve({
        ...baseArgs,
        config: {},
        cli:    { client: 'playwright', browser, url: 'http://a/' },
      });
      assert(r.browser === browser);
    }
  });

  test('coverage requires chromium', () => {
    assert.throws(
      () => XTestCliConfig.resolve({
        ...baseArgs,
        config: { coverageGoals: { './a.js': { lines: 50 } } },
        cli:    { client: 'playwright', browser: 'firefox', url: 'http://a/', coverage: 'true' },
      }),
      /only supported with --browser=chromium/,
    );
  });

  test('coverage=true without coverageGoals throws', () => {
    assert.throws(
      () => XTestCliConfig.resolve({
        ...baseArgs,
        config: { coverage: true },
        cli:    { client: 'puppeteer', browser: 'chromium', url: 'http://a/' },
      }),
      /requires coverageGoals/,
    );
  });

  test('namePattern disables coverage and is injected into URL', () => {
    const r = XTestCliConfig.resolve({
      ...baseArgs,
      config: { coverage: true, coverageGoals: { './a.js': { lines: 50 } } },
      cli:    { client: 'puppeteer', browser: 'chromium', url: 'http://a/test/', namePattern: 'foo' },
    });
    assert(r.coverage === false);
    assert(r.coverageDisabledByPattern === true);
    assert(/x-test-name-pattern=foo/.test(r.url));
  });

  test('CLI string coverage parses to boolean', () => {
    const t = XTestCliConfig.resolve({
      ...baseArgs,
      config: { coverageGoals: { './a.js': { lines: 50 } } },
      cli:    { client: 'puppeteer', browser: 'chromium', url: 'http://a/', coverage: 'true' },
    });
    assert(t.coverage === true);
    const f = XTestCliConfig.resolve({
      ...baseArgs,
      config: {},
      cli:    { client: 'puppeteer', browser: 'chromium', url: 'http://a/', coverage: 'false' },
    });
    assert(f.coverage === false);
  });

  test('reporter=tap forces no color even on TTY', () => {
    const r = XTestCliConfig.resolve({
      cwd: '/tmp/x', env: {}, isTTY: true,
      config: {}, cli: { client: 'puppeteer', browser: 'chromium', url: 'http://a/', reporter: 'tap' },
    });
    assert(r.color === false);
  });

  test('NO_COLOR suppresses color', () => {
    const r = XTestCliConfig.resolve({
      cwd: '/tmp/x', env: { NO_COLOR: '1' }, isTTY: true,
      config: {}, cli: { client: 'puppeteer', browser: 'chromium', url: 'http://a/' },
    });
    assert(r.color === false);
  });

  test('default timeout is 30_000', () => {
    const r = XTestCliConfig.resolve({
      ...baseArgs,
      config: {}, cli: { client: 'puppeteer', browser: 'chromium', url: 'http://a/' },
    });
    assert(r.runTimeout === 30_000);
  });

  test('CLI timeout string parses to number', () => {
    const r = XTestCliConfig.resolve({
      ...baseArgs,
      config: {}, cli: { client: 'puppeteer', browser: 'chromium', url: 'http://a/', timeout: '5000' },
    });
    assert(r.runTimeout === 5000);
  });

  test('baseUrl is origin + "/"', () => {
    const r = XTestCliConfig.resolve({
      ...baseArgs,
      config: {}, cli: { client: 'puppeteer', browser: 'chromium', url: 'http://localhost:8080/test/sub/' },
    });
    assert(r.baseUrl === 'http://localhost:8080/');
  });
});
