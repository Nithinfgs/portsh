/**
 * Programmatic API.
 *
 *   import { lintPaths, lintText } from 'portsh';
 *   const report = lintPaths(['scripts/'], { targets: ['macos', 'linux'] });
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { globToRegExp } from './config.js';
import { lintText } from './engine.js';
import { platformsFromPath } from './hints.js';
import { DEFAULT_TARGETS } from './platforms.js';
import { discover } from './scan.js';

export { lintText } from './engine.js';
export { ALL_PLATFORMS, DEFAULT_TARGETS } from './platforms.js';
export { RULES, RULES_BY_ID } from './rules/index.js';

/** @typedef {import('./platforms.js').Platform} Platform */
/** @typedef {import('./report.js').Report} Report */

/** The installed portsh version. */
export const VERSION = /** @type {{version: string}} */ (
  JSON.parse(readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '..', 'package.json'), 'utf8'))
).version;

/**
 * @typedef {object} LintPathsOptions
 * @property {Platform[]} [targets]
 * @property {string[]} [disable]   rule ids
 * @property {string[]} [exclude]   globs relative to cwd
 * @property {{files: string[], targets: Platform[]}[]} [overrides]  per-path targets; ignored when `targets` is given
 * @property {boolean} [pathHints]   narrow files such as `install-macos.sh` to the platform in their path (default true)
 * @property {string} [cwd]
 */

/**
 * Lint files and directories.
 *
 * @param {string[]} paths
 * @param {LintPathsOptions} [opts]
 * @returns {Report}
 */
export function lintPaths(paths, opts = {}) {
  const cwd = opts.cwd ?? process.cwd();
  const exclude = (opts.exclude ?? []).map(globToRegExp);
  const targets = opts.targets ?? [...DEFAULT_TARGETS];
  const disabled = new Set(opts.disable ?? []);
  const overrides = (opts.overrides ?? []).map((o) => ({ res: o.files.map(globToRegExp), targets: o.targets }));
  const files = discover(paths, { cwd }).filter((f) => !exclude.some((re) => re.test(f.display.split('\\').join('/'))));

  /** @type {import('./engine.js').Finding[]} */
  const findings = [];
  for (const f of files) {
    let text;
    try {
      text = readFileSync(f.path, 'utf8');
    } catch {
      continue;
    }
    const rel = f.display.split('\\').join('/');
    let fileTargets = targets;
    if (opts.targets === undefined) {
      const override = overrides.find((o) => o.res.some((re) => re.test(rel)));
      const hint = opts.pathHints === false ? null : platformsFromPath(rel);
      if (override) fileTargets = override.targets;
      else if (hint) fileTargets = hint;
    }
    findings.push(
      ...lintText(text, {
        file: f.display,
        kind: f.kind,
        targets: fileTargets,
        explicitTargets: opts.targets !== undefined,
        disabled,
      }),
    );
  }
  return { version: VERSION, targets, filesScanned: files.length, findings };
}
