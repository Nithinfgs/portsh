import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { lintText } from '../src/engine.js';
import { extract } from '../src/extract/index.js';

/** @param {string} text @param {import('../src/extract/index.js').FileKind} kind @param {import('../src/platforms.js').Platform[]} [targets] */
const run = (text, kind, targets = ['macos', 'linux']) => lintText(text, { file: `f.${kind}`, kind, targets });

describe('GitHub workflows', () => {
  const wf = (/** @type {string} */ runsOn, /** @type {string} */ step, /** @type {string} */ extra = '') =>
    `name: ci\njobs:\n  build:\n    runs-on: ${runsOn}\n${extra}    steps:\n      - uses: actions/checkout@v4\n${step}`;

  it('maps a run block back to the right file line and column', () => {
    const text = wf('macos-latest', '      - run: |\n          echo hi\n          nproc\n');
    const [f] = run(text, 'workflow');
    assert.equal(f.ruleId, 'cmd-nproc');
    assert.equal(f.line, 9);
    assert.equal(f.col, 11);
  });

  it('uses the runner OS: ubuntu-only jobs are not checked for macOS problems', () => {
    assert.deepEqual(run(wf('ubuntu-latest', '      - run: nproc\n'), 'workflow'), []);
    assert.equal(run(wf('macos-14', '      - run: nproc\n'), 'workflow').length, 1);
  });

  it('expands matrix.os', () => {
    const text = wf(
      '${{ matrix.os }}',
      '      - run: nproc\n',
      '    strategy:\n      matrix:\n        os: [ubuntu-latest, macos-latest]\n',
    );
    assert.equal(run(text, 'workflow').length, 1);
    const block = wf('${{ matrix.os }}', '      - run: nproc\n', '    strategy:\n      matrix:\n        os:\n          - ubuntu-latest\n');
    assert.deepEqual(run(block, 'workflow'), []);
  });

  it('honours step conditions on runner.os', () => {
    const text = wf(
      '${{ matrix.os }}',
      "      - if: runner.os == 'Linux'\n        run: free -m\n",
      '    strategy:\n      matrix:\n        os: [ubuntu-latest, macos-latest]\n',
    );
    assert.deepEqual(run(text, 'workflow'), []);
  });

  it('uses container images and skips Windows and non-shell steps', () => {
    const alpine = wf('ubuntu-latest', '      - run: apt-get update\n', '    container: alpine:3.20\n');
    assert.equal(run(alpine, 'workflow')[0]?.fails.join(), 'alpine');
    assert.deepEqual(run(wf('windows-latest', '      - run: nproc\n'), 'workflow'), []);
    assert.deepEqual(run(wf('macos-latest', '      - shell: pwsh\n        run: nproc\n'), 'workflow'), []);
  });

  it('masks ${{ }} expressions so they are not parsed as shell', () => {
    const text = wf('macos-latest', '      - run: echo "${{ github.sha }} $(( 1 + 2 ))"\n');
    assert.deepEqual(run(text, 'workflow'), []);
  });

  it('handles quoted single-line run values', () => {
    const [f] = run(wf('macos-latest', '      - run: "nproc"\n'), 'workflow');
    assert.equal(f.col, 15);
  });

  it('applies to composite actions without runs-on', () => {
    const text = 'runs:\n  using: composite\n  steps:\n    - run: nproc\n      shell: bash\n';
    assert.equal(run(text, 'workflow').length, 1);
  });

  it('handles folded block scalars', () => {
    const text = wf('macos-latest', '      - run: >\n          sed -i\n          "s/a/b/" f\n');
    assert.equal(run(text, 'workflow').length, 1);
  });
});

