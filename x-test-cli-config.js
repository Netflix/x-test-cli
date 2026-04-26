import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

/**
 * Loads and validates `x-test.config.js`. All methods are static — nothing
 * stateful lives here, just the config filename and the axis-name allowlists
 * that gate `coverageGoals` entries.
 */
export class XTestCliConfig {
  static #CONFIG_FILE_NAME = 'x-test.config.js';

  // Axes recognized in `coverageGoals[path]` entries. Only `lines` is graded
  //  in this increment; the other names exist so we can reject them loudly
  //  instead of silently accepting unimplemented config.
  static #SUPPORTED_AXES   = ['lines'];
  static #UNSUPPORTED_AXES = ['functions', 'branches', 'statements'];

  // Relative-path prefixes we require on `root` and `coverageGoals` keys.
  //  Picks one shape and enforces it so users can't accidentally mix
  //  bare/absolute/`./`-prefixed paths in their config.
  static #RELATIVE_PREFIXES = ['./', '../'];

  /** Common guard: reject anything that isn't a `./`- or `../`-prefixed string. */
  static #assertRelative(value, label) {
    if (typeof value !== 'string' || value === '') {
      throw new Error(`${label} must be a non-empty string, got ${XTestCliConfig.#describe(value)}.`);
    }
    if (!XTestCliConfig.#RELATIVE_PREFIXES.some(p => value.startsWith(p))) {
      throw new Error(`${label} must be a relative path starting with './' or '../', got ${JSON.stringify(value)}.`);
    }
  }

  /**
   * Load `x-test.config.js` from `cwd`. Returns the module's default export,
   * or `{}` when no config file is present. All other load errors (syntax,
   * runtime throw in the module body) propagate.
   */
  static async load(cwd) {
    const path = resolve(cwd, XTestCliConfig.#CONFIG_FILE_NAME);
    try {
      const module = await import(pathToFileURL(path).href);
      return module.default ?? {};
    } catch (error) {
      if (error.code === 'ERR_MODULE_NOT_FOUND') {
        return {};
      }
      throw error;
    }
  }

  /**
   * Validate `root` — the disk directory the dev server serves as its root.
   * Used both to resolve `coverageGoals` keys against disk and to rewrite
   * stack-trace URLs in synthesized failure output. Must be a `./`- or
   * `../`-prefixed string when present; bare names and absolute paths fail
   * loud so output formatting stays consistent across consumers.
   */
  static validateRoot(root) {
    if (root === undefined) {
      return;
    }
    XTestCliConfig.#assertRelative(root, 'root');
  }

  /**
   * Validate `coverageGoals` shape. Throws with a path-qualified message on
   * the first problem found. Keys must be `./`- or `../`-prefixed paths;
   * values accept only `{ lines: <number 0..100> }`. Unknown axes throw "not
   * yet supported" so future additions are a deliberate choice, not a silent
   * config drift.
   */
  static validateCoverageGoals(goals) {
    if (goals === undefined) {
      return;
    }
    if (goals === null || typeof goals !== 'object' || Array.isArray(goals)) {
      throw new Error(`coverageGoals must be an object, got ${XTestCliConfig.#describe(goals)}.`);
    }
    for (const [path, entry] of Object.entries(goals)) {
      XTestCliConfig.#assertRelative(path, `coverageGoals key ${JSON.stringify(path)}`);
      if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
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

  /** Human-readable type description for error messages. */
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
