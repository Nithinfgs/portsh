/**
 * Shell-language rules: bash 4+ features (macOS ships bash 3.2) and `echo -e` under sh.
 *
 * Bash rules only fire in scripts whose shebang is bash, because that is where the
 * macOS /bin/bash 3.2 versus Linux bash 5 difference bites.
 */

import { code } from './helpers.js';

/** @typedef {import('./helpers.js').Rule} Rule */
/** @typedef {import('./helpers.js').RuleContext} RuleContext */

const BASH3 = '/bin/bash';
const NOT_BASH3 = /** @type {import('../platforms.js').Platform[]} */ (['alpine']);

/** @param {RuleContext} ctx */
const inBash = (ctx) => ctx.dialect === 'bash';

/**
 * @param {import('../parse.js').Command} cmd
 * @param {string} letter
 */
function declareFlag(cmd, letter) {
  return cmd.args.some((a) => /^-[A-Za-z]+$/.test(a) && a.includes(letter));
}

/** @type {Rule[]} */
export const shellRules = [
  {
    id: 'bash4-mapfile',
    severity: 'warn',
    fails: ['macos'],
    title: '`mapfile` / `readarray` need bash 4',
    why: 'macOS still ships bash 3.2 as /bin/bash (and `#!/usr/bin/env bash` finds it unless Homebrew bash is first in PATH). `mapfile` and `readarray` were added in bash 4.0.',
    fix: 'Read lines in a loop: `while IFS= read -r line; do arr+=("$line"); done < <(command)`.',
    commands: ['mapfile', 'readarray'],
    check: (cmd, ctx) => (inBash(ctx) ? { message: `${code(cmd.name)} requires bash 4+ (macOS has bash 3.2)` } : null),
    probes: [
      {
        shell: BASH3,
        skip: NOT_BASH3,
        bad: "mapfile -t arr < <(printf 'a\\nb\\n'); echo ${#arr[@]}",
        good: 'while IFS= read -r l; do arr+=("$l"); done < <(printf \'a\\nb\\n\'); echo ${#arr[@]}',
        expect: '2',
      },
    ],
  },
  {
    id: 'bash4-associative-array',
    severity: 'warn',
    fails: ['macos'],
    title: 'associative arrays need bash 4',
    why: '`declare -A` (also `local -A`, `typeset -A`) was added in bash 4.0; bash 3.2 reports "invalid option".',
    fix: 'Use two parallel indexed arrays, a `case` statement, or a temp file of `key=value` lines.',
    commands: ['declare', 'local', 'typeset'],
    check: (cmd, ctx) => (inBash(ctx) && declareFlag(cmd, 'A') ? { message: 'associative arrays (`-A`) require bash 4+' } : null),
    probes: [{ shell: BASH3, skip: NOT_BASH3, bad: 'declare -A m && m[a]=1 && m[b]=2 && echo "${m[a]}"', expect: '1' }],
  },
  {
    id: 'bash4-nameref',
    severity: 'warn',
    fails: ['macos'],
    title: 'namerefs (`declare -n`) need bash 4.3',
    why: '`declare -n` / `local -n` namerefs were added in bash 4.3.',
    fix: 'Use `eval` with a validated variable name, or return values via stdout.',
    commands: ['declare', 'local', 'typeset'],
    check: (cmd, ctx) => (inBash(ctx) && declareFlag(cmd, 'n') ? { message: 'namerefs (`-n`) require bash 4.3+' } : null),
    probes: [{ shell: BASH3, skip: NOT_BASH3, bad: 'f(){ local -n r=$1; r=ok; }; f v; echo "$v"', expect: 'ok' }],
  },
  {
    id: 'bash4-case-modification',
    severity: 'warn',
    fails: ['macos'],
    title: '`${var,,}` / `${var^^}` need bash 4',
    why: 'Case-modifying parameter expansion was added in bash 4.0; bash 3.2 fails with "bad substitution".',
    fix: "Use `tr '[:upper:]' '[:lower:]'` (or the reverse).",
    commands: ['*'],
    check(cmd, ctx) {
      if (!inBash(ctx)) return null;
      for (const w of cmd.words) {
        const m = w.raw.match(/\$\{[A-Za-z_][A-Za-z0-9_]*(,,?|\^\^?)[^}]*\}/);
        if (m) return { message: `${code(m[0])} requires bash 4+`, key: m[0] };
      }
      return null;
    },
    probes: [
      {
        shell: BASH3,
        skip: NOT_BASH3,
        bad: 'v=AbC; echo "${v,,}"',
        good: "v=AbC; echo \"$v\" | tr '[:upper:]' '[:lower:]'",
        expect: 'abc',
      },
    ],
  },
  {
    id: 'bash4-negative-index',
    severity: 'warn',
    fails: ['macos'],
    title: '`${arr[-1]}` needs bash 4.3',
    why: 'Negative array subscripts were added in bash 4.3; bash 3.2 fails with "bad array subscript".',
    fix: 'Compute the index: `${arr[${#arr[@]}-1]}`.',
    commands: ['*'],
    check(cmd, ctx) {
      if (!inBash(ctx)) return null;
      for (const w of cmd.words) {
        const m = w.raw.match(/\$\{[A-Za-z_][A-Za-z0-9_]*\[-\d+\]\}/);
        if (m) return { message: `${code(m[0])} requires bash 4.3+`, key: m[0] };
      }
      return null;
    },
    probes: [
      {
        shell: BASH3,
        skip: NOT_BASH3,
        bad: 'a=(x y); echo "${a[-1]}"',
        good: 'a=(x y); echo "${a[${#a[@]}-1]}"',
        expect: 'y',
      },
    ],
  },
  {
    id: 'bash4-redirect-append-both',
    severity: 'warn',
    fails: ['macos'],
    title: '`&>>` and `|&` need bash 4',
    why: 'Both operators were added in bash 4.0 and are syntax errors in bash 3.2.',
    fix: 'Write `>> file 2>&1` and `2>&1 |`.',
    commands: ['*'],
    check(cmd, ctx) {
      if (!inBash(ctx)) return null;
      const op = cmd.ops.find((o) => o === '&>>' || o === '|&');
      return op ? { message: `${code(op)} requires bash 4+`, key: op } : null;
    },
    probes: [
      {
        shell: BASH3,
        skip: NOT_BASH3,
        bad: 'echo x &>> out.txt; cat out.txt',
        good: 'echo x >> out.txt 2>&1; cat out.txt',
        expect: 'x',
      },
    ],
  },
  {
    id: 'bash4-globstar',
    severity: 'warn',
    fails: ['macos'],
    title: '`shopt -s globstar` needs bash 4',
    why: 'The `globstar` shell option (`**` matches recursively) was added in bash 4.0.',
    fix: 'Use `find . -name "*.ext"` instead of `**/*.ext`.',
    commands: ['shopt'],
    check: (cmd, ctx) =>
      inBash(ctx) && cmd.args.some((a) => ['globstar', 'autocd', 'dirspell', 'direxpand', 'checkjobs'].includes(a))
        ? { message: 'this `shopt` option requires bash 4+' }
        : null,
    probes: [{ shell: BASH3, skip: NOT_BASH3, bad: 'shopt -s globstar && echo ok', expect: 'ok' }],
  },
  {
    id: 'bash4-wait-n',
    severity: 'warn',
    fails: ['macos'],
    title: '`wait -n` needs bash 4.3',
    why: '`wait -n` (wait for any job) was added in bash 4.3.',
    fix: 'Poll with `kill -0 $pid` or wait for specific pids.',
    commands: ['wait'],
    check: (cmd, ctx) => (inBash(ctx) && cmd.args.includes('-n') ? { message: '`wait -n` requires bash 4.3+' } : null),
    probes: [{ shell: BASH3, skip: NOT_BASH3, bad: 'sleep 0.1 & wait -n && echo ok', expect: 'ok' }],
  },
  {
    id: 'bash4-test-v',
    severity: 'warn',
    fails: ['macos'],
    title: '`[[ -v var ]]` needs bash 4.2',
    why: 'The `-v` variable-is-set test was added in bash 4.2.',
    fix: 'Use `[[ -n "${var+x}" ]]`, which also works in bash 3.2.',
    commands: ['[[', '['],
    check: (cmd, ctx) => (inBash(ctx) && cmd.args[0] === '-v' ? { message: '`[[ -v var ]]` requires bash 4.2+' } : null),
    probes: [
      {
        shell: BASH3,
        skip: NOT_BASH3,
        bad: 'x=1; [[ -v x ]] && echo ok',
        good: 'x=1; [[ -n "${x+x}" ]] && echo ok',
        expect: 'ok',
      },
    ],
  },
  {
    id: 'bash5-epoch-variables',
    severity: 'warn',
    fails: ['macos'],
    title: '`$EPOCHSECONDS` / `$EPOCHREALTIME` need bash 5',
    why: 'These variables were added in bash 5.0 and expand to nothing in bash 3.2.',
    fix: 'Use `date +%s`.',
    commands: ['*'],
    check(cmd, ctx) {
      if (!inBash(ctx)) return null;
      for (const w of cmd.words) {
        const m = w.raw.match(/\$\{?(EPOCHSECONDS|EPOCHREALTIME)\b/);
        if (m) return { message: `${code(`$${m[1]}`)} requires bash 5+`, key: m[1] };
      }
      return null;
    },
    probes: [
      {
        shell: BASH3,
        skip: NOT_BASH3,
        bad: '[ -n "$EPOCHSECONDS" ] && echo ok',
        good: '[ -n "$(date +%s)" ] && echo ok',
        expect: 'ok',
      },
    ],
  },
  {
    id: 'sh-echo-escapes',
    severity: 'warn',
    fails: ['macos', 'linux'],
    title: '`echo -e` in a POSIX sh script',
    why: 'Under `/bin/sh` the `-e` flag is not portable: macOS sh and Debian/Ubuntu dash print a literal `-e`. It only works in bash, zsh and BusyBox ash.',
    fix: 'Use `printf` with a format string: `printf "a\\tb\\n"`.',
    commands: ['echo'],
    check(cmd, ctx) {
      if (ctx.dialect !== 'sh') return null;
      return cmd.args[0] && /^-[neE]*e[neE]*$/.test(cmd.args[0])
        ? { message: '`echo -e` prints a literal `-e` under POSIX sh on macOS and Debian/Ubuntu' }
        : null;
    },
    probes: [
      {
        shell: 'sh',
        skip: ['alpine'],
        bad: "echo -e 'a\\tb'",
        good: "printf 'a\\tb\\n'",
        expect: 'a\tb',
      },
    ],
  },
];
