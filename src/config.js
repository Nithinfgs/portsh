/**
 * Configuration: `.portshrc.json` or a "portsh" key in package.json.
 *
 * {
 *   "targets": ["macos", "linux", "alpine"],
 *   "disable": ["bash4-mapfile"],
 *   "exclude": ["vendor/**", "docs/legacy.md"],
 *   "overrides": [{ "files": ["plugins/macos/**"], "targets": ["macos"] }],
 *   "failOn": "error"
 * }
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parsePlatformList } from './platforms.js';

/** @typedef {import('./platforms.js').Platform} Platform */

/**
 * @typedef {object} Config
 * @property {Platform[] | null} targets
 * @property {string[]} disable
 * @property {string[]} exclude
 * @property {{files: string[], targets: Platform[]}[]} overrides
 * @property {'error' | 'warn' | 'none' | null} failOn
 */

/** @returns {Config} */
export const emptyConfig = () => ({ targets: null, disable: [], exclude: [], overrides: [], failOn: null });

/**
 * @param {string} dir
 * @returns {Config}
 */
export function loadConfig(dir) {
  const rc = join(dir, '.portshrc.json');
  /** @type {unknown} */
  let raw = null;
  let source = '';
  if (existsSync(rc)) {
    source = '.portshrc.json';
    try {
      raw = JSON.parse(readFileSync(rc, 'utf8'));
    } catch (e) {
      throw new Error(`${source}: ${/** @type {Error} */ (e).message}`);
    }
  } else if (existsSync(join(dir, 'package.json'))) {
    try {
      const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
      if (pkg && typeof pkg === 'object' && 'portsh' in pkg) {
        raw = pkg.portsh;
        source = 'package.json "portsh"';
      }
    } catch {
      /* an unreadable package.json is not our problem */
    }
  }
  return normalize(raw, source);
}

/**
 * @param {unknown} raw
 * @param {string} source
 * @returns {Config}
 */
function normalize(raw, source) {
  const cfg = emptyConfig();
  if (raw === null || raw === undefined) return cfg;
  if (typeof raw !== 'object' || Array.isArray(raw)) throw new Error(`${source}: expected an object`);
  const o = /** @type {Record<string, unknown>} */ (raw);
  const strings = (/** @type {string} */ key) => {
    const v = o[key];
    if (v === undefined) return [];
    if (!Array.isArray(v) || v.some((x) => typeof x !== 'string')) throw new Error(`${source}: "${key}" must be an array of strings`);
    return /** @type {string[]} */ (v);
  };
  if (o.targets !== undefined) cfg.targets = parsePlatformList(strings('targets').join(','));
  cfg.disable = strings('disable');
  cfg.exclude = strings('exclude');
  if (o.overrides !== undefined) {
    if (!Array.isArray(o.overrides)) throw new Error(`${source}: "overrides" must be an array`);
    cfg.overrides = o.overrides.map((entry, i) => {
      const e = /** @type {Record<string, unknown>} */ (entry && typeof entry === 'object' ? entry : {});
      if (!Array.isArray(e.files) || !Array.isArray(e.targets))
        throw new Error(`${source}: overrides[${i}] needs "files" and "targets" arrays`);
      return { files: /** @type {string[]} */ (e.files), targets: parsePlatformList(/** @type {string[]} */ (e.targets).join(',')) };
    });
  }
  if (o.failOn !== undefined) {
    if (o.failOn !== 'error' && o.failOn !== 'warn' && o.failOn !== 'none')
      throw new Error(`${source}: "failOn" must be error, warn or none`);
    cfg.failOn = o.failOn;
  }
  return cfg;
}

/**
 * Minimal glob: `**` any depth, `*` within a segment, `?` one character.
 * @param {string} glob
 * @returns {RegExp}
 */
export function globToRegExp(glob) {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        re += '.*';
        i++;
        if (glob[i + 1] === '/') i++;
      } else re += '[^/]*';
    } else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`);
}
