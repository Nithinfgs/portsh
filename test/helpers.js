import { lintText } from '../src/engine.js';
import { ALL_PLATFORMS } from '../src/platforms.js';

/**
 * Lint a snippet as a script against every platform.
 * @param {string} text
 * @param {Partial<import('../src/engine.js').LintOptions>} [opts]
 */
export function lint(text, opts = {}) {
  return lintText(text, { file: 'test.sh', kind: 'script', targets: [...ALL_PLATFORMS], explicitTargets: true, ...opts });
}

/** @param {string} text @param {Partial<import('../src/engine.js').LintOptions>} [opts] */
export function ids(text, opts = {}) {
  return lint(text, opts).map((f) => f.ruleId);
}
