import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

/**
 * Loads and validates `x-test.config.js`. All methods are static — nothing
 * stateful lives here, just the config filename and the axis-name allowlists
 * that gate `coverageTargets` entries.
 */
export class XTestCliConfig {
  static #CONFIG_FILE_NAME = 'x-test.config.js';

  // Axes recognized in `coverageTargets[path]` entries. Only `lines` is graded
  //  in this increment; the other names exist so we can reject them loudly
  //  instead of silently accepting unimplemented config.
  static #SUPPORTED_AXES   = ['lines'];
  static #UNSUPPORTED_AXES = ['functions', 'branches', 'statements'];

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
   * Validate `coverageBasePath` — the disk directory the web server serves as
   * its root. `coverageTargets` keys resolve against it on disk. Paired in name
   * with a future `coverageBaseUrl` (URL side). Must be a non-empty string when
   * present; anything else fails loud.
   */
  static validateCoverageBasePath(coverageBasePath) {
    if (coverageBasePath === undefined) {
      return;
    }
    if (typeof coverageBasePath !== 'string' || coverageBasePath === '') {
      throw new Error(`coverageBasePath must be a non-empty string, got ${XTestCliConfig.#describe(coverageBasePath)}.`);
    }
  }

  /**
   * Validate `coverageTargets` shape. Throws with a path-qualified message on
   * the first problem found. Accepts only `{ lines: <number 0..100> }` per
   * entry; unknown axes throw "not yet supported" so future additions are a
   * deliberate choice, not a silent config drift.
   */
  static validateCoverageTargets(targets) {
    if (targets === undefined) {
      return;
    }
    if (targets === null || typeof targets !== 'object' || Array.isArray(targets)) {
      throw new Error(`coverageTargets must be an object, got ${XTestCliConfig.#describe(targets)}.`);
    }
    for (const [path, entry] of Object.entries(targets)) {
      if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
        throw new Error(`coverageTargets[${JSON.stringify(path)}] must be an object, got ${XTestCliConfig.#describe(entry)}.`);
      }
      for (const axis of Object.keys(entry)) {
        if (XTestCliConfig.#UNSUPPORTED_AXES.includes(axis)) {
          throw new Error(`coverageTargets[${JSON.stringify(path)}]: '${axis}' not yet supported (only 'lines').`);
        }
        if (!XTestCliConfig.#SUPPORTED_AXES.includes(axis)) {
          throw new Error(`coverageTargets[${JSON.stringify(path)}]: unknown axis '${axis}' (only 'lines').`);
        }
      }
      const { lines } = entry;
      if (typeof lines !== 'number' || !Number.isFinite(lines) || lines < 0 || lines > 100) {
        throw new Error(`coverageTargets[${JSON.stringify(path)}].lines must be a number in [0, 100], got ${XTestCliConfig.#describe(lines)}.`);
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
