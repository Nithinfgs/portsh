/**
 * date, stat, du, head, install, mktemp... where flags differ between GNU and BSD.
 */

import { code, hasShort, optionArgs } from './helpers.js';

/** @typedef {import('./helpers.js').Rule} Rule */
/** @typedef {import('./helpers.js').Probe} Probe */
/** @typedef {import('../parse.js').Command} Command */
/** @typedef {import('../platforms.js').Platform} Platform */

const SETUP_HELLO = "printf 'hello\\n' > f.txt";

/**
 * GNU long options on commands whose BSD versions only take short flags.
 * `opts: null` means every long option fails on macOS.
 *
 * `alpine: true` marks tools whose BusyBox build (Alpine) also rejects GNU long options; verified in CI.
 *
 * @type {{cmd: string, opts: string[] | null, alpine?: boolean, except?: string[], fix: string, probe: Probe}[]}
 */
const LONG_OPTION_TABLE = [
  {
    cmd: 'cp',
    opts: null,
    fix: 'Use the short flags: `-f`, `-R`, `-p`, `-v`. For `--parents` use `mkdir -p` + `cp`.',
    probe: { setup: SETUP_HELLO, bad: 'cp --force f.txt g.txt && cat g.txt', good: 'cp -f f.txt g.txt && cat g.txt', expect: 'hello' },
  },
  {
    cmd: 'mv',
    opts: null,
    fix: 'Use the short flags: `-f`, `-v`.',
    probe: { setup: SETUP_HELLO, bad: 'mv --force f.txt g.txt && cat g.txt', good: 'mv -f f.txt g.txt && cat g.txt', expect: 'hello' },
  },
  {
    cmd: 'rm',
    opts: null,
    fix: 'Use `-f`, `-r`, `-v`.',
    probe: { setup: SETUP_HELLO, bad: 'rm --force f.txt && echo ok', good: 'rm -f f.txt && echo ok', expect: 'ok' },
  },
  {
    cmd: 'mkdir',
    opts: null,
    fix: 'Use `-p` and `-m`.',
    probe: { bad: 'mkdir --parents a/b && echo ok', good: 'mkdir -p a/b && echo ok', expect: 'ok' },
  },
  {
    cmd: 'ln',
    opts: null,
    fix: 'Use `-s`, `-f`, `-n`.',
    probe: { setup: SETUP_HELLO, bad: 'ln --symbolic --force f.txt l && cat l', good: 'ln -sf f.txt l && cat l', expect: 'hello' },
  },
  {
    cmd: 'du',
    opts: null,
    fix: 'Use `-s`, `-h`, `-k` and `-d N` instead of `--max-depth=N`.',
    probe: { bad: 'du --max-depth=0 . >/dev/null && echo ok', good: 'du -d 0 . >/dev/null && echo ok', expect: 'ok', skip: ['alpine'] },
  },
  {
    cmd: 'df',
    opts: null,
    fix: 'Use `-h`, `-k`, `-P`.',
    probe: { bad: 'df --human-readable / >/dev/null && echo ok', good: 'df -h / >/dev/null && echo ok', expect: 'ok' },
  },
  {
    cmd: 'cut',
    opts: null,
    fix: 'Use `-d`, `-f`, `-c`.',
    probe: { setup: "printf 'a,b\\n' > f.txt", bad: 'cut --delimiter=, --fields=1 f.txt', good: 'cut -d, -f1 f.txt', expect: 'a' },
  },
  {
    cmd: 'wc',
    opts: null,
    fix: 'Use `-l`, `-w`, `-c`.',
    probe: { setup: SETUP_HELLO, bad: "wc --lines < f.txt | tr -d ' '", good: "wc -l < f.txt | tr -d ' '", expect: '1' },
  },
  {
    cmd: 'touch',
    opts: null,
    fix: 'Use `-r file` for a reference file and `-t [[CC]YY]MMDDhhmm` for a timestamp.',
    probe: { setup: SETUP_HELLO, bad: 'touch --reference=f.txt g.txt && echo ok', good: 'touch -r f.txt g.txt && echo ok', expect: 'ok' },
  },
  {
    cmd: 'chmod',
    opts: null,
    fix: 'Use `-R`, `-v`.',
    probe: { setup: 'mkdir a', bad: 'chmod --recursive 755 a && echo ok', good: 'chmod -R 755 a && echo ok', expect: 'ok' },
  },
  {
    cmd: 'chown',
    opts: null,
    fix: 'Use `-R`, `-h`.',
    probe: { setup: 'mkdir a', bad: 'chown --recursive "$(id -u)" a && echo ok', good: 'chown -R "$(id -u)" a && echo ok', expect: 'ok' },
  },
  {
    cmd: 'readlink',
    opts: null,
    fix: 'Use `readlink -f` (macOS 12.3+, Linux, Alpine).',
    probe: {
      setup: SETUP_HELLO,
      bad: 'readlink --canonicalize f.txt >/dev/null && echo ok',
      good: 'readlink -f f.txt >/dev/null && echo ok',
      expect: 'ok',
    },
  },
  {
    cmd: 'realpath',
    opts: null,
    fix: 'Use plain `realpath file`. For relative paths compute them with `python3 -c "import os,sys;print(os.path.relpath(*sys.argv[1:]))"`.',
    probe: {
      setup: SETUP_HELLO,
      bad: 'realpath --relative-to=. f.txt >/dev/null && echo ok',
      good: 'realpath f.txt >/dev/null && echo ok',
      expect: 'ok',
      skip: ['alpine'],
    },
  },
  {
    cmd: 'basename',
    opts: null,
    fix: 'Use the POSIX form `basename NAME SUFFIX`.',
    probe: { bad: 'basename --suffix=.txt f.txt', good: 'basename f.txt .txt', expect: 'f' },
  },
  {
    cmd: 'install',
    opts: null,
    fix: 'Use `-m`, `-o`, `-g`, `-d`.',
    probe: {
      setup: SETUP_HELLO,
      bad: 'install --mode=644 f.txt g.txt && echo ok',
      good: 'install -m 644 f.txt g.txt && echo ok',
      expect: 'ok',
    },
  },
  {
    cmd: 'ps',
    opts: null,
    fix: 'Use BSD/POSIX options: `ps -p PID -o pid=` or `ps -ax -o pid,command`.',
    probe: {
      bad: 'ps --no-headers -p $$ >/dev/null && echo ok',
      good: 'ps -p $$ -o pid= >/dev/null && echo ok',
      expect: 'ok',
      skip: ['alpine'],
    },
  },
  {
    cmd: 'paste',
    opts: null,
    fix: 'Use `-s` and `-d`.',
    probe: { setup: "printf 'a\\nb\\n' > f.txt", bad: 'paste --serial f.txt', good: 'paste -s f.txt', expect: 'a\tb' },
  },
  {
    cmd: 'ls',
    opts: null,
    except: ['--color', '--help', '--version'],
    fix: 'Use `-A`, `-h`, `-F`, `-t`. For ordering use `sort`.',
    probe: { bad: 'ls --almost-all >/dev/null && echo ok', good: 'ls -A >/dev/null && echo ok', expect: 'ok' },
  },
  {
    cmd: 'mktemp',
    opts: ['--suffix', '--tmpdir'],
    fix: 'Use `mktemp "${TMPDIR:-/tmp}/name.XXXXXX"` and rename if a suffix is needed.',
    probe: {
      bad: 'mktemp --suffix=.x >/dev/null && echo ok',
      good: 'mktemp "${TMPDIR:-/tmp}/name.XXXXXX" >/dev/null && echo ok',
      expect: 'ok',
    },
  },
  {
    cmd: 'tar',
    opts: ['--transform', '--xform', '--wildcards', '--one-top-level', '--sort'],
    fix: 'Use `tar -tf archive | grep ...`, or `-s` (BSD) vs `--transform` (GNU) behind a uname check.',
    probe: {
      setup: `${SETUP_HELLO}; tar -cf t.tar f.txt`,
      bad: "tar --wildcards -tf t.tar '*.txt'",
      good: "tar -tf t.tar | grep '\\.txt$'",
      expect: 'f.txt',
    },
  },
];

