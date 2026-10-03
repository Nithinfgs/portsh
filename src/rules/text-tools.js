/**
 * sed, grep, find, xargs, awk: the tools where GNU, BSD and BusyBox disagree most.
 */

import { code, findLong, hasShort, optionArgs } from './helpers.js';

/** @typedef {import('./helpers.js').Rule} Rule */

const SETUP_HELLO = "printf 'hello\\n' > f.txt";

/** Remove `[...]` bracket expressions so `[\s]` is not mistaken for `\s`. */
const stripBrackets = (/** @type {string} */ s) => s.replace(/\[\^?\]?(?:\[:[a-z]+:\]|[^\]])*\]/g, '');

/** @type {Rule[]} */
export const textToolRules = [
  // ---- sed ----------------------------------------------------------------
  {
    id: 'sed-inplace-no-suffix',
    severity: 'error',
    fails: ['macos'],
    title: '`sed -i` without a backup suffix',
    why: 'GNU sed treats the suffix of -i as optional and attached (`-i.bak`). BSD sed (macOS) always consumes the next argument as the suffix, so `sed -i s/a/b/ file` fails, and `sed -i -e ...` silently leaves backup files named `file-e`.',
    fix: 'Attach a suffix and remove the backup: `sed -i.bak ... file && rm -f file.bak` works everywhere.',
    commands: ['sed'],
    check(cmd) {
      for (let i = 0; i < cmd.args.length; i++) {
        const a = cmd.args[i];
        if (a === '--') break;
        if (/^-[A-Za-z]*i$/.test(a) && !/[ef]/.test(a.slice(0, -1))) {
          if (cmd.args[i + 1] === '') return null; // `-i ''` is the BSD form, see sed-inplace-empty-suffix
          return { message: '`sed -i` needs an attached suffix to work on both GNU and BSD sed' };
        }
      }
      return null;
    },
    probes: [
      {
        setup: SETUP_HELLO,
        bad: "sed -i 's/hello/bye/' f.txt && cat f.txt",
        good: "sed -i.bak 's/hello/bye/' f.txt && rm -f f.txt.bak && cat f.txt",
        expect: 'bye',
      },
    ],
  },
  {
    id: 'sed-inplace-empty-suffix',
    severity: 'error',
    fails: ['linux', 'alpine'],
    title: "`sed -i ''` (BSD form)",
    why: "On GNU and BusyBox sed the empty string after -i is read as the script, so `sed -i '' s/a/b/ file` fails with \"can't read s/a/b/\".",
    fix: 'Use `sed -i.bak ... file && rm -f file.bak`, which both implementations accept.',
    commands: ['sed'],
    check(cmd) {
      for (let i = 0; i < cmd.args.length - 1; i++) {
        if (/^-[A-Za-z]*i$/.test(cmd.args[i]) && cmd.args[i + 1] === '' && cmd.words[i + 2]?.quoted) {
          return { message: "`sed -i ''` only works on BSD sed" };
        }
      }
      return null;
    },
    probes: [
      {
        setup: SETUP_HELLO,
        bad: "sed -i '' 's/hello/bye/' f.txt && cat f.txt",
        good: "sed -i.bak 's/hello/bye/' f.txt && rm -f f.txt.bak && cat f.txt",
        expect: 'bye',
      },
    ],
  },
  {
    id: 'sed-gnu-flags',
    severity: 'error',
    fails: ['macos'],
    title: 'GNU-only sed options',
    why: 'BSD sed has no long options (`--expression`, `--regexp-extended`, `--quiet`, `--in-place`...) and no `-s` or `-z`.',
    fix: 'Use the short forms: `-e`, `-E`, `-n`, and `-i.bak`. For NUL-separated input use `tr` or `perl -0pe`.',
    commands: ['sed'],
    check(cmd) {
      for (const a of optionArgs(cmd)) {
        if (a.startsWith('--') && a.length > 2)
          return { message: `${code(`sed ${a.split('=')[0]}`)} is a GNU long option; BSD sed rejects it` };
      }
      if (hasShort(cmd, 'zs')) {
        const flag = optionArgs(cmd).find((a) => /^-[A-Za-z]+$/.test(a) && /[zs]/.test(a)) ?? '-z';
        return { message: `${code(`sed ${flag}`)} is GNU-only` };
      }
      return null;
    },
    probes: [
      {
        setup: SETUP_HELLO,
        bad: "sed --expression='s/hello/bye/' f.txt",
        good: "sed -e 's/hello/bye/' f.txt",
        expect: 'bye',
      },
    ],
  },
  {
    id: 'sed-gnu-escapes',
    severity: 'error',
    fails: ['macos'],
    title: 'GNU regex escapes in sed (`\\s`, `\\w`)',
    why: 'BSD sed does not understand `\\s`, `\\S`, `\\w` or `\\W`. They silently match nothing, so the substitution does not happen and no error is printed.',
    fix: 'Use POSIX classes: `[[:space:]]`, `[^[:space:]]`, `[[:alnum:]_]`, `[^[:alnum:]_]`.',
    commands: ['sed'],
    check(cmd) {
      for (const a of cmd.args) {
        if (a.startsWith('-') && a.length > 1) continue;
        const m = stripBrackets(a).match(/\\([sSwW])/);
        if (m) return { message: `\`\\${m[1]}\` is not supported by BSD sed and silently matches nothing`, key: m[0] };
      }
      return null;
    },
    probes: [
      {
        bad: "echo 'a b' | sed 's/\\s/_/'",
        good: "echo 'a b' | sed 's/[[:space:]]/_/'",
        expect: 'a_b',
      },
    ],
  },
  {
    id: 'sed-oneline-aic',
    severity: 'error',
    fails: ['macos'],
    title: 'One-line `a`, `i`, `c` commands in sed',
    why: 'GNU sed accepts `sed "/x/a text"` and `sed "1i text"`. BSD sed requires a backslash and a real newline after the command letter and rejects the one-line form with "expected \\ after a, c or i".',
    fix: 'Put the text on its own line after `a\\`, or use `awk`/`printf` to build the output.',
    commands: ['sed'],
    check(cmd) {
      const re = /(?:^|\n)\s*(?:(?:\d+|\$|\/(?:\\.|[^/\\])*\/)(?:\s*,\s*(?:\d+|\$|\/(?:\\.|[^/\\])*\/))?\s*!?)?\s*[aic](?:\\[^\n]|\s+\S)/;
      for (const a of cmd.args) {
        if (a.startsWith('-') && a.length > 1) continue;
        if (re.test(a)) return { message: 'one-line `a`/`i`/`c` is GNU sed syntax; BSD sed needs `a\\` followed by a newline' };
      }
      return null;
    },
    probes: [
      {
        bad: "printf 'x\\n' | sed '1i hello'",
        good: "printf 'x\\n' | sed '1i\\\nhello'",
        expect: 'hello\nx',
      },
    ],
  },
  {
    id: 'sed-step-address',
    severity: 'error',
    fails: ['macos', 'alpine'],
    title: 'GNU sed address forms (`first~step`, `addr,+N`)',
    why: 'The `first~step`, `addr,+N`, `addr,~N` and `0,/re/` addresses are GNU extensions. BSD sed and BusyBox sed report an unknown command.',
    fix: 'Use `awk` (`NR % 2 == 1`) or restructure with line numbers.',
    commands: ['sed'],
    check(cmd) {
      for (const a of cmd.args) {
        if (a.startsWith('-') && a.length > 1) continue;
        if (/(?:^|[;{}\n]\s*)(?:\d+~\d+|0,\/)/.test(a) || /(?:^|[;{}\n]\s*)(?:\d+|\$|\/[^/]*\/)\s*,\s*[+~]\d+/.test(a)) {
          return { message: 'this sed address form is GNU-only' };
        }
      }
      return null;
    },
    probes: [
      {
        bad: "printf '1\\n2\\n3\\n' | sed -n '1~2p'",
        good: "printf '1\\n2\\n3\\n' | awk 'NR % 2 == 1'",
        expect: '1\n3',
      },
    ],
  },

  // ---- grep ---------------------------------------------------------------
  {
    id: 'grep-perl-regexp',
    severity: 'error',
    fails: ['macos', 'alpine'],
    title: '`grep -P` (Perl regex)',
    why: 'BSD grep (macOS) and BusyBox grep (Alpine) do not implement `-P`. Scripts that parse output with `grep -oP` are the most common portability failure on macOS.',
    fix: 'Use `grep -E` with POSIX classes, or `sed -n "s/.../\\1/p"`. For lookaround use `perl -ne` or `awk`.',
    commands: ['grep', 'egrep', 'fgrep'],
    check(cmd) {
      if (hasShort(cmd, 'P') || findLong(cmd, ['--perl-regexp'])) return { message: '`grep -P` is not available in BSD or BusyBox grep' };
      return null;
    },
    probes: [
      {
        bad: "echo abc | grep -oP 'b\\w'",
        good: "echo abc | grep -oE 'b[[:alnum:]_]'",
        expect: 'bc',
      },
    ],
  },

  // ---- find ---------------------------------------------------------------
  {
    id: 'find-gnu-primaries',
    severity: 'error',
    fails: ['macos'],
    title: 'GNU-only `find` primaries',
    why: '`-printf`, `-regextype`, `-executable`, `-readable`, `-writable` and `-xtype` do not exist in BSD find. `-printf` is also missing from BusyBox find.',
    fix: 'Use `-exec basename {} \\;` / `-exec stat ... {} +` instead of `-printf`, and `-perm` instead of `-executable`.',
    commands: ['find'],
    check(cmd) {
      const gnu = ['-printf', '-regextype', '-executable', '-readable', '-writable', '-xtype', '-fprint', '-files0-from'];
      for (const a of cmd.args) {
        if (gnu.includes(a)) {
          return { message: `${code(`find ${a}`)} is GNU-only`, fails: a === '-printf' ? ['macos', 'alpine'] : ['macos'] };
        }
      }
      return null;
    },
    probes: [
      {
        setup: SETUP_HELLO,
        bad: "find . -maxdepth 1 -name f.txt -printf '%f\\n'",
        good: 'find . -maxdepth 1 -name f.txt -exec basename {} \\;',
        expect: 'f.txt',
        fails: ['macos', 'alpine'],
      },
    ],
  },
  {
    id: 'find-bsd-regex-flag',
    severity: 'error',
    fails: ['linux', 'alpine'],
    title: '`find -E` (BSD extended regex)',
    why: 'BSD find takes `-E` before the path to enable extended regular expressions. GNU and BusyBox find do not know the option.',
    fix: 'Use `-name`/`-path` globs, or filter with `grep -E`: `find . | grep -E "..."`.',
    commands: ['find'],
    check(cmd) {
      if (cmd.args[0] === '-E') return { message: '`find -E` only works on BSD find' };
      return null;
    },
    probes: [
      {
        setup: SETUP_HELLO,
        bad: "find -E . -maxdepth 1 -regex '.*/f\\.txt'",
        good: "find . -maxdepth 1 -name 'f.txt'",
        expect: './f.txt',
      },
    ],
  },

  // ---- xargs --------------------------------------------------------------
  {
    id: 'xargs-delimiter',
    severity: 'error',
    fails: ['macos', 'alpine'],
    title: '`xargs -d`',
    why: 'BSD xargs (macOS) and BusyBox xargs (Alpine) have no `-d` / `--delimiter`.',
    fix: 'Use `tr` to convert the delimiter to newlines (`tr "," "\\n" | xargs ...`) or `-0` with NUL-separated input.',
    commands: ['xargs'],
    check(cmd) {
      for (const a of xargsOwnOptions(cmd)) {
        if (a === '-d' || (a.startsWith('-d') && a.length > 2 && !a.startsWith('--')) || a.startsWith('--delimiter')) {
          return { message: '`xargs -d` is GNU-only' };
        }
      }
      return null;
    },
    probes: [
      {
        bad: "printf 'a b' | xargs -d ' ' echo",
        good: "printf 'a b' | tr ' ' '\\n' | xargs echo",
        expect: 'a b',
      },
    ],
  },
  {
    id: 'xargs-replace-J',
    severity: 'error',
    fails: ['linux', 'alpine'],
    title: '`xargs -J` (BSD)',
    why: '`-J replstr` is a BSD xargs option; GNU and BusyBox xargs only know `-I`.',
    fix: 'Use `xargs -I % ...`, which BSD, GNU and BusyBox all accept.',
    commands: ['xargs'],
    check(cmd) {
      for (const a of xargsOwnOptions(cmd)) if (a === '-J') return { message: '`xargs -J` only works on BSD xargs' };
      return null;
    },
    probes: [
      {
        bad: "printf 'a\\n' | xargs -J % echo % x",
        good: "printf 'a\\n' | xargs -I % echo % x",
        expect: 'a x',
      },
    ],
  },

  // ---- awk ----------------------------------------------------------------
  {
    id: 'awk-gawk-extensions',
    severity: 'error',
    fails: ['macos', 'alpine'],
    title: 'gawk-only functions in awk',
    why: 'macOS ships the one-true-awk. It lacks `gensub`, `strftime`, `systime`, `mktime`, `asort`, `asorti`, `strtonum` and `-i inplace`; calling them is a fatal "undefined function". BusyBox awk (Alpine) lacks `strtonum`, `asort` and `asorti`.',
    fix: 'Use `gsub`, `date`, `sort`, or `printf "%d"` in POSIX awk, or install gawk explicitly and call it as `gawk`.',
    commands: ['awk'],
    check(cmd) {
      const fns = ['gensub', 'strftime', 'systime', 'mktime', 'asorti', 'asort', 'strtonum', 'patsplit'];
      for (const a of cmd.args) {
        for (const fn of fns) {
          if (new RegExp(`\\b${fn}\\s*\\(`).test(a)) {
            return {
              message: `${code(`${fn}()`)} is a gawk extension, not available in BSD awk`,
              fails: fn === 'strtonum' || fn === 'asort' || fn === 'asorti' ? ['macos', 'alpine'] : ['macos'],
              key: fn,
            };
          }
        }
      }
      const i = cmd.args.indexOf('-i');
      if (i !== -1 && cmd.args[i + 1] === 'inplace') return { message: '`awk -i inplace` is gawk-only' };
      return null;
    },
    probes: [
      { bad: 'awk \'BEGIN{print strtonum("0x10")}\'', good: "printf '%d\\n' 0x10", expect: '16', fails: ['macos', 'alpine'] },
      {
        bad: 'echo aaa | awk \'{print gensub(/a/,"b","g")}\'',
        good: 'echo aaa | awk \'{gsub(/a/,"b"); print}\'',
        expect: 'bbb',
        fails: ['macos', 'alpine'],
      },
      {
        bad: "awk 'BEGIN{a[1]=2;a[2]=1;n=asort(a);print a[1]}'",
        good: "printf '2\\n1\\n' | sort -n | head -n 1",
        expect: '1',
        fails: ['macos', 'alpine'],
      },
      {
        bad: 'TZ=UTC awk \'BEGIN{print strftime("%Y", 0)}\'',
        good: 'date -u -r 0 +%Y 2>/dev/null || date -u -d @0 +%Y',
        expect: '1970',
        fails: ['macos'],
      },
    ],
  },
];

/**
 * Options that belong to xargs itself (before the command it runs).
 * @param {import('../parse.js').Command} cmd
 */
export function xargsOwnOptions(cmd) {
  const withArg = new Set(['-I', '-n', '-P', '-s', '-d', '-E', '-L', '-a', '-J', '-R', '-S']);
  const out = [];
  for (let k = 0; k < cmd.args.length; k++) {
    const a = cmd.args[k];
    if (a === '--' || !a.startsWith('-') || a === '-') break;
    out.push(a);
    if (withArg.has(a)) k++;
  }
  return out;
}
