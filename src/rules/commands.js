/**
 * Commands that exist on one platform but not another.
 *
 * Every entry is verified by `portsh verify` with `command -v`, so a command that
 * a platform later ships (like `md5sum` on recent macOS) fails verification and gets removed.
 */

/** @typedef {import('./helpers.js').Rule} Rule */
/** @typedef {import('../platforms.js').Platform} Platform */

/**
 * @typedef {object} Entry
 * @property {string} cmd
 * @property {string} fix
 * @property {string} [good]        runnable replacement, verified to print `ok`
 * @property {Platform[]} [skip]    platforms where the presence probe is not reliable
 * @property {Platform[]} [fails]   overrides the table default
 */

/** @type {Entry[]} Exist on Linux, missing on macOS. */
const MISSING_ON_MACOS = [
  {
    cmd: 'nproc',
    fix: 'Use `getconf _NPROCESSORS_ONLN`, which exists on macOS, Linux and Alpine.',
    good: 'getconf _NPROCESSORS_ONLN >/dev/null && echo ok',
  },
  { cmd: 'timeout', fix: "Install GNU coreutils (`gtimeout`), or run `perl -e 'alarm shift; exec @ARGV' SECONDS command`." },
  {
    cmd: 'tac',
    fix: "Use the POSIX `sed '1!G;h;$!d'` (or `tail -r` on BSD).",
    good: "printf 'a\\n' | sed '1!G;h;$!d' >/dev/null && echo ok",
  },
  {
    cmd: 'shuf',
    fix: 'Use `sort -R` where available, or `awk \'BEGIN{srand()} {print rand() "\\t" $0}\' | sort -n | cut -f2-`.',
    skip: ['alpine'],
  },
  { cmd: 'free', fix: 'On macOS use `vm_stat`; branch on `uname`.' },
  { cmd: 'ip', fix: 'On macOS use `ifconfig` / `route`; branch on `uname`.' },
  { cmd: 'ldd', fix: 'On macOS use `otool -L`; branch on `uname`.' },
  { cmd: 'getent', fix: 'On macOS use `dscacheutil -q user -a name NAME`; branch on `uname`.' },
  { cmd: 'pidof', fix: 'Use `pgrep -x NAME`, which exists everywhere.', good: 'pgrep -x nosuchprocess_portsh; [ $? -le 1 ] && echo ok' },
  { cmd: 'watch', fix: 'Use `while true; do COMMAND; sleep N; done`.' },
  { cmd: 'flock', fix: 'Use an atomic `mkdir lockdir` as the lock.' },
  { cmd: 'setsid', fix: 'Use `nohup COMMAND &` or run it in a subshell: `(COMMAND &)`.' },
  { cmd: 'ionice', fix: 'Skip it on macOS: guard with `command -v ionice`.', skip: ['alpine'] },
  { cmd: 'taskset', fix: 'Skip it on macOS: guard with `command -v taskset`.', skip: ['alpine'] },
  { cmd: 'numfmt', fix: 'Format with `awk` or `printf`, or `brew install coreutils` (`gnumfmt`).', fails: ['macos', 'alpine'] },
  { cmd: 'ss', fix: 'On macOS use `netstat` / `lsof -i`; branch on `uname`.', fails: ['macos', 'alpine'] },
  { cmd: 'readelf', fix: 'On macOS use `otool`; branch on `uname`.', fails: ['macos', 'alpine'] },
  { cmd: 'systemctl', fix: 'On macOS use `launchctl`; branch on `uname`.', fails: ['macos', 'alpine'] },
  { cmd: 'journalctl', fix: 'On macOS use `log show`; branch on `uname`.', fails: ['macos', 'alpine'] },
  { cmd: 'xdg-open', fix: 'Use `open` on macOS and `xdg-open` on Linux, chosen by `uname`.', fails: ['macos', 'alpine'] },
  { cmd: 'lsb_release', fix: 'Read `/etc/os-release` on Linux and `sw_vers` on macOS.', fails: ['macos', 'alpine'] },
  { cmd: 'dircolors', fix: 'Skip it on macOS, set `LSCOLORS` instead.', fails: ['macos', 'alpine'] },
  { cmd: 'apt-get', fix: 'Alpine uses `apk add`; macOS uses `brew install`.', fails: ['macos', 'alpine'] },
  { cmd: 'apt', fix: 'Alpine uses `apk add`; macOS uses `brew install`.', fails: ['macos', 'alpine'] },
  { cmd: 'dpkg', fix: 'Alpine uses `apk`; macOS uses `brew`.', fails: ['macos', 'alpine'] },
  { cmd: 'useradd', fix: 'Alpine has `adduser -D`; macOS uses `dscl`/`sysadminctl`.', fails: ['macos', 'alpine'] },
  { cmd: 'groupadd', fix: 'Alpine has `addgroup`; macOS uses `dscl`.', fails: ['macos', 'alpine'] },
  { cmd: 'update-alternatives', fix: 'Debian/Ubuntu only. Guard with `command -v update-alternatives`.', fails: ['macos', 'alpine'] },
];

