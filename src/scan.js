/**
 * File discovery: which files to look at, and what kind each one is.
 */

import { execFileSync } from 'node:child_process';
import { closeSync, openSync, readdirSync, readSync, statSync } from 'node:fs';
import { basename, join, relative, sep } from 'node:path';

/** @typedef {import('./extract/index.js').FileKind} FileKind */

const SKIP_DIRS = new Set([
  '.git',
  'node_modules',
  'vendor',
  'dist',
  'build',
  'target',
  '.venv',
  'venv',
  '__pycache__',
  '.tox',
  '.next',
  '.cache',
  'coverage',
  'third_party',
  '.terraform',
  '.gradle',
]);
const MAX_BYTES = 1_000_000;

/**
 * @param {string} path  repo-relative or absolute
 * @returns {FileKind | null}
 */
export function kindOf(path) {
  const p = path.split(sep).join('/');
  const name = basename(p);
  if (/^(Makefile|makefile|GNUmakefile)$/.test(name) || name.endsWith('.mk')) return 'makefile';
  if (/^(Dockerfile|Containerfile)(\..+)?$/.test(name) || /\.(Dockerfile|dockerfile)$/.test(name)) return 'dockerfile';
  if (/(^|\/)\.github\/workflows\/[^/]+\.ya?ml$/.test(p) || /^action\.ya?ml$/.test(name)) return 'workflow';
  if (name === 'package.json') return 'package';
  if (/\.(md|markdown)$/i.test(name)) return 'markdown';
  if (/\.(sh|bash|zsh|ksh|command)$/.test(name)) return 'script';
  return null;
}

/** First bytes of a file look like a shell shebang. */
function hasShellShebang(/** @type {string} */ file) {
  try {
    const fd = openSync(file, 'r');
    try {
      const buf = Buffer.alloc(80);
      const n = readSync(fd, buf, 0, 80, 0);
      const head = buf.subarray(0, n).toString('utf8').split('\n', 1)[0];
      return /^#!.*\b(ba|z|da|a|k)?sh\b/.test(head);
    } finally {
      closeSync(fd);
    }
  } catch {
    return false;
  }
}

/**
 * @param {string} root
 * @returns {string[] | null} repo-relative files from git, or null when not a git checkout
 */
function gitFiles(root) {
  try {
    const out = execFileSync('git', ['-C', root, 'ls-files', '-z', '--cached', '--others', '--exclude-standard'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      maxBuffer: 64 * 1024 * 1024,
    });
    return out.split('\0').filter(Boolean);
  } catch {
    return null;
  }
}

/** @param {string} dir @param {string} root @param {string[]} out */
function walk(dir, root, out) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      walk(join(dir, entry.name), root, out);
    } else if (entry.isFile()) {
      out.push(relative(root, join(dir, entry.name)));
    }
  }
}

/**
 * @typedef {object} Target
 * @property {string} path   path to read
 * @property {string} display path to show
 * @property {FileKind} kind
 */

/**
 * @param {string[]} inputs files or directories
 * @param {{cwd?: string}} [opts]
 * @returns {Target[]}
 */
export function discover(inputs, opts = {}) {
  const cwd = opts.cwd ?? process.cwd();
  /** @type {Map<string, Target>} */
  const found = new Map();
  /** @param {string} rel @param {string} root @param {boolean} explicit */
  const consider = (rel, root, explicit) => {
    const abs = join(root, rel);
    let kind = kindOf(rel);
    if (!kind && explicit) kind = 'script';
    if (!kind && !/\.[A-Za-z0-9]+$/.test(basename(rel)) && hasShellShebang(abs)) kind = 'script';
    if (!kind) return;
    try {
      if (statSync(abs).size > MAX_BYTES) return;
    } catch {
      return;
    }
    const display = relative(cwd, abs) || rel;
    if (!found.has(abs)) found.set(abs, { path: abs, display, kind });
  };

  for (const input of inputs.length ? inputs : ['.']) {
    const abs = join(cwd, input);
    let st;
    try {
      st = statSync(abs);
    } catch {
      throw new Error(`no such file or directory: ${input}`);
    }
    if (st.isFile()) {
      consider(relative(cwd, abs), cwd, true);
      continue;
    }
    const tracked = gitFiles(abs);
    const files =
      tracked ??
      (() => {
        /** @type {string[]} */
        const out = [];
        walk(abs, abs, out);
        return out;
      })();
    for (const rel of files) {
      if (rel.split('/').some((seg) => SKIP_DIRS.has(seg))) continue;
      consider(rel, abs, false);
    }
  }
  return [...found.values()].sort((a, b) => a.display.localeCompare(b.display));
}
