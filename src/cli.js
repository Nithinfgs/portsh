import { emptyConfig, loadConfig } from './config.js';
import { lintText } from './engine.js';
import { lintPaths, VERSION } from './index.js';
import { DEFAULT_TARGETS, detectHostPlatform, PLATFORM_LABELS, parsePlatformList } from './platforms.js';
import { formatGithub, formatJson, formatSarif, formatText } from './report.js';
import { RULES, RULES_BY_ID } from './rules/index.js';
import { kindOf } from './scan.js';
import { verify } from './verify.js';

const HELP = `portsh ${VERSION}: will this shell script run on macOS, Linux and Alpine?

Usage
  portsh [paths...] [options]       check files and directories (default: .)
  portsh --stdin [options]          check a script from standard input
  portsh rules                      list every rule
  portsh explain <rule-id>          why a rule exists, with a failing and a portable example
  portsh verify [--rule <id>]       run each rule's proof on THIS machine

Options
  -t, --targets <list>   platforms to check: macos, linux, alpine (default: macos,linux).
                         Dockerfiles and CI jobs use the platform they run on.
  -f, --format <name>    text (default), json, sarif, github
      --fail-on <level>  error (default), warn, none
      --disable <ids>    comma-separated rule ids to skip
      --exclude <glob>   skip matching files (repeatable)
      --stdin            read the script from stdin
      --stdin-filename   name used to pick the file type for --stdin (e.g. Makefile)
      --no-path-hints    do not narrow files like install-macos.sh to one platform
      --color, --no-color
  -h, --help             show this help
  -v, --version          show the version

Silence one finding with a trailing "# portsh-ignore <rule-id>" comment,
or a whole file with "# portsh-ignore-file".

Exit status: 0 clean, 1 problems found, 2 usage or runtime error.
`;

/**
 * @typedef {object} Args
 * @property {string[]} paths
 * @property {string | null} command
 * @property {string | null} targets
 * @property {string} format
 * @property {string | null} failOn
 * @property {string[]} disable
 * @property {string[]} exclude
 * @property {boolean} stdin
 * @property {string | null} stdinFilename
 * @property {boolean | null} color
 * @property {boolean} help
 * @property {boolean} version
 * @property {string | null} rule
 * @property {boolean} json
 * @property {boolean} noPathHints
 */

/** @param {string[]} argv @returns {Args} */
function parseArgs(argv) {
  /** @type {Args} */
  const a = {
    paths: [],
    command: null,
    targets: null,
    format: 'text',
    failOn: null,
    disable: [],
    exclude: [],
    stdin: false,
    stdinFilename: null,
    color: null,
    help: false,
    version: false,
    rule: null,
    json: false,
    noPathHints: false,
  };
  const need = (/** @type {number} */ i, /** @type {string} */ flag) => {
    const v = argv[i + 1];
    if (v === undefined) throw new UsageError(`${flag} needs a value`);
    return v;
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const [flag, inline] =
      arg.startsWith('--') && arg.includes('=') ? [arg.slice(0, arg.indexOf('=')), arg.slice(arg.indexOf('=') + 1)] : [arg, undefined];
    const value = () => {
      if (inline !== undefined) return inline;
      const v = need(i, flag);
      i++;
      return v;
    };
    switch (flag) {
      case '-h':
      case '--help':
        a.help = true;
        break;
      case '-v':
      case '--version':
        a.version = true;
        break;
      case '-t':
      case '--targets':
      case '--target':
        a.targets = value();
        break;
      case '-f':
      case '--format':
        a.format = value();
        break;
      case '--fail-on':
        a.failOn = value();
        break;
      case '--disable':
        a.disable.push(
          ...value()
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean),
        );
        break;
      case '--exclude':
        a.exclude.push(value());
        break;
      case '--rule':
        a.rule = value();
        break;
      case '--stdin':
        a.stdin = true;
        break;
      case '--stdin-filename':
        a.stdinFilename = value();
        break;
      case '--no-path-hints':
        a.noPathHints = true;
        break;
      case '--json':
        a.json = true;
        break;
      case '--color':
        a.color = true;
        break;
      case '--no-color':
        a.color = false;
        break;
      default:
        if (arg.startsWith('-') && arg !== '-') throw new UsageError(`unknown option ${arg} (try --help)`);
        if (a.command === null && ['rules', 'explain', 'verify'].includes(arg) && a.paths.length === 0) a.command = arg;
        else a.paths.push(arg);
    }
  }
  return a;
}