/** @type {Rule[]} */
const longOptionRules = [
  {
    id: 'gnu-long-options',
    severity: 'error',
    fails: ['macos', 'alpine'],
    title: 'GNU long options on BSD tools',
    why: 'Most BSD utilities on macOS (cp, mv, rm, mkdir, ln, du, df, cut, wc, touch, chmod, ps, ...) accept only short flags, and several BusyBox tools on Alpine (rm, ln, df, cut, wc, chmod, ls, tar, ...) do too. `rm --force` fails with "illegal option -- -".',
    fix: 'Use the short flag equivalent (see the per-command hint in the message).',
    commands: [...new Set(LONG_OPTION_TABLE.map((e) => e.cmd))],
    check(cmd) {
      for (const e of LONG_OPTION_TABLE) {
        if (e.cmd !== cmd.name) continue;
        for (const a of optionArgs(cmd)) {
          if (!a.startsWith('--') || a.length <= 2) continue;
          const base = a.split('=')[0];
          if (e.except?.includes(base)) continue;
          if (e.opts === null || e.opts.includes(base)) {
            return {
              message: `${code(`${cmd.name} ${base}`)} is a GNU long option; BSD ${cmd.name} (macOS) only accepts short flags`,
              fix: e.fix,
              key: `${cmd.name} ${base}`,
            };
          }
        }
      }
      return null;
    },
    probes: LONG_OPTION_TABLE.map((e) =>
      e.alpine
        ? { ...e.probe, fails: /** @type {Platform[]} */ (['macos', 'alpine']) }
        : { ...e.probe, fails: /** @type {Platform[]} */ (['macos']) },
    ),
  },
];