describe('Dockerfiles', () => {
  it('checks against Alpine for FROM alpine and Linux otherwise', () => {
    const alpine = run('FROM alpine:3.20\nRUN grep -oP x f\n', 'dockerfile');
    assert.equal(alpine[0].fails.join(), 'alpine');
    assert.deepEqual(run('FROM ubuntu:24.04\nRUN grep -oP x f\n', 'dockerfile'), []);
    assert.deepEqual(run('FROM node:22-slim\nRUN nproc\n', 'dockerfile'), []);
    assert.equal(run('FROM node:22-alpine\nRUN apt-get update\n', 'dockerfile').length, 1);
  });

  it('never reports macOS problems for a Dockerfile', () => {
    assert.deepEqual(run("FROM ubuntu\nRUN sed -i 's/a/b/' f && stat -c %s f\n", 'dockerfile'), []);
  });

  it('tracks multi-stage builds', () => {
    const text = 'FROM alpine AS build\nRUN apt-get update\nFROM ubuntu AS final\nRUN apt-get update\nFROM build\nRUN apt-get update\n';
    assert.deepEqual(
      run(text, 'dockerfile').map((f) => f.line),
      [2, 6],
    );
  });

  it('follows line continuations and reports the right line', () => {
    const [f] = run('FROM alpine\nRUN echo a \\\n && grep -P x f\n', 'dockerfile');
    assert.equal(f.line, 3);
  });

  it('ignores exec-form RUN', () => {
    assert.deepEqual(run('FROM alpine\nRUN ["grep", "-P", "x"]\n', 'dockerfile'), []);
  });

  it('treats RUN as POSIX sh', () => {
    assert.equal(run("FROM ubuntu\nRUN echo -e 'a\\tb'\n", 'dockerfile').length, 1);
  });
});

describe('Makefiles', () => {
  it('lints recipe lines only, with $(VAR) neutralised', () => {
    const text = 'CC := $(shell nproc)\nbuild:\n\t$(CC) --force x\n\t@cp --force a b\n';
    const found = run(text, 'makefile');
    assert.deepEqual(
      found.map((f) => f.line),
      [4],
    );
  });

  it('keeps recipe prefixes and $$ in the right columns', () => {
    const [f] = run('t:\n\t@-echo $$HOME; nproc\n', 'makefile');
    assert.equal(f.line, 2);
    assert.equal(f.col, 17);
  });

  it('understands ifeq on uname', () => {
    const text = 'UNAME_S := $(shell uname -s)\nifeq ($(UNAME_S),Darwin)\nt:\n\tpbcopy < f\nelse\n\tnproc\nendif\n';
    assert.deepEqual(run(text, 'makefile'), []);
    const wrong = 'UNAME_S := $(shell uname -s)\nifeq ($(UNAME_S),Darwin)\nt:\n\tnproc\nendif\n';
    assert.equal(run(wrong, 'makefile').length, 1);
  });

  it('joins continued recipe lines', () => {
    const [f] = run('t:\n\tcp a b && \\\n\tnproc\n', 'makefile');
    assert.equal(f.line, 3);
  });
});

describe('Markdown', () => {
  it('lints sh and bash fences only', () => {
    const md = '# T\n\n```sh\nrm --force x\n```\n\n```js\nrm --force x\n```\n\n```bash\ngrep -oP x f\n```\n';
    assert.deepEqual(
      run(md, 'markdown').map((f) => f.line),
      [4, 12],
    );
  });

  it('strips $ prompts and ignores console output', () => {
    const md = '```console\n$ rm --force x\nok\n$ ls\n```\n';
    const found = run(md, 'markdown');
    assert.equal(found.length, 1);
    assert.equal(found[0].line, 2);
    assert.equal(found[0].col, 3);
  });

  it('handles indented fences and ~~~', () => {
    const md = '- item\n\n  ~~~sh\n  rm --force x\n  ~~~\n';
    const [f] = run(md, 'markdown');
    assert.equal(f.line, 4);
    assert.equal(f.col, 3);
  });

  it('does not report missing-command rules in prose docs', () => {
    assert.deepEqual(run('```sh\nsudo apt-get install shellcheck\nnproc\n```\n', 'markdown'), []);
  });
});

describe('package.json', () => {
  it('lints scripts and reports the script line', () => {
    const pkg = '{\n  "name": "x",\n  "scripts": {\n    "a": "echo ok",\n    "b": "rm --force dist"\n  }\n}\n';
    const [f] = run(pkg, 'package');
    assert.equal(f.line, 5);
    assert.equal(f.col, 11);
  });

  it('ignores invalid JSON and missing scripts', () => {
    assert.deepEqual(run('{ nope', 'package'), []);
    assert.deepEqual(run('{"name": "x"}', 'package'), []);
  });
});

describe('scripts', () => {
  it('skips scripts for other interpreters', () => {
    assert.deepEqual(extract('script', '#!/usr/bin/env python3\nprint(1)\n', 'x'), []);
    assert.deepEqual(run('#!/usr/bin/env node\nnproc\n', 'script'), []);
  });
});