class UsageError extends Error {}

/**
 * @param {string[]} argv
 * @param {{stdout?: NodeJS.WriteStream, stderr?: NodeJS.WriteStream}} [io]
 * @returns {Promise<number>} exit code
 */
export async function main(argv, io = {}) {
  const stdout = io.stdout ?? process.stdout;
  const stderr = io.stderr ?? process.stderr;
  try {
    const args = parseArgs(argv);
    if (args.help) {
      stdout.write(HELP);
      return 0;
    }
    if (args.version) {
      stdout.write(`${VERSION}\n`);
      return 0;
    }
    if (args.command === 'rules') return cmdRules(args, stdout);
    if (args.command === 'explain') return cmdExplain(args, stdout);
    if (args.command === 'verify') return cmdVerify(args, stdout);
    return await cmdCheck(args, stdout);
  } catch (e) {
    const err = /** @type {Error} */ (e);
    stderr.write(`portsh: ${err.message}\n`);
    return err instanceof UsageError ? 2 : 2;
  }
}

/** @param {Args} args @param {NodeJS.WriteStream} stdout */
async function cmdCheck(args, stdout) {
  if (!['text', 'json', 'sarif', 'github'].includes(args.format))
    throw new UsageError(`unknown format "${args.format}" (text, json, sarif, github)`);
  const config = args.stdin ? emptyConfig() : loadConfig(process.cwd());
  const targets = args.targets ? parsePlatformList(args.targets) : config.targets;
  const failOn = /** @type {'error' | 'warn' | 'none'} */ (args.failOn ?? config.failOn ?? 'error');
  if (!['error', 'warn', 'none'].includes(failOn)) throw new UsageError('--fail-on must be error, warn or none');
  const disable = [...config.disable, ...args.disable];
  for (const id of disable) if (!RULES_BY_ID.has(id)) throw new UsageError(`unknown rule "${id}" (see: portsh rules)`);
  if (targets && !targets.length) throw new UsageError('--targets is empty');

  /** @type {import('./report.js').Report} */
  let report;
  if (args.stdin) {
    const text = await readStdin();
    const name = args.stdinFilename ?? 'stdin.sh';
    const t = targets ?? [...DEFAULT_TARGETS];
    report = {
      version: VERSION,
      targets: t,
      filesScanned: 1,
      findings: lintText(text, {
        file: name,
        kind: kindOf(name) ?? 'script',
        targets: t,
        explicitTargets: targets !== null,
        disabled: new Set(disable),
      }),
    };
  } else {
    report = lintPaths(args.paths, {
      targets: targets ?? undefined,
      disable,
      exclude: [...config.exclude, ...args.exclude],
      overrides: config.overrides,
      pathHints: !args.noPathHints,
    });
  }

  const autoColor = (stdout.isTTY === true && !process.env.NO_COLOR && process.env.TERM !== 'dumb') || Boolean(process.env.FORCE_COLOR);
  const color = args.color ?? autoColor;
  switch (args.format) {
    case 'json':
      stdout.write(formatJson(report));
      break;
    case 'sarif':
      stdout.write(formatSarif(report, RULES));
      break;
    case 'github':
      stdout.write(formatGithub(report));
      break;
    default:
      stdout.write(formatText(report, { color: Boolean(color) }));
  }

  const threshold = failOn === 'none' ? Number.POSITIVE_INFINITY : failOn === 'warn' ? 0 : 1;
  const blocking = report.findings.filter((f) => (f.severity === 'error' ? 1 : 0) >= threshold && failOn !== 'none');
  return blocking.length ? 1 : 0;
}

