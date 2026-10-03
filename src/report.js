/**
 * Output formats: text (default), json, sarif, github (workflow annotations).
 */

import { readFileSync } from 'node:fs';
import { PLATFORM_LABELS } from './platforms.js';

/** @typedef {import('./engine.js').Finding} Finding */
/** @typedef {import('./platforms.js').Platform} Platform */

/**
 * @typedef {object} Report
 * @property {string} version
 * @property {Platform[]} targets
 * @property {number} filesScanned
 * @property {Finding[]} findings
 */

const ANSI = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  green: '\x1b[32m',
  cyan: '\x1b[36m',
};

/** @param {boolean} on */
function painter(on) {
  /** @type {(code: keyof typeof ANSI) => (s: string) => string} */
  const make = (code) => (s) => (on ? `${ANSI[code]}${s}${ANSI.reset}` : s);
  return { bold: make('bold'), dim: make('dim'), red: make('red'), yellow: make('yellow'), green: make('green'), cyan: make('cyan') };
}

/** @param {Platform[]} list */
const names = (list) => list.map((p) => PLATFORM_LABELS[p]).join(', ');

/**
 * @param {Report} report
 * @param {{color?: boolean, cwd?: string}} [opts]
 * @returns {string}
 */
export function formatText(report, opts = {}) {
  const c = painter(opts.color ?? false);
  const out = [];
  out.push(c.bold(`portsh ${report.version}`) + c.dim(` · checking for ${names(report.targets)}`));
  out.push('');

  /** @type {Map<string, Finding[]>} */
  const byFile = new Map();
  for (const f of report.findings) {
    const list = byFile.get(f.file) ?? [];
    list.push(f);
    byFile.set(f.file, list);
  }

  /** @type {Map<string, string[]>} */
  const sources = new Map();
  const lineOf = (/** @type {string} */ file, /** @type {number} */ n) => {
    let lines = sources.get(file);
    if (!lines) {
      try {
        lines = readFileSync(file, 'utf8').split('\n');
      } catch {
        lines = [];
      }
      sources.set(file, lines);
    }
    return lines[n - 1];
  };

  for (const [file, findings] of byFile) {
    for (const f of findings) {
      const mark = f.severity === 'error' ? c.red('✗') : c.yellow('!');
      const where = c.cyan(`${file}:${f.line}:${f.col}`);
      out.push(`${mark} ${where}  ${c.bold(f.ruleId)}  ${c.red(`breaks on ${names(f.fails)}`)}`);
      const src = lineOf(opts.cwd ? `${opts.cwd}/${file}` : file, f.line) ?? lineOf(file, f.line);
      if (src !== undefined) {
        const shown = src.replace(/\t/g, ' ');
        const start = Math.max(0, f.col - 1);
        const clipFrom = start > 60 ? start - 40 : 0;
        const text = shown.slice(clipFrom, clipFrom + 110);
        out.push(`    ${c.dim(text.trimEnd())}`);
        out.push(`    ${' '.repeat(Math.max(0, start - clipFrom))}${c.red('^'.repeat(Math.max(1, Math.min(f.length, 40))))}`);
      }
      out.push(`    ${f.message}`);
      out.push(`    ${c.green('fix:')} ${f.fix}`);
      out.push('');
    }
  }

  if (!report.findings.length) {
    out.push(`${c.green('✓')} No portability problems found in ${report.filesScanned} file${report.filesScanned === 1 ? '' : 's'}.`);
    return `${out.join('\n')}\n`;
  }

  const errors = report.findings.filter((f) => f.severity === 'error').length;
  const warns = report.findings.length - errors;
  out.push(
    `${c.bold(`${report.findings.length} problem${report.findings.length === 1 ? '' : 's'}`)} in ${byFile.size} of ${report.filesScanned} file${report.filesScanned === 1 ? '' : 's'}` +
      c.dim(` (${errors} error${errors === 1 ? '' : 's'}, ${warns} warning${warns === 1 ? '' : 's'})`),
  );
  out.push('');
  for (const p of report.targets) {
    const n = report.findings.filter((f) => f.fails.includes(p)).length;
    const label = PLATFORM_LABELS[p].padEnd(7);
    out.push(n ? `  ${c.red('✗')} ${label} ${n} problem${n === 1 ? '' : 's'}` : `  ${c.green('✓')} ${label} clean`);
  }
  out.push('');
  return out.join('\n');
}

/** @param {Report} report */
export function formatJson(report) {
  return `${JSON.stringify(report, null, 2)}\n`;
}

/**
 * SARIF 2.1.0, accepted by GitHub code scanning.
 * @param {Report} report
 * @param {readonly import('./rules/helpers.js').Rule[]} rules
 */
export function formatSarif(report, rules) {
  const used = new Set(report.findings.map((f) => f.ruleId));
  const sarif = {
    $schema: 'https://json.schemastore.org/sarif-2.1.0.json',
    version: '2.1.0',
    runs: [
      {
        tool: {
          driver: {
            name: 'portsh',
            version: report.version,
            informationUri: 'https://github.com/Nithinfgs/portsh',
            rules: rules
              .filter((r) => used.has(r.id))
              .map((r) => ({
                id: r.id,
                shortDescription: { text: r.title },
                fullDescription: { text: r.why },
                help: { text: r.fix },
                defaultConfiguration: { level: r.severity === 'error' ? 'error' : 'warning' },
              })),
          },
        },
        results: report.findings.map((f) => ({
          ruleId: f.ruleId,
          level: f.severity === 'error' ? 'error' : 'warning',
          message: { text: `${f.message} (breaks on ${names(f.fails)}). Fix: ${f.fix}` },
          locations: [
            {
              physicalLocation: {
                artifactLocation: { uri: f.file.split('\\').join('/') },
                region: { startLine: f.line, startColumn: f.col },
              },
            },
          ],
        })),
      },
    ],
  };
  return `${JSON.stringify(sarif, null, 2)}\n`;
}

/** GitHub Actions workflow commands, shown as inline annotations on the pull request. */
export function formatGithub(/** @type {Report} */ report) {
  const esc = (/** @type {string} */ s) => s.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
  const escProp = (/** @type {string} */ s) => esc(s).replace(/:/g, '%3A').replace(/,/g, '%2C');
  const lines = report.findings.map((f) => {
    const level = f.severity === 'error' ? 'error' : 'warning';
    return `::${level} file=${escProp(f.file)},line=${f.line},col=${f.col},title=${escProp(`${f.ruleId} (breaks on ${names(f.fails)})`)}::${esc(`${f.message}. Fix: ${f.fix}`)}`;
  });
  return lines.length ? `${lines.join('\n')}\n` : '';
}
