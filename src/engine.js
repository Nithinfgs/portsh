/**
 * The engine: parse a chunk of shell, run the rules, and map results back to file positions.
 */

import { extract } from './extract/index.js';
import { parseShell, unwrap } from './parse.js';
import { DEFAULT_TARGETS, intersect } from './platforms.js';
import { RULES_BY_COMMAND, WILDCARD_RULES } from './rules/index.js';

/** @typedef {import('./platforms.js').Platform} Platform */
/** @typedef {import('./extract/index.js').FileKind} FileKind */
/** @typedef {import('./parse.js').Command} Command */

/**
 * @typedef {object} Finding
 * @property {string} ruleId
 * @property {'error' | 'warn'} severity
 * @property {string} file
 * @property {number} line
 * @property {number} col
 * @property {number} length    width of the highlighted command name
 * @property {string} message
 * @property {string} fix
 * @property {Platform[]} fails  targets on which this breaks
 * @property {string} command   the command name, for display
 */

/**
 * @typedef {object} LintOptions
 * @property {string} [file]
 * @property {FileKind} [kind]
 * @property {Platform[]} [targets]       platforms to check
 * @property {boolean} [explicitTargets] targets came from the user rather than the defaults
 * @property {Set<string>} [disabled]     rule ids to skip
 */

/** Project helpers such as `nvm_has git` or `command_exists curl`. */
const PROBE_FUNCTION = /(^|_)(has|have|exists?|installed|available|avail|need|require)(_|$)/i;

const PROBE_COMMANDS = new Set([
  'type',
  'which',
  'hash',
  'have',
  'has',
  'need',
  'require',
  'need_cmd',
  'check_cmd',
  'command_exists',
  'has_command',
  'exists',
  'is_installed',
]);

/**
 * Command names the script checks for before using; those are guarded.
 * @param {Command[]} commands
 * @returns {Set<string>}
 */
function probedNames(commands) {
  const out = new Set();
  for (const c of commands) {
    if (c.name === 'command') {
      const flag = c.args[0];
      if (flag === '-v' || flag === '-V' || flag === '-pv') for (const a of c.args.slice(1)) out.add(a);
    } else if (PROBE_COMMANDS.has(c.name) || PROBE_FUNCTION.test(c.name)) {
      for (const a of c.args) if (!a.startsWith('-')) out.add(a);
    }
  }
  return out;
}

/**
 * Parse `portsh-ignore` directives from comments.
 * @param {string[]} lines chunk lines
 * @param {{line: number, text: string}[]} comments
 * @returns {{perLine: Map<number, Set<string>>, file: Set<string>}}
 */
function ignoreDirectives(lines, comments) {
  /** @type {Map<number, Set<string>>} */
  const perLine = new Map();
  /** @type {Set<string>} */
  const file = new Set();
  for (const c of comments) {
    const m = c.text.match(/#\s*portsh-ignore(-file)?(?:\s+([\w,\s-]+))?/);
    if (!m) continue;
    const ids = new Set((m[2] ?? '*').split(/[\s,]+/).filter(Boolean));
    if (m[1]) {
      for (const id of ids) file.add(id);
      continue;
    }
    const before = (lines[c.line - 1] ?? '').slice(0, (lines[c.line - 1] ?? '').indexOf('#')).trim();
    const target = before ? c.line : c.line + 1;
    const set = perLine.get(target) ?? new Set();
    for (const id of ids) set.add(id);
    perLine.set(target, set);
  }
  return { perLine, file };
}

/**
 * Lint one file's text.
 *
 * @param {string} text
 * @param {LintOptions} [opts]
 * @returns {Finding[]}
 */
export function lintText(text, opts = {}) {
  const file = opts.file ?? '<input>';
  const kind = opts.kind ?? 'script';
  const baseTargets = opts.targets ?? DEFAULT_TARGETS;
  const disabled = opts.disabled ?? new Set();
  /** @type {Finding[]} */
  const findings = [];
  const seen = new Set();

  for (const chunk of extract(kind, text, file)) {
    // Context (FROM alpine, runs-on: macos-latest) decides where a chunk runs.
    // Explicit --targets can only narrow that further.
    let targets = baseTargets;
    if (chunk.targets) targets = opts.explicitTargets ? intersect(baseTargets, chunk.targets) : chunk.targets;
    if (!targets.length) continue;

    const parsed = parseShell(chunk.text);
    const all = parsed.commands.flatMap((c) => [c, ...unwrap(c)]);
    const probed = probedNames(all);
    const chunkLines = chunk.text.split('\n');
    const ignore = ignoreDirectives(chunkLines, parsed.comments);
    const interpreter = parsed.shebang?.interpreter ?? chunk.interpreter;
    /** @type {import('./rules/helpers.js').RuleContext} */
    const ctx = { dialect: chunk.dialect, probed, interpreter: interpreter ?? null };

    for (const cmd of all) {
      if (cmd.fallback) continue;
      // `sed --version` and friends are feature probes, not uses.
      if (cmd.args.length === 1 && ['--version', '--help', '-V', '--usage'].includes(cmd.args[0])) continue;
      const rules = [...(RULES_BY_COMMAND.get(cmd.name) ?? []), ...WILDCARD_RULES];
      if (!rules.length) continue;
      const lineRestriction = chunk.lineRestrictions?.[cmd.line - 1] ?? null;
      for (const rule of rules) {
        if (disabled.has(rule.id)) continue;
        // Documentation routinely shows OS-specific install commands next to a heading that says so.
        if (kind === 'markdown' && (rule.id.startsWith('cmd-') || rule.id === 'homebrew-gnu-prefix')) continue;
        if (ignore.file.has('*') || ignore.file.has(rule.id)) continue;
        const lineIgnore = ignore.perLine.get(cmd.line);
        if (lineIgnore && (lineIgnore.has('*') || lineIgnore.has(rule.id))) continue;
        const scope = intersect(intersect(targets, cmd.restriction), lineRestriction);
        if (!scope.some((p) => rule.fails.includes(p) || rule.probes.some((pr) => pr.fails?.includes(p)))) continue;
        const hit = rule.check(cmd, { ...ctx, scope });
        if (!hit) continue;
        const fails = (hit.fails ?? rule.fails).filter((p) => scope.includes(p));
        if (!fails.length) continue;
        const pos = chunk.lineMap[cmd.line - 1] ?? { line: cmd.line, col: 1 };
        const line = pos.line;
        const col = pos.col + cmd.col - 1;
        const key = `${rule.id}:${line}:${hit.key ?? col}`;
        if (seen.has(key)) continue;
        seen.add(key);
        findings.push({
          ruleId: rule.id,
          severity: rule.severity,
          file,
          line,
          col,
          length: cmd.words[0]?.raw.length ?? 1,
          message: hit.message,
          fix: hit.fix ?? rule.fix,
          fails,
          command: cmd.name,
        });
      }
    }
  }
  findings.sort((a, b) => a.line - b.line || a.col - b.col || a.ruleId.localeCompare(b.ruleId));
  return findings;
}
