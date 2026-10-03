/**
 * Shared types and small helpers for rule authors.
 */

/** @typedef {import('../platforms.js').Platform} Platform */
/** @typedef {import('../parse.js').Command} Command */

/**
 * A runnable proof that a rule is true. `portsh verify` executes it on the
 * current machine; the unit tests also lint `bad` and `good` statically.
 *
 * @typedef {object} Probe
 * @property {string} [setup]     shell run first in a scratch directory
 * @property {string} [bad]       the snippet portsh must flag
 * @property {string} [good]      the recommended portable replacement
 * @property {string} [expect]    stdout (trimmed) that a working `bad`/`good` prints
 * @property {string} [presence]  instead of running code: check `command -v <name>`
 * @property {string} [shell]     interpreter, default `sh`
 * @property {Platform[]} [skip]  platforms where the probe is not meaningful
 * @property {Platform[]} [fails] platforms where this probe breaks, when it differs from the rule
 */

/**
 * @typedef {object} RuleContext
 * @property {'bash' | 'sh' | 'zsh' | 'other' | 'unknown'} dialect
 * @property {Set<string>} probed   command names the script checks for before using
 * @property {string | null} interpreter
 * @property {Platform[]} [scope]  platforms in play for this command (targets narrowed by context)
 */

/**
 * @typedef {object} Hit
 * @property {string} message
 * @property {string} [fix]
 * @property {Platform[]} [fails]  overrides the rule's platforms for this hit
 * @property {string} [key]        de-duplication key when several commands report the same text
 */

/**
 * @typedef {object} Rule
 * @property {string} id
 * @property {'error' | 'warn'} severity
 * @property {Platform[]} fails
 * @property {string} title
 * @property {string} why
 * @property {string} fix
 * @property {string[]} commands  command names this rule looks at; `*` for all
 * @property {(cmd: Command, ctx: RuleContext) => (Hit | null)} check
 * @property {Probe[]} probes
 */

/**
 * Option-looking arguments of a command (stops at `--`).
 * @param {Command} cmd
 * @returns {string[]}
 */
export function optionArgs(cmd) {
  const out = [];
  for (const a of cmd.args) {
    if (a === '--') break;
    if (a.length > 1 && a[0] === '-' && !/^-[0-9]+$/.test(a)) out.push(a);
  }
  return out;
}

/**
 * True when a short-flag cluster such as `-rf` or `-Pio` contains one of `letters`.
 * @param {Command} cmd
 * @param {string} letters
 */
export function hasShort(cmd, letters) {
  for (const a of optionArgs(cmd)) {
    if (/^-[A-Za-z]+$/.test(a) && [...letters].some((l) => a.includes(l))) return true;
  }
  return false;
}

/**
 * @param {Command} cmd
 * @param {string[]} longs e.g. ['--perl-regexp']
 * @returns {string | null} the matching option as written
 */
export function findLong(cmd, longs) {
  for (const a of optionArgs(cmd)) {
    const base = a.split('=')[0];
    if (longs.includes(base)) return a;
  }
  return null;
}

/**
 * The argument following `flag` (exact match), or undefined.
 * @param {Command} cmd
 * @param {string} flag
 */
export function valueAfter(cmd, flag) {
  const i = cmd.args.indexOf(flag);
  return i === -1 ? undefined : cmd.args[i + 1];
}

/**
 * Backtick-quote for messages.
 * @param {string} s
 */
export function code(s) {
  return `\`${s}\``;
}