/** @type {Entry[]} Exist on macOS, missing on Linux and Alpine. */
const MISSING_ON_LINUX = [
  { cmd: 'pbcopy', fix: 'Use `xclip -selection clipboard` or `wl-copy` on Linux; pick one with `command -v`.' },
  { cmd: 'pbpaste', fix: 'Use `xclip -selection clipboard -o` or `wl-paste` on Linux.' },
  {
    cmd: 'open',
    fix: 'Use `xdg-open` on Linux. Choose with `case "$(uname -s)" in Darwin) open ... ;; *) xdg-open ... ;; esac`.',
    skip: ['linux'],
  },
  { cmd: 'sw_vers', fix: 'Read `/etc/os-release` on Linux; branch on `uname -s`.' },
  { cmd: 'defaults', fix: 'macOS preferences have no Linux equivalent; guard with a `uname` check.' },
  { cmd: 'launchctl', fix: 'Use `systemctl` on Linux; branch on `uname`.' },
  { cmd: 'osascript', fix: 'macOS only; guard with a `uname` check.' },
  { cmd: 'caffeinate', fix: 'Use `systemd-inhibit` on Linux; branch on `uname`.' },
  { cmd: 'say', fix: 'Use `espeak` on Linux; branch on `uname`.' },
  { cmd: 'ditto', fix: 'Use `cp -R` (or `rsync -a`).' },
  { cmd: 'plutil', fix: 'Use `python3 -c "import plistlib"` on Linux.' },
  { cmd: 'mdfind', fix: 'Use `find` or `locate` on Linux.' },
  { cmd: 'diskutil', fix: 'Use `lsblk` / `df` on Linux; branch on `uname`.' },
  { cmd: 'hdiutil', fix: 'macOS only; guard with a `uname` check.' },
  { cmd: 'scutil', fix: 'Use `hostnamectl` on Linux; branch on `uname`.' },
  { cmd: 'softwareupdate', fix: 'macOS only; guard with a `uname` check.' },
  { cmd: 'xcode-select', fix: 'macOS only; guard with a `uname` check.' },
  { cmd: 'xcrun', fix: 'macOS only; guard with a `uname` check.' },
  { cmd: 'codesign', fix: 'macOS only; guard with a `uname` check.' },
  { cmd: 'lipo', fix: 'macOS only; guard with a `uname` check.' },
  { cmd: 'otool', fix: 'Use `ldd` / `readelf` on Linux; branch on `uname`.' },
  { cmd: 'dscl', fix: 'Use `getent` / `useradd` on Linux; branch on `uname`.' },
  { cmd: 'networksetup', fix: 'macOS only; guard with a `uname` check.' },
  { cmd: 'pmset', fix: 'macOS only; guard with a `uname` check.' },
  { cmd: 'screencapture', fix: 'Use `import` or `scrot` on Linux.' },
  { cmd: 'sips', fix: 'Use ImageMagick `convert` on Linux.' },
  { cmd: 'afplay', fix: 'Use `aplay` / `paplay` on Linux.' },
  { cmd: 'md5', fix: 'Use `md5sum` on Linux and `md5 -r` on macOS, or `cksum` for a portable checksum.' },
];

const HOMEBREW_GNU = [
  'gsed',
  'gawk',
  'ggrep',
  'gdate',
  'gtar',
  'gfind',
  'gxargs',
  'gstat',
  'greadlink',
  'gmktemp',
  'gtimeout',
  'gsort',
  'gcut',
  'gcp',
  'gmv',
  'grm',
  'gls',
  'gcat',
  'ghead',
  'gtail',
  'gwc',
  'gdu',
  'gbase64',
  'gmd5sum',
  'gtouch',
  'gchmod',
];

/**
 * @param {Entry} e
 * @param {Platform[]} defaultFails
 * @returns {Rule}
 */
function missing(e, defaultFails) {
  const fails = e.fails ?? defaultFails;
  const where = fails.map((p) => ({ macos: 'macOS', linux: 'Linux', alpine: 'Alpine' })[p]).join(' and ');
  return {
    id: `cmd-${e.cmd}`,
    severity: 'error',
    fails,
    title: `\`${e.cmd}\` is not available on ${where}`,
    why: `\`${e.cmd}\` is not installed by default on ${where}.`,
    fix: e.fix,
    commands: [e.cmd],
    check(_cmd, ctx) {
      if (ctx.probed.has(e.cmd)) return null;
      const here = fails.filter((p) => !ctx.scope || ctx.scope.includes(p));
      const names = here.map((p) => ({ macos: 'macOS', linux: 'Linux', alpine: 'Alpine' })[p]).join(' and ');
      return { message: `\`${e.cmd}\` is not installed by default on ${names}`, fix: e.fix, key: e.cmd };
    },
    probes: [{ presence: e.cmd, good: e.good, expect: e.good ? 'ok' : undefined, skip: e.skip }],
  };
}

/** @type {Rule[]} */
export const commandRules = [
  ...MISSING_ON_MACOS.map((e) => missing(e, ['macos'])),
  ...MISSING_ON_LINUX.map((e) => missing(e, ['linux', 'alpine'])),
  {
    id: 'homebrew-gnu-prefix',
    severity: 'error',
    fails: ['linux', 'alpine'],
    title: 'Homebrew-style `g`-prefixed GNU tools',
    why: 'Names like `gsed`, `gdate` and `gtar` only exist where Homebrew installed GNU coreutils, findutils, sed, grep or tar. They are missing on Linux, Alpine and on a stock Mac.',
    fix: 'Pick the binary once: `if command -v gsed >/dev/null 2>&1; then SED=gsed; else SED=sed; fi`, then call `"$SED"`.',
    commands: HOMEBREW_GNU,
    check(cmd, ctx) {
      if (ctx.probed.has(cmd.name)) return null;
      return { message: `\`${cmd.name}\` only exists where Homebrew's GNU tools are installed`, key: cmd.name };
    },
    probes: [
      {
        presence: 'gsed',
        skip: ['macos'],
        good: 'if command -v gsed >/dev/null 2>&1; then SED=gsed; else SED=sed; fi; echo ok',
        expect: 'ok',
      },
    ],
  },
];
