import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { analyzeCondition, parseShebang, parseShell, unwrap } from '../src/parse.js';

const names = (/** @type {string} */ src) => parseShell(src).commands.map((c) => c.name);

describe('parseShell', () => {
  it('splits commands on separators and pipes', () => {
    assert.deepEqual(names('a; b && c || d | e & f\ng'), ['a', 'b', 'c', 'd', 'e', 'f', 'g']);
  });

  it('keeps quoted text inside one argument', () => {
    const [c] = parseShell(`echo 'a b' "c d" e\\ f`).commands;
    assert.deepEqual(c.args, ['a b', 'c d', 'e f']);
  });

  it('skips comments but not # inside words', () => {
    assert.deepEqual(names('echo a#b # nope\n# whole line\nls'), ['echo', 'ls']);
  });

  it('skips here-document bodies, including <<- and quoted delimiters', () => {
    assert.deepEqual(names('cat <<EOF\nrm -rf /\nEOF\nls'), ['cat', 'ls']);
    assert.deepEqual(names("cat <<-'X'\n\trm -rf /\n\tX\nls"), ['cat', 'ls']);
    assert.deepEqual(names('cat <<A <<B\none\nA\ntwo\nB\nls'), ['cat', 'ls']);
  });

  it('descends into $(...) and backticks and process substitution', () => {
    const sorted = (/** @type {string} */ src) => names(src).sort();
    assert.deepEqual(sorted('x=$(date +%s); echo `uname`; diff <(sort a) <(sort b)'), ['date', 'diff', 'echo', 'sort', 'sort', 'uname']);
    assert.deepEqual(sorted('echo "$(a "$(b)")"'), ['a', 'b', 'echo']);
  });

  it('does not run arithmetic as a command', () => {
    assert.deepEqual(names('echo $((1 + (2 * 3)))\n(( i++ ))\nls'), ['echo', 'ls']);
  });

  it('handles control flow keywords', () => {
    const src =
      'if a; then b; elif c; then d; else e; fi\nfor i in 1 2 3; do f; done\nwhile g; do h; done\ncase $x in a) i;; b|c) j;; esac';
    assert.deepEqual(names(src), ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j']);
  });

  it('handles function definitions in both styles', () => {
    assert.deepEqual(names('f() { a; }\nfunction g { b; }\nh'), ['a', 'b', 'h']);
  });

  it('treats [[ ]] as one command and keeps regex operators out of the way', () => {
    const cmds = parseShell('[[ $x =~ ^(a|b)$ && -n $y ]] && echo ok').commands;
    assert.deepEqual(
      cmds.map((c) => c.name),
      ['[[', 'echo'],
    );
  });

  it('ignores variable assignments and array literals', () => {
    assert.deepEqual(names('FOO=1 BAR=2 cmd arg\nx=(1 2 3)\ny+=z'), ['cmd']);
  });

  it('keeps redirections out of the arguments', () => {
    const [c] = parseShell('cmd a >out 2>&1 <in b').commands;
    assert.deepEqual(c.args, ['a', 'b']);
  });

  it('handles line continuations', () => {
    const [c] = parseShell('sed -i \\\n  -e x \\\n  file').commands;
    assert.deepEqual(c.args, ['-i', '-e', 'x', 'file']);
  });

  it('reports line and column', () => {
    const cmds = parseShell('a\n  b c').commands;
    assert.deepEqual([cmds[1].line, cmds[1].col], [2, 3]);
  });

  it('records bash-only operators', () => {
    const cmds = parseShell('a &>> f\nb |& c').commands;
    assert.deepEqual(cmds[0].ops, ['&>>']);
    assert.deepEqual(cmds[1].ops, ['|&']);
  });

  it('survives unbalanced input without hanging', () => {
    for (const src of [
      'echo "unterminated',
      "echo 'x",
      'echo $(',
      'echo ${',
      'if a; then',
      'case x in',
      'cat <<EOF\nnever closed',
      '((',
      '`x',
    ]) {
      assert.doesNotThrow(() => parseShell(src), src);
    }
  });
});

describe('unwrap', () => {
  const inner = (/** @type {string} */ src) =>
    parseShell(src)
      .commands.flatMap((c) => unwrap(c))
      .map((c) => `${c.name} ${c.args.join(' ')}`.trim());

  it('exposes commands run by sudo, env, nice, nohup, time, command', () => {
    assert.deepEqual(inner('sudo -u bob sed -i x f'), ['sed -i x f']);
    assert.deepEqual(inner('env A=1 -i nproc'), ['nproc']);
    assert.deepEqual(inner('nice -n 5 nohup tac f'), ['nohup tac f', 'tac f']);
    assert.deepEqual(inner('command stat -c %s f'), ['stat -c %s f']);
    assert.deepEqual(inner('command -v nproc'), []);
  });

  it('exposes the command run by timeout and xargs', () => {
    assert.deepEqual(inner('timeout -k 5 30 sed -i x f'), ['sed -i x f']);
    assert.deepEqual(inner('xargs -0 -n1 -I{} sed -i x {}'), ['sed -i x {}']);
  });

  it('exposes find -exec and -execdir', () => {
    assert.deepEqual(inner('find . -type f -exec sed -i x {} \\; -o -execdir tac {} +'), ['sed -i x {}', 'tac {}']);
  });

  it('parses sh -c strings and eval', () => {
    assert.deepEqual(inner('sh -c "nproc; tac f"'), ['nproc', 'tac f']);
    assert.deepEqual(inner('bash -ec "sed -i x f"'), ['sed -i x f']);
    assert.deepEqual(inner('eval "nproc"'), ['nproc']);
  });
});

describe('analyzeCondition', () => {
  it('recognises macOS and Linux tests', () => {
    assert.deepEqual(analyzeCondition('[ "$(uname)" = "Darwin" ]'), ['macos']);
    assert.deepEqual(analyzeCondition('[[ "$OSTYPE" == darwin* ]]'), ['macos']);
    assert.deepEqual(analyzeCondition('[ "$(uname -s)" = Linux ]'), ['linux', 'alpine']);
    assert.deepEqual(analyzeCondition('[[ $OSTYPE == linux-gnu* ]]'), ['linux']);
    assert.deepEqual(analyzeCondition('command -v sw_vers >/dev/null'), ['macos']);
  });

  it('understands negation', () => {
    assert.deepEqual(analyzeCondition('[ "$(uname)" != "Darwin" ]'), ['linux', 'alpine']);
  });

  it('returns null for unrelated conditions', () => {
    assert.equal(analyzeCondition('[ -f foo ]'), null);
    assert.equal(analyzeCondition('[ "$CI" = true ]'), null);
  });
});

describe('parseShebang', () => {
  it('reads direct and env shebangs', () => {
    assert.equal(parseShebang('#!/bin/bash\n')?.interpreter, 'bash');
    assert.equal(parseShebang('#!/usr/bin/env bash\n')?.interpreter, 'bash');
    assert.equal(parseShebang('#!/usr/bin/env -S bash -e\n')?.interpreter, 'bash');
    assert.equal(parseShebang('echo hi'), null);
  });
});
