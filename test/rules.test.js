import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { RULES } from '../src/rules/index.js';
import { ids } from './helpers.js';

/** Snippets run by bash-specific probes need a bash shebang for the dialect check. */
const prefixFor = (/** @type {string | undefined} */ shell) =>
  shell?.includes('bash') ? '#!/bin/bash\n' : shell === 'sh' ? '#!/bin/sh\n' : '';

describe('rule metadata', () => {
  it('has unique ids', () => {
    const seen = new Set();
    for (const r of RULES) {
      assert.ok(!seen.has(r.id), `duplicate rule id ${r.id}`);
      seen.add(r.id);
    }
  });

  it('gives every rule a fix, an explanation and at least one probe', () => {
    for (const r of RULES) {
      assert.ok(r.title && r.why && r.fix, `${r.id} is missing text`);
      assert.ok(r.fails.length > 0, `${r.id} fails nowhere`);
      assert.ok(r.probes.length > 0, `${r.id} has no probe`);
    }
  });
});

// Every probe doubles as a static test: the `bad` snippet must be flagged,
// the recommended `good` replacement must not be.
for (const rule of RULES) {
  describe(`rule ${rule.id}`, () => {
    rule.probes.forEach((probe, i) => {
      const prefix = prefixFor(probe.shell);
      if (probe.bad || probe.presence) {
        it(`flags probe ${i + 1}`, () => {
          const snippet = probe.bad ?? `${probe.presence} arg`;
          assert.ok(ids(prefix + snippet).includes(rule.id), `expected ${rule.id} to flag: ${snippet}`);
        });
      }
      if (probe.good) {
        it(`accepts the fix for probe ${i + 1}`, () => {
          assert.ok(!ids(prefix + probe.good).includes(rule.id), `${rule.id} wrongly flags the fix: ${probe.good}`);
        });
      }
    });
  });
}