/** @type {Rule[]} */
export const coreutilsRules = [
  ...longOptionRules,
  {
    id: 'date-gnu-flags',
    severity: 'error',
    fails: ['macos'],
    title: '`date -d` and other GNU date options',
    why: 'BSD date has no `-d`, `--date` or `--iso-8601`. It parses dates with `-j -f FORMAT` and does arithmetic with `-v`.',
    fix: 'There is no single portable flag. Branch on `uname`, or use `date -u -r SECONDS` (BSD) with `date -u -d @SECONDS` (GNU, BusyBox) as a fallback.',
    commands: ['date'],
    check(cmd) {
      for (const a of optionArgs(cmd)) {
        if (a.startsWith('--') && a.length > 2) return { message: `${code(`date ${a.split('=')[0]}`)} is a GNU long option` };
        if (/^-[A-Za-z]*d$/.test(a) || /^-d.+/.test(a)) return { message: '`date -d` is GNU/BusyBox only; BSD date uses `-j -f` and `-v`' };
      }
      return null;
    },
    probes: [
      {
        bad: "date -u -d '2020-01-02 03:04:05' +%Y",
        good: 'date -u -r 1577934245 +%Y 2>/dev/null || date -u -d @1577934245 +%Y',
        expect: '2020',
      },
    ],
  },
  {
    id: 'date-bsd-flags',
    severity: 'error',
    fails: ['linux', 'alpine'],
    title: '`date -v` / `date -j` (BSD)',
    why: '`-v` (adjust) and `-j -f` (parse) are BSD date options; GNU date and BusyBox date reject them.',
    fix: 'Branch on `uname`, or use `date -u -d` on GNU and `date -u -v` on BSD behind a check.',
    commands: ['date'],
    check(cmd) {
      for (const a of optionArgs(cmd)) {
        if (/^-v[-+]?\d/.test(a) || a === '-v') return { message: '`date -v` only works on BSD date' };
      }
      if (hasShort(cmd, 'j')) return { message: '`date -j` only works on BSD date' };
      return null;
    },
    probes: [
      {
        bad: "date -u -j -f '%Y-%m-%d %H:%M:%S' '2020-01-02 03:04:05' +%Y",
        good: 'date -u -r 1577934245 +%Y 2>/dev/null || date -u -d @1577934245 +%Y',
        expect: '2020',
      },
    ],
  },
  {
    id: 'stat-gnu-format',
    severity: 'error',
    fails: ['macos'],
    title: '`stat -c` / `--format`',
    why: 'BSD stat formats with `-f` and uses different specifiers; `-c`, `--format`, `--printf` and `--terse` do not exist.',
    fix: 'For a size use `wc -c < file`. For other fields branch on `uname`.',
    commands: ['stat'],
    check(cmd) {
      for (const a of optionArgs(cmd)) {
        if (/^--(format|printf|terse|file-system|dereference)/.test(a))
          return { message: `${code(`stat ${a.split('=')[0]}`)} is GNU-only` };
        if (/^-[A-Za-z]*c$/.test(a)) return { message: '`stat -c` is GNU/BusyBox only; BSD stat uses `-f`' };
      }
      return null;
    },
    probes: [
      {
        setup: SETUP_HELLO,
        bad: 'stat -c %s f.txt',
        good: "wc -c < f.txt | tr -d ' '",
        expect: '6',
      },
    ],
  },
  {
    id: 'stat-bsd-format',
    severity: 'error',
    fails: ['linux', 'alpine'],
    title: '`stat -f FORMAT` (BSD)',
    why: 'On GNU stat and BusyBox stat, `-f` means "filesystem status", not "format", so `stat -f %z file` prints filesystem data or fails.',
    fix: 'For a size use `wc -c < file`. For other fields branch on `uname`.',
    commands: ['stat'],
    check(cmd) {
      for (let i = 0; i < cmd.args.length; i++) {
        const a = cmd.args[i];
        if (/^-[A-Za-z]*f$/.test(a) && (cmd.args[i + 1] ?? '').includes('%')) return { message: '`stat -f FORMAT` only works on BSD stat' };
        if (/^-f%/.test(a)) return { message: '`stat -f FORMAT` only works on BSD stat' };
      }
      return null;
    },
    probes: [
      {
        setup: SETUP_HELLO,
        bad: 'stat -f %z f.txt',
        good: "wc -c < f.txt | tr -d ' '",
        expect: '6',
      },
    ],
  },
  {
    id: 'head-negative-count',
    severity: 'error',
    fails: ['macos'],
    title: '`head -n -N` (all but the last N lines)',
    why: 'Negative line counts are a GNU extension. BSD head fails with "illegal line count".',
    fix: 'Use `sed "$d"` to drop the last line, or `awk` to drop the last N.',
    commands: ['head'],
    check(cmd) {
      for (let i = 0; i < cmd.args.length; i++) {
        const a = cmd.args[i];
        if (/^-[nc]$/.test(a) && /^-\d+$/.test(cmd.args[i + 1] ?? '')) return { message: '`head -n -N` is GNU-only' };
        if (/^-[nc]-\d+$/.test(a)) return { message: '`head -n -N` is GNU-only' };
      }
      return null;
    },
    probes: [{ bad: "printf 'a\\nb\\n' | head -n -1", good: "printf 'a\\nb\\n' | sed '$d'", expect: 'a' }],
  },
  {
    id: 'du-apparent-bytes',
    severity: 'error',
    fails: ['macos'],
    title: '`du -b`',
    why: 'BSD du has no `-b` (apparent size in bytes).',
    fix: 'Use `wc -c < file` for one file, or `find ... -exec wc -c {} +`.',
    commands: ['du'],
    check(cmd) {
      return hasShort(cmd, 'b') ? { message: '`du -b` is GNU-only' } : null;
    },
    probes: [{ setup: SETUP_HELLO, bad: 'du -b f.txt | cut -f1', good: "wc -c < f.txt | tr -d ' '", expect: '6', skip: ['alpine'] }],
  },
  {
    id: 'ln-gnu-flags',
    severity: 'error',
    fails: ['macos'],
    title: '`ln -r` / `ln -T`',
    why: 'BSD ln has no `--relative` (`-r`) or `--no-target-directory` (`-T`).',
    fix: 'Create the link from the directory it lives in with a relative target: `(cd dir && ln -s ../target name)`.',
    commands: ['ln'],
    check(cmd) {
      return hasShort(cmd, 'rT') ? { message: '`ln -r` and `ln -T` are GNU-only' } : null;
    },
    probes: [{ setup: SETUP_HELLO, bad: 'ln -s -r f.txt l && cat l', good: 'ln -s f.txt l && cat l', expect: 'hello', skip: ['alpine'] }],
  },
  {
    id: 'install-create-dirs',
    severity: 'error',
    fails: ['macos'],
    title: '`install -D`',
    why: 'BSD install has no `-D` to create leading directories.',
    fix: 'Run `mkdir -p "$(dirname dest)"` first, then `install`.',
    commands: ['install'],
    check(cmd) {
      return hasShort(cmd, 'D') ? { message: '`install -D` is GNU-only' } : null;
    },
    probes: [
      {
        setup: SETUP_HELLO,
        bad: 'install -D f.txt out/sub/f.txt && echo ok',
        good: 'mkdir -p out/sub && install f.txt out/sub/f.txt && echo ok',
        expect: 'ok',
      },
    ],
  },
  {
    id: 'touch-relative-date',
    severity: 'error',
    fails: ['macos', 'alpine'],
    title: '`touch -d` with a relative date',
    why: 'BSD touch (macOS) and BusyBox touch (Alpine) accept `-d` only with a fixed timestamp format, not strings like "2 days ago" or "yesterday".',
    fix: 'Use `touch -t YYYYMMDDhhmm` or compute the timestamp with `date`.',
    commands: ['touch'],
    check(cmd) {
      const i = cmd.args.indexOf('-d');
      const v = i === -1 ? undefined : cmd.args[i + 1];
      if (v !== undefined && !/^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}:\d{2}(\.\d+)?Z?)?$/.test(v) && !v.includes('$')) {
        return { message: '`touch -d` with a free-form date is GNU-only; BSD touch needs ISO-8601' };
      }
      return null;
    },
    probes: [
      { setup: SETUP_HELLO, bad: "touch -d '2 days ago' f.txt && echo ok", good: 'touch -t 202001010000 f.txt && echo ok', expect: 'ok' },
    ],
  },
  {
    id: 'mktemp-t-prefix',
    severity: 'error',
    fails: ['linux', 'alpine'],
    title: '`mktemp -t prefix` (BSD)',
    why: 'On BSD, `-t prefix` builds a name from a prefix. GNU and BusyBox mktemp require a template ending in `XXXXXX` and fail with "too few X\'s in template".',
    fix: 'Pass a full template: `mktemp "${TMPDIR:-/tmp}/prefix.XXXXXX"`.',
    commands: ['mktemp'],
    check(cmd) {
      const i = cmd.args.findIndex((a) => /^-[A-Za-z]*t$/.test(a));
      if (i === -1) return null;
      const v = cmd.args[i + 1];
      if (v !== undefined && !v.startsWith('-') && !v.includes('XXX') && !v.includes('$'))
        return { message: '`mktemp -t prefix` only works on BSD; GNU needs a template with XXXXXX' };
      return null;
    },
    probes: [{ bad: 'mktemp -t foo >/dev/null && echo ok', good: 'mktemp -t foo.XXXXXX >/dev/null && echo ok', expect: 'ok' }],
  },
  {
    id: 'getopt-long-options',
    severity: 'error',
    fails: ['macos'],
    title: 'external `getopt` with long options',
    why: 'macOS ships the legacy BSD `getopt`, which ignores `-l`/`--long` and `-o`. The parsed result is silently wrong.',
    fix: 'Use the `getopts` shell builtin, or a manual `while case` loop for long options.',
    commands: ['getopt'],
    check(cmd) {
      if (cmd.args.some((a) => a === '-l' || a === '--long' || a === '-o' || a === '--options' || a.startsWith('--long='))) {
        return { message: 'GNU `getopt` with `-o`/`-l` is not what macOS ships' };
      }
      return null;
    },
    probes: [{ bad: 'getopt -o a -l long -- --long', good: 'echo "--long --"', expect: '--long --' }],
  },
  {
    id: 'tail-reverse',
    severity: 'error',
    fails: ['linux', 'alpine'],
    title: '`tail -r` (BSD)',
    why: '`tail -r` (print lines in reverse) exists on BSD only. GNU has `tac`, which macOS lacks.',
    fix: "Use the POSIX `sed '1!G;h;$!d'`.",
    commands: ['tail'],
    check(cmd) {
      return hasShort(cmd, 'r') ? { message: '`tail -r` only works on BSD tail' } : null;
    },
    probes: [{ bad: "printf 'a\\nb\\n' | tail -r", good: "printf 'a\\nb\\n' | sed '1!G;h;$!d'", expect: 'b\na' }],
  },
  {
    id: 'base64-decode-D',
    severity: 'error',
    fails: ['linux', 'alpine'],
    title: '`base64 -D` (BSD)',
    why: 'BSD base64 spells decode `-D`. GNU and BusyBox use `-d`, and so do current macOS releases.',
    fix: 'Use `base64 -d`. For wrapping control use `tr -d "\\n"`; `-w` is GNU-only.',
    commands: ['base64'],
    check(cmd) {
      return hasShort(cmd, 'D') ? { message: '`base64 -D` only works on BSD base64' } : null;
    },
    probes: [{ bad: "printf 'aGk=' | base64 -D", good: "printf 'aGk=' | base64 -d", expect: 'hi' }],
  },
  {
    id: 'sysctl-bsd-keys',
    severity: 'error',
    fails: ['linux', 'alpine'],
    title: '`sysctl hw.*` (BSD keys)',
    why: 'Keys such as `hw.ncpu` or `machdep.cpu.brand_string` only exist on BSD/macOS. On Linux `sysctl` reads `/proc/sys` and fails.',
    fix: 'Use `getconf _NPROCESSORS_ONLN` for the CPU count, or branch on `uname`.',
    commands: ['sysctl'],
    check(cmd) {
      return cmd.args.some((a) => /^(hw|machdep)\./.test(a)) ? { message: 'this `sysctl` key only exists on BSD/macOS' } : null;
    },
    probes: [{ bad: 'sysctl -n hw.ncpu >/dev/null && echo ok', good: 'getconf _NPROCESSORS_ONLN >/dev/null && echo ok', expect: 'ok' }],
  },
];