/** @returns {Promise<string>} */
function readStdin() {
  return new Promise((resolve, reject) => {
    if (process.stdin.isTTY) {
      reject(new UsageError('--stdin needs input piped in, e.g. cat script.sh | portsh --stdin'));
      return;
    }
    /** @type {Buffer[]} */
    const chunks = [];
    process.stdin.on('data', (c) => chunks.push(/** @type {Buffer} */ (c)));
    process.stdin.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    process.stdin.on('error', reject);
  });
}

/** @param {Args} args @param {NodeJS.WriteStream} stdout */
function cmdRules(args, stdout) {
  if (args.json) {
    stdout.write(
      `${JSON.stringify(
        RULES.map((r) => ({ id: r.id, severity: r.severity, fails: r.fails, title: r.title })),
        null,
        2,
      )}\n`,
    );
    return 0;
  }
  const width = Math.max(...RULES.map((r) => r.id.length));
  for (const r of RULES) {
    const where = r.fails.map((p) => PLATFORM_LABELS[p]).join(', ');
    stdout.write(`${r.id.padEnd(width)}  ${r.severity.padEnd(5)}  ${where.padEnd(14)}  ${r.title}\n`);
  }
  stdout.write(`\n${RULES.length} rules\n`);
  return 0;
}

/** @param {Args} args @param {NodeJS.WriteStream} stdout */
function cmdExplain(args, stdout) {
  const id = args.paths[0];
  if (!id) throw new UsageError('usage: portsh explain <rule-id>');
  const rule = RULES_BY_ID.get(id);
  if (!rule) throw new UsageError(`unknown rule "${id}" (see: portsh rules)`);
  const probe = rule.probes.find((p) => p.bad || p.presence);
  const lines = [
    `${rule.id}  (${rule.severity}, breaks on ${rule.fails.map((p) => PLATFORM_LABELS[p]).join(', ')})`,
    '',
    rule.title,
    '',
    rule.why,
    '',
    `Fix: ${rule.fix}`,
  ];
  if (probe?.bad) lines.push('', 'Breaks:', `  ${probe.bad}`);
  if (probe?.good) lines.push('', 'Portable:', `  ${probe.good}`);
  lines.push('', `Verify on this machine: portsh verify --rule ${rule.id}`);
  stdout.write(`${lines.join('\n')}\n`);
  return 0;
}

/** @param {Args} args @param {NodeJS.WriteStream} stdout */
function cmdVerify(args, stdout) {
  const host = detectHostPlatform();
  if (!host) throw new Error(`verification needs macOS or Linux (this is ${process.platform})`);
  if (args.rule && !RULES_BY_ID.has(args.rule)) throw new UsageError(`unknown rule "${args.rule}"`);
  const results = verify(host, { rule: args.rule ?? undefined });
  const failed = results.filter((r) => r.status === 'fail');
  const skipped = results.filter((r) => r.status === 'skip');
  if (args.json) {
    stdout.write(`${JSON.stringify({ host, results }, null, 2)}\n`);
    return failed.length ? 1 : 0;
  }
  stdout.write(`portsh verify on ${PLATFORM_LABELS[host]}\n\n`);
  for (const r of results) {
    if (r.status === 'pass') continue;
    const mark = r.status === 'fail' ? '✗' : '-';
    stdout.write(`${mark} ${r.ruleId}: ${r.what}\n    ${r.detail}\n`);
  }
  const passed = results.length - failed.length - skipped.length;
  stdout.write(`\n${passed} passed, ${failed.length} failed, ${skipped.length} skipped\n`);
  if (failed.length) {
    stdout.write(
      '\nA failing rule means this machine behaves differently from what portsh assumes.\nIf this is a stock macOS or Linux, please open an issue with the output above.\n',
    );
  }
  return failed.length ? 1 : 0;
}
