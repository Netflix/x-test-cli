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
 * @property {string | undefined} browser
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
  static #CONFIG_KEYS = [
    'url', 'root', 'client', 'browser', 'timeout',
    'coverage', 'coverageGoals', 'namePattern', 'reporter',
  ];

  // CLI flags allowed on the command line (camelCase form). `coverageGoals`
  //  is config-only — too unwieldy to express as a flag value.
  static #CLI_KEYS = [
    'url', 'root', 'client', 'browser', 'timeout',
    'coverage', 'namePattern', 'reporter',
  ];

  static #DEFAULT_TIMEOUT  = 30_000;
  static #DEFAULT_REPORTER = 'auto';

  /**
   * Load `x-test.config.js` from `cwd`. Returns the module's default export,
   * or `{}` when no config file is present. All other load errors (syntax,
   * runtime throw in the module body) propagate.
   * @param {string} cwd
   * @returns {Promise<XTestConfig>}
   */
  static async load(cwd) {
    const path = resolve(cwd, XTestCliConfig.#CONFIG_FILE_NAME);
    try {
      const module = await import(pathToFileURL(path).href);
      return module.default ?? {};
    } catch (error) {
      if (/** @type {NodeJS.ErrnoException} */ (error).code === 'ERR_MODULE_NOT_FOUND') {
        return {};
      }
      throw error;
    }
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
   * first problem found. Empty/missing config (`{}`) is accepted.
   * @param {unknown} config
   * @returns {void}
   */
  static validateConfig(config) {
    if (config === null || typeof config !== 'object' || Array.isArray(config)) {
      throw new Error(`x-test.config.js default export must be an object, got ${XTestCliConfig.#describe(config)}.`);
    }
    // Past the shape check, treat as a string-keyed bag for property-by-
    //  property validation. Each access is still narrowed by an explicit
    //  guard before use.
    const fields = /** @type {Record<string, unknown>} */ (config);
    for (const key of Object.keys(fields)) {
      if (!XTestCliConfig.#CONFIG_KEYS.includes(key)) {
        const allowed = XTestCliConfig.#CONFIG_KEYS.map(k => `"${k}"`).join(', ');
        throw new Error(`Unknown config key "${key}" in x-test.config.js. Allowed: ${allowed}.`);
      }
    }
    if (fields.url !== undefined) {
      XTestCliConfig.#assertUrl(fields.url, 'config.url');
    }
    if (fields.root !== undefined) {
      XTestCliConfig.#assertRelative(fields.root, 'config.root');
    }
    if (fields.client !== undefined) {
      XTestCliConfig.#assertEnum(fields.client, XTestCliConfig.#SUPPORTED_CLIENTS, 'config.client');
    }
    if (fields.browser !== undefined) {
      XTestCliConfig.#assertEnum(fields.browser, XTestCliConfig.#SUPPORTED_BROWSERS, 'config.browser');
    }
    if (fields.timeout !== undefined) {
      if (typeof fields.timeout !== 'number' || !Number.isFinite(fields.timeout) || fields.timeout <= 0) {
        throw new Error(`config.timeout must be a positive finite number, got ${XTestCliConfig.#describe(fields.timeout)}.`);
      }
    }
    if (fields.coverage !== undefined && typeof fields.coverage !== 'boolean') {
      throw new Error(`config.coverage must be a boolean, got ${XTestCliConfig.#describe(fields.coverage)}.`);
    }
    if (fields.namePattern !== undefined) {
      if (typeof fields.namePattern !== 'string' || fields.namePattern === '') {
        throw new Error(`config.namePattern must be a non-empty string, got ${XTestCliConfig.#describe(fields.namePattern)}.`);
      }
    }
    if (fields.reporter !== undefined) {
      XTestCliConfig.#assertEnum(fields.reporter, XTestCliConfig.#SUPPORTED_REPORTERS, 'config.reporter');
    }
    XTestCliConfig.#validateCoverageGoals(fields.coverageGoals);
  }

  /**
   * Validate the parsed CLI options. All values are strings (since they come
   * from `--key=value`); boolean/number coercion happens in `resolve`, not
   * here.
   * @param {XTestCli} cli
   * @returns {void}
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

    const browser      = cli.browser     ?? config.browser;
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
      browser,                    // 'chromium' | undefined
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
    if (goals === null || typeof goals !== 'object' || Array.isArray(goals)) {
      throw new Error(`coverageGoals must be an object, got ${XTestCliConfig.#describe(goals)}.`);
    }
    const map = /** @type {Record<string, unknown>} */ (goals);
    for (const [path, entry] of Object.entries(map)) {
      XTestCliConfig.#assertRelative(path, `coverageGoals key ${JSON.stringify(path)}`);
      if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
        throw new Error(`coverageGoals[${JSON.stringify(path)}] must be an object, got ${XTestCliConfig.#describe(entry)}.`);
      }
      const axes = /** @type {Record<string, unknown>} */ (entry);
      for (const axis of Object.keys(axes)) {
        if (XTestCliConfig.#UNSUPPORTED_AXES.includes(axis)) {
          throw new Error(`coverageGoals[${JSON.stringify(path)}]: '${axis}' not yet supported (only 'lines').`);
        }
        if (!XTestCliConfig.#SUPPORTED_AXES.includes(axis)) {
          throw new Error(`coverageGoals[${JSON.stringify(path)}]: unknown axis '${axis}' (only 'lines').`);
        }
      }
      const { lines } = axes;
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
   * @returns {string}
   */
  static #kebab(camel) {
    return camel.replace(/[A-Z]/g, c => '-' + c.toLowerCase());
  }

  /**
   * Human-readable type description for error messages.
   * @param {unknown} value
   * @returns {string}
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
