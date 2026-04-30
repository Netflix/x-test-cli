import { access } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

/** @typedef {{ lines: number }} CoverageGoal */

/** @typedef {Record<string, CoverageGoal>} CoverageGoals */

/**
 * @typedef {object} XTestConfig
 * @property {string} [url]
 * @property {string} [root]
 * @property {string} [client]
 * @property {string} [browser]
 * @property {number} [timeout]
 * @property {boolean} [coverage]
 * @property {CoverageGoals} [coverageGoals]
 * @property {string} [namePattern]
 * @property {string} [reporter]
 */

/** @typedef {Record<string, string>} XTestCli */

/**
 * @typedef {object} ResolvedConfig
 * @property {string} client
 * @property {string} browser
 * @property {string} url
 * @property {boolean} coverage
 * @property {CoverageGoals | undefined} coverageGoals
 * @property {boolean} coverageDisabledByPattern
 * @property {string | undefined} namePattern
 * @property {number} runTimeout
 * @property {string} reporterMode
 * @property {boolean} color
 * @property {string} baseUrl
 * @property {string} sourceRoot
 * @property {string} cwd
 */

/**
 * Loads, validates, and resolves x-test CLI configuration. The pipeline is
 *
 *   1. `parseCli(argv)`            — argv → camelCase string-valued options.
 *   2. `load(cwd)`                 — read x-test.config.js (object | {}).
 *   3. `validateConfig(config)`    — strict shape check on the config object.
 *   4. `validateCli(cli)`          — strict shape check on the CLI options.
 *   5. `resolve({ config, cli, … })` — merge (CLI > config), default, coerce,
 *                                     and derive (baseUrl, sourceRoot, color,
 *                                     name-pattern URL injection) exactly once.
 *
 * All methods are static; nothing stateful lives here.
 */
export class XTestCliConfig {
  static #CONFIG_FILE_NAME = 'x-test.config.js';

  static #SUPPORTED_CLIENTS   = ['puppeteer', 'playwright'];
  static #SUPPORTED_BROWSERS  = ['chromium'];
  static #SUPPORTED_REPORTERS = ['tap', 'auto'];

  // Axes recognized in `coverageGoals[path]` entries. Only `lines` is graded
  //  in this increment; the other names exist so we can reject them loudly
  //  instead of silently accepting unimplemented config.
  static #SUPPORTED_AXES   = ['lines'];
  static #UNSUPPORTED_AXES = ['functions', 'branches', 'statements'];

  // Relative-path prefixes we require on `root` and `coverageGoals` keys.
  //  Picks one shape and enforces it so users can't accidentally mix
  //  bare/absolute/`./`-prefixed paths in their config.
  static #RELATIVE_PREFIXES = ['./', '../'];