describe('false-positive guards', () => {
  it('ignores commands inside strings, comments and heredocs', () => {
    const src = [
      '#!/bin/bash',
      '# sed -i s/a/b/ file',
      'echo "run sed -i s/a/b/ to edit, or grep -P x"',
      "cat <<'EOF'",
      'sed -i s/a/b/ file',
      'nproc',
      'EOF',
      '',
    ].join('\n');
    assert.deepEqual(ids(src), []);
  });

  it('does not flag a command that has a fallback', () => {
    assert.deepEqual(ids('nproc || sysctl -n hw.ncpu'), []);
    assert.deepEqual(ids("sed -i 's/a/b/' f || sed -i '' 's/a/b/' f"), []);
    assert.deepEqual(ids('date -d yesterday +%s || date -v-1d +%s'), []);
  });

  it('still flags `|| true`, which does not make a command portable', () => {
    assert.ok(ids("grep -oP 'x' f || true").includes('grep-perl-regexp'));
  });

  it('does not flag a command the script checks for first', () => {
    assert.deepEqual(ids('if command -v nproc >/dev/null 2>&1; then nproc; fi'), []);
    assert.deepEqual(ids('type timeout >/dev/null && timeout 5 true'), []);
    assert.deepEqual(ids('have() { command -v "$1"; }\nhave timeout && timeout 5 true'), []);
  });

  it('respects platform conditions in if/else', () => {
    const src = [
      'if [[ "$OSTYPE" == "darwin"* ]]; then',
      "  sed -i '' 's/a/b/' f",
      '  stat -f %z f',
      'else',
      "  sed -i 's/a/b/' f",
      '  stat -c %s f',
      'fi',
    ].join('\n');
    assert.deepEqual(ids(src), []);
  });

  it('respects uname case statements', () => {
    const src = ['case "$(uname -s)" in', '  Darwin) stat -f %z f ;;', '  Linux) stat -c %s f ;;', 'esac'].join('\n');
    assert.deepEqual(ids(src), []);
  });

  it('respects `[ platform ] && command` chains', () => {
    assert.deepEqual(ids('[ "$(uname)" = Darwin ] && pbcopy < f'), []);
    assert.deepEqual(ids('[ "$(uname)" = Linux ] && nproc'), []);
    assert.ok(ids('[ "$(uname)" = Linux ] && pbcopy < f').includes('cmd-pbcopy'));
  });

  it('understands variables that hold the OS', () => {
    const src = ['NVM_OS="$(get_os)"', 'case "_${NVM_OS}" in', '  "_darwin") sysctl -n hw.ncpu ;;', '  "_linux") nproc ;;', 'esac'].join(
      '\n',
    );
    assert.deepEqual(ids(src), []);
    assert.deepEqual(ids('if [ "_${OS}" = "_darwin" ]; then sw_vers; fi'), []);
  });

  it('understands GNU/BSD feature detection', () => {
    const src = ['if sed --version 2>/dev/null | grep -q GNU; then', "  sed -i 's/a/b/' f", 'else', "  sed -i '' 's/a/b/' f", 'fi'].join(
      '\n',
    );
    const both = { targets: /** @type {import('../src/platforms.js').Platform[]} */ (['macos', 'linux']) };
    assert.deepEqual(ids(src, both), []);
    assert.deepEqual(ids('if [ "$STAT_TYPE" = gnu ]; then stat -c %Y f; else stat -f %m f; fi', both), []);
  });

  it('skips branches for other operating systems', () => {
    assert.deepEqual(ids('if [[ "$OSTYPE" = freebsd* ]]; then sysctl -n hw.acpi.battery.life; fi'), []);
  });

  it('recognises project helpers that check for a command', () => {
    assert.deepEqual(ids('nvm_has xcode-select && xcode-select -p'), []);
    assert.deepEqual(ids('command_exists timeout && timeout 5 true'), []);
  });

  it('flags the wrong branch of a platform condition', () => {
    const src = ['if [ "$(uname -s)" = "Darwin" ]; then', '  nproc', 'fi'].join('\n');
    assert.ok(ids(src).includes('cmd-nproc'));
  });

  it('finds commands inside xargs, find -exec, sh -c and command substitution', () => {
    assert.ok(ids("find . -name '*.c' -exec sed -i 's/a/b/' {} +").includes('sed-inplace-no-suffix'));
    assert.ok(ids("git ls-files | xargs sed -i 's/a/b/'").includes('sed-inplace-no-suffix'));
    assert.ok(ids('sh -c "grep -oP \'x\' f"').includes('grep-perl-regexp'));
    assert.ok(ids('x=$(date -d yesterday +%s)').includes('date-gnu-flags'));
    assert.ok(ids('echo "`nproc`"').includes('cmd-nproc'));
  });

  it("does not attribute another command's options to xargs", () => {
    assert.deepEqual(ids('xargs grep -d skip foo'), []);
    assert.ok(ids("xargs -d '\\n' rm").includes('xargs-delimiter'));
  });

  it('honours # portsh-ignore comments', () => {
    assert.deepEqual(ids("sed -i 's/a/b/' f # portsh-ignore sed-inplace-no-suffix"), []);
    assert.deepEqual(ids("# portsh-ignore sed-inplace-no-suffix\nsed -i 's/a/b/' f"), []);
    assert.deepEqual(ids("# portsh-ignore-file\nsed -i 's/a/b/' f\nnproc"), []);
    assert.ok(ids("sed -i 's/a/b/' f # portsh-ignore cmd-nproc").includes('sed-inplace-no-suffix'));
  });

  it("treats relative paths as the project's own scripts, system paths as the tool", () => {
    assert.deepEqual(ids('./install --all\nscripts/nproc'), []);
    assert.deepEqual(ids("/usr/bin/sed -i 's/a/b/' f"), ['sed-inplace-no-suffix']);
  });

  it('keeps bash version rules to bash scripts', () => {
    assert.deepEqual(ids('mapfile -t a < f'), []);
    assert.deepEqual(ids('#!/bin/sh\nmapfile -t a < f'), []);
    assert.ok(ids('#!/usr/bin/env bash\nmapfile -t a < f').includes('bash4-mapfile'));
  });

  it('only flags echo -e under sh', () => {
    assert.deepEqual(ids("#!/bin/bash\necho -e 'a\\tb'"), []);
    assert.ok(ids("#!/bin/sh\necho -e 'a\\tb'").includes('sh-echo-escapes'));
  });

  it('understands sed -i forms', () => {
    assert.deepEqual(ids("sed -i.bak 's/a/b/' f"), []);
    assert.deepEqual(ids("sed -i'.bak' 's/a/b/' f"), []);
    assert.ok(ids("sed -i -e 's/a/b/' f").includes('sed-inplace-no-suffix'));
    assert.ok(ids("sed -ni 's/a/b/p' f").includes('sed-inplace-no-suffix'));
    assert.ok(ids("sed -i '' 's/a/b/' f").includes('sed-inplace-empty-suffix'));
    assert.ok(!ids("sed -i '' 's/a/b/' f").includes('sed-inplace-no-suffix'));
  });

  it('does not treat sed arguments that merely contain -i as the flag', () => {
    assert.deepEqual(ids("sed -n '/-i/p' f"), []);
    assert.deepEqual(ids("sed 's/-i/-x/' f"), []);
  });

  it('does not mistake \\s inside a bracket expression for a GNU escape', () => {
    assert.deepEqual(ids("sed 's/[\\s]/_/' f"), []);
    assert.ok(ids("sed 's/\\s\\+/ /' f").includes('sed-gnu-escapes'));
  });

  it('leaves portable sed one-line forms alone', () => {
    assert.deepEqual(ids("sed -e 's/a/b/' -e 'p' f"), []);
    assert.deepEqual(ids("sed '/x/d' f"), []);
    assert.deepEqual(ids("sed -n '2p' f"), []);
    assert.deepEqual(ids("sed 'a\\\ntext' f"), []);
    assert.ok(ids("sed '/x/a text' f").includes('sed-oneline-aic'));
  });

  it('allows ls --color, which works everywhere', () => {
    assert.deepEqual(ids('ls --color=auto'), []);
  });

  it('flags touch -d only for free-form dates', () => {
    assert.deepEqual(ids('touch -d 2020-01-01T00:00:00 f'), []);
    assert.ok(ids("touch -d 'yesterday' f").includes('touch-relative-date'));
  });

  it('flags mktemp -t only when the template has no X placeholders', () => {
    assert.deepEqual(ids('mktemp -t foo.XXXXXX'), []);
    assert.ok(ids('mktemp -t foo').includes('mktemp-t-prefix'));
  });
});

describe('platform scoping', () => {
  it('reports only the platforms that are targets', () => {
    const findings = ids("sed -i 's/a/b/' f", { targets: ['linux'] });
    assert.deepEqual(findings, []);
    assert.deepEqual(ids("sed -i 's/a/b/' f", { targets: ['macos'] }), ['sed-inplace-no-suffix']);
  });

  it('reports the BSD form against Linux targets', () => {
    assert.deepEqual(ids("sed -i '' 's/a/b/' f", { targets: ['macos'] }), []);
    assert.deepEqual(ids("sed -i '' 's/a/b/' f", { targets: ['linux'] }), ['sed-inplace-empty-suffix']);
  });
});