  // Strict allowlists. Unknown keys throw rather than no-op so typos like
  //  `coverageGoal` fail loud at startup instead of silently disabling
  //  coverage grading.
  //
  // CLI flags allowed on the command line (camelCase form). `coverageGoals`
  //  is config-only — too unwieldy to express as a flag value — so the
  //  config allowlist is the CLI allowlist plus that one extra key.
  static #CLI_KEYS = [
    'url', 'root', 'client', 'browser', 'timeout',
    'coverage', 'namePattern', 'reporter',
  ];
  static #CONFIG_KEYS = [...XTestCliConfig.#CLI_KEYS, 'coverageGoals'];

  static #DEFAULT_TIMEOUT  = 30_000;
  static #DEFAULT_REPORTER = 'auto';

  /**
   * Load `x-test.config.js` from `cwd`. Returns the module's default export
   * unvalidated, or `{}` when no config file is present — `validateConfig` is
   * the boundary that proves the shape. All other load errors (syntax,
   * runtime throw in the module body) propagate.
   * @param {string} cwd
   * @returns {Promise<unknown>}
   */
  static async load(cwd) {
    const path = resolve(cwd, XTestCliConfig.#CONFIG_FILE_NAME);
    // Existence check first — so a missing config file silently yields `{}`,
    //  but a config file that exists yet fails to import (syntax error, bad
    //  inner import, runtime throw in the module body) propagates loudly.
    //  A blanket catch on `import()` would conflate the two.
    try {
      await access(path);
    } catch {
      return {};
    }
    const module = await import(pathToFileURL(path).href);
    return module.default;
  }

  /**
   * Parse `process.argv.slice(2)` into a camelCase options object. Syntactic
   * checks only (must be `--key=value`, kebab→camel for the key); allowlist
   * and value-shape checks live in `validateCli`. `--help` and `--version`
   * are intercepted by the entry script before this is called.
   * @param {string[]} argv
   * @returns {XTestCli}
   */
  static parseCli(argv) {
    /** @type {XTestCli} */
    const options = {};
    for (const arg of argv) {
      if (!arg.startsWith('--')) {
        throw new Error(`Invalid argument "${arg}". All arguments must start with "--".`);
      }
      const [key, value] = arg.slice(2).split('=', 2);
      if (value === undefined) {
        throw new Error(`Argument "--${key}" requires a value (e.g., "--${key}=<value>").`);
      }
      // kebab-case flag → camelCase internal key, e.g. `name-pattern` → `namePattern`.
      const camelKey = key.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
      options[camelKey] = value;
    }
    return options;
  }

  /**
   * Validate the parsed `x-test.config.js` default export. Throws on the
   * first problem found. Empty/missing config (`{}`) is accepted. Acts as an
   * `asserts` boundary so callers can treat the value as `XTestConfig` after.
   * @param {unknown} config
   * @returns {asserts config is XTestConfig}
   */
  static validateConfig(config) {
    if (!XTestCliConfig.#isPlainObject(config)) {
      throw new Error(`x-test.config.js default export must be an object, got ${XTestCliConfig.#describe(config)}.`);
    }
    // Past the guard, `config` is narrowed to `Record<string, unknown>` —
    //  individual property values still need narrowing before use.
    for (const key of Object.keys(config)) {
      if (!XTestCliConfig.#CONFIG_KEYS.includes(key)) {
        const allowed = XTestCliConfig.#CONFIG_KEYS.map(allowedKey => `"${allowedKey}"`).join(', ');
        throw new Error(`Unknown config key "${key}" in x-test.config.js. Allowed: ${allowed}.`);
      }
    }
    if (config.url !== undefined) {
      XTestCliConfig.#assertUrl(config.url, 'config.url');
    }
    if (config.root !== undefined) {
      XTestCliConfig.#assertRelative(config.root, 'config.root');
    }
    if (config.client !== undefined) {
      XTestCliConfig.#assertEnum(config.client, XTestCliConfig.#SUPPORTED_CLIENTS, 'config.client');
    }
    if (config.browser !== undefined) {
      XTestCliConfig.#assertEnum(config.browser, XTestCliConfig.#SUPPORTED_BROWSERS, 'config.browser');
    }
    if (config.timeout !== undefined) {
      if (typeof config.timeout !== 'number' || !Number.isFinite(config.timeout) || config.timeout <= 0) {
        throw new Error(`config.timeout must be a positive finite number, got ${XTestCliConfig.#describe(config.timeout)}.`);
      }
    }
    if (config.coverage !== undefined && typeof config.coverage !== 'boolean') {
      throw new Error(`config.coverage must be a boolean, got ${XTestCliConfig.#describe(config.coverage)}.`);
    }
    if (config.namePattern !== undefined) {
      if (typeof config.namePattern !== 'string' || config.namePattern === '') {
        throw new Error(`config.namePattern must be a non-empty string, got ${XTestCliConfig.#describe(config.namePattern)}.`);
      }
    }
    if (config.reporter !== undefined) {
      XTestCliConfig.#assertEnum(config.reporter, XTestCliConfig.#SUPPORTED_REPORTERS, 'config.reporter');
    }
    XTestCliConfig.#validateCoverageGoals(config.coverageGoals);
  }

  /**
   * Validate the parsed CLI options. All values are strings (since they come
   * from `--key=value`); boolean/number coercion happens in `resolve`, not
   * here.
   * @param {XTestCli} cli
   */
  static validateCli(cli) {
    for (const key of Object.keys(cli)) {
      if (!XTestCliConfig.#CLI_KEYS.includes(key)) {
        const allowed = XTestCliConfig.#CLI_KEYS.map(k => `"--${XTestCliConfig.#kebab(k)}"`).join(', ');
        throw new Error(`Unknown argument "--${XTestCliConfig.#kebab(key)}". Allowed: ${allowed}.`);
      }
    }
    if (cli.url !== undefined) {
      XTestCliConfig.#assertUrl(cli.url, '--url');
    }
    if (cli.root !== undefined) {
      XTestCliConfig.#assertRelative(cli.root, '--root');
    }
    if (cli.client !== undefined) {
      XTestCliConfig.#assertEnum(cli.client, XTestCliConfig.#SUPPORTED_CLIENTS, '--client');
    }
    if (cli.browser !== undefined) {
      XTestCliConfig.#assertEnum(cli.browser, XTestCliConfig.#SUPPORTED_BROWSERS, '--browser');
    }
    if (cli.timeout !== undefined) {
      const parsed = Number(cli.timeout);
      if (!Number.isFinite(parsed) || parsed <= 0) {
        throw new Error(`--timeout must be a positive number of milliseconds, got "${cli.timeout}".`);
      }
    }
    if (cli.coverage !== undefined && cli.coverage !== 'true' && cli.coverage !== 'false') {
      throw new Error(`--coverage must be "true" or "false", got "${cli.coverage}".`);
    }
    if (cli.namePattern !== undefined && cli.namePattern === '') {
      throw new Error('--name-pattern must be a non-empty string.');
    }
    if (cli.reporter !== undefined) {
      XTestCliConfig.#assertEnum(cli.reporter, XTestCliConfig.#SUPPORTED_REPORTERS, '--reporter');
    }
  }

  /**
   * Merge config and CLI (CLI wins) and produce a fully-resolved options
   * object. Defaults, type coercions, and derived values (`baseUrl`,
   * `sourceRoot`, `color`, name-pattern URL injection) are applied here
   * exactly once. Cross-field invariants (`coverage=true ⇒ coverageGoals`,
   * `--name-pattern ⇒ coverage off`) are enforced here too.
   * @param {object} input
   * @param {XTestConfig} input.config
   * @param {XTestCli} input.cli
   * @param {string} input.cwd
   * @param {Record<string, string | undefined>} input.env
   * @param {boolean} input.isTTY
   * @returns {ResolvedConfig}
   */
  static resolve({ config, cli, cwd, env, isTTY }) {
    const client = cli.client ?? config.client;
    if (!client) {
      throw new Error('"--client" is required (e.g., "--client=puppeteer").');
    }
    const rawUrl = cli.url ?? config.url;
    if (!rawUrl) {
      throw new Error('"--url" is required (e.g., "--url=http://localhost:8080/test/").');
    }
    const browser = cli.browser ?? config.browser;
    if (!browser) {
      throw new Error('"--browser" is required (e.g., "--browser=chromium").');
    }

    const namePattern  = cli.namePattern ?? config.namePattern;
    const root         = cli.root        ?? config.root        ?? '.';
    const reporterMode = cli.reporter    ?? config.reporter    ?? XTestCliConfig.#DEFAULT_REPORTER;

    // Coverage: CLI is "true"/"false" string, config is real boolean.
    let coverage;
    if (cli.coverage !== undefined) {
      coverage = cli.coverage === 'true';
    } else if (config.coverage !== undefined) {
      coverage = config.coverage;
    } else {
      coverage = false;
    }
    const coverageGoals = config.coverageGoals;
    if (coverage && !coverageGoals) {
      throw new Error('--coverage=true requires coverageGoals in x-test.config.js.');
    }
    // Coverage is a full-run metric — auto-disable when filtering by name and
    //  surface the fact via a flag so the entry script can warn the user.
    let coverageDisabledByPattern = false;
    if (coverage && namePattern) {
      coverage = false;
      coverageDisabledByPattern = true;
    }

    let runTimeout;
    if (cli.timeout !== undefined) {
      runTimeout = Number(cli.timeout);
    } else if (config.timeout !== undefined) {
      runTimeout = config.timeout;
    } else {
      runTimeout = XTestCliConfig.#DEFAULT_TIMEOUT;
    }

    // Apply the name-pattern as a search param on the test URL exactly once.
    const targetUrl = new URL(rawUrl);
    if (namePattern) {
      targetUrl.searchParams.set('x-test-name-pattern', namePattern);
    }
    const baseUrl    = targetUrl.origin + '/';
    const sourceRoot = resolve(cwd, root) + '/';

    // Color resolution. Precedence (highest first):
    //   1. `--reporter=tap`         → forces raw (explicit user intent).
    //   2. `NO_COLOR`               → https://no-color.org
    //   3. `FORCE_COLOR`            → ecosystem de facto.
    //   4. TTY detection on stdout.
    const suppressColor = reporterMode === 'tap' || env.NO_COLOR;
    const forceColor    = env.FORCE_COLOR || isTTY;
    const color         = !suppressColor && !!forceColor;

    return {
      client,                     // 'puppeteer' | 'playwright'
      browser,                    // 'chromium'
      url: targetUrl.href,        // includes ?x-test-name-pattern when set
      coverage,                   // boolean, false when namePattern present
      coverageGoals,              // object | undefined
      coverageDisabledByPattern,  // true when namePattern overrode coverage
      namePattern,                // string | undefined
      runTimeout,                 // number, ms
      reporterMode,               // 'tap' | 'auto'
      color,                      // boolean
      baseUrl,                    // origin + '/'
      sourceRoot,                 // absolute dir + '/'
      cwd: cwd + '/',
    };
  }

  /**
   * Validate the `coverageGoals` sub-object. See class doc for shape.
   * @param {unknown} goals
   */
  static #validateCoverageGoals(goals) {
    if (goals === undefined) {
      return;
    }
    if (!XTestCliConfig.#isPlainObject(goals)) {
      throw new Error(`coverageGoals must be an object, got ${XTestCliConfig.#describe(goals)}.`);
    }
    for (const [path, entry] of Object.entries(goals)) {
      XTestCliConfig.#assertRelative(path, `coverageGoals key ${JSON.stringify(path)}`);
      if (!XTestCliConfig.#isPlainObject(entry)) {
        throw new Error(`coverageGoals[${JSON.stringify(path)}] must be an object, got ${XTestCliConfig.#describe(entry)}.`);
      }
      for (const axis of Object.keys(entry)) {
        if (XTestCliConfig.#UNSUPPORTED_AXES.includes(axis)) {
          throw new Error(`coverageGoals[${JSON.stringify(path)}]: '${axis}' not yet supported (only 'lines').`);
        }
        if (!XTestCliConfig.#SUPPORTED_AXES.includes(axis)) {
          throw new Error(`coverageGoals[${JSON.stringify(path)}]: unknown axis '${axis}' (only 'lines').`);
        }
      }
      const { lines } = entry;
      if (typeof lines !== 'number' || !Number.isFinite(lines) || lines < 0 || lines > 100) {
        throw new Error(`coverageGoals[${JSON.stringify(path)}].lines must be a number in [0, 100], got ${XTestCliConfig.#describe(lines)}.`);
      }
    }
  }

  /**
   * Common guard: reject anything that isn't a `./`- or `../`-prefixed string.
   * @param {unknown} value
   * @param {string} label
   */
  static #assertRelative(value, label) {
    if (typeof value !== 'string' || value === '') {
      throw new Error(`${label} must be a non-empty string, got ${XTestCliConfig.#describe(value)}.`);
    }
    if (!XTestCliConfig.#RELATIVE_PREFIXES.some(p => value.startsWith(p))) {
      throw new Error(`${label} must be a relative path starting with './' or '../', got ${JSON.stringify(value)}.`);
    }
  }

  /**
   * Common guard: reject anything that isn't a parseable URL string.
   * @param {unknown} value
   * @param {string} label
   */
  static #assertUrl(value, label) {
    if (typeof value !== 'string' || value === '') {
      throw new Error(`${label} must be a non-empty string, got ${XTestCliConfig.#describe(value)}.`);
    }
    try {
      new URL(value);
    } catch {
      throw new Error(`${label} must be a valid URL, got ${JSON.stringify(value)}.`);
    }
  }

  /**
   * Common guard: reject anything not in the given allowlist.
   * @param {unknown} value
   * @param {readonly string[]} allowed
   * @param {string} label
   */
  static #assertEnum(value, allowed, label) {
    if (typeof value !== 'string' || !allowed.includes(value)) {
      const list = allowed.map(v => `"${v}"`).join(', ');
      throw new Error(`${label} must be one of ${list}, got ${JSON.stringify(value)}.`);
    }
  }

  /**
   * camelCase → kebab-case for friendly CLI error messages.
   * @param {string} camel
   */
  static #kebab(camel) {
    return camel.replace(/[A-Z]/g, c => '-' + c.toLowerCase());
  }

  /**
   * Type predicate: true iff `value` is a non-null, non-array object. Used to
   * narrow `unknown` inputs to a string-keyed bag for property validation.
   * @param {unknown} value
   * @returns {value is Record<string, unknown>}
   */
  static #isPlainObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
  }

  /**
   * Human-readable type description for error messages.
   * @param {unknown} value
   */
  static #describe(value) {
    if (value === null) {
      return 'null';
    }
    if (Array.isArray(value)) {
      return 'array';
    }
    return typeof value;
  }
}
