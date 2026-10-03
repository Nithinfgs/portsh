import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const BIN = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'portsh.js');

/** @param {string[]} args @param {{cwd?: string, input?: string}} [opts] */
function portsh(args, opts = {}) {
  const r = spawnSync(process.execPath, [BIN, ...args], {
    encoding: 'utf8',
    cwd: opts.cwd,
    input: opts.input,
    env: { ...process.env, NO_COLOR: '1', FORCE_COLOR: '' },
  });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

describe('cli', () => {
  /** @type {string} */
  let dir;
  before(() => {
    dir = mkdtempSync(join(tmpdir(), 'portsh-cli-'));
    mkdirSync(join(dir, 'scripts'));
    writeFileSync(join(dir, 'scripts', 'bad.sh'), "#!/bin/bash\nsed -i 's/a/b/' f\nnproc\n");
    writeFileSync(join(dir, 'scripts', 'good.sh'), '#!/bin/sh\nsed -i.bak "s/a/b/" f\n');
    writeFileSync(join(dir, 'README.md'), '# hi\n');
  });
  after(() => rmSync(dir, { recursive: true, force: true }));

  it('exits 1 and explains each problem', () => {
    const r = portsh(['scripts'], { cwd: dir });
    assert.equal(r.code, 1);
    assert.match(r.out, /scripts\/bad\.sh:2:1/);
    assert.match(r.out, /sed-inplace-no-suffix/);
    assert.match(r.out, /breaks on macOS/);
    assert.match(r.out, /fix:/);
    assert.match(r.out, /2 problems in 1 of 2 files/);
    assert.match(r.out, /✓ Linux\s+clean/);
  });

  it('exits 0 on a clean file', () => {
    const r = portsh(['scripts/good.sh'], { cwd: dir });
    assert.equal(r.code, 0);
    assert.match(r.out, /No portability problems found in 1 file/);
  });

  it('prints JSON', () => {
    const r = portsh(['scripts', '--format', 'json'], { cwd: dir });
    const report = JSON.parse(r.out);
    assert.equal(report.findings.length, 2);
    assert.deepEqual(report.targets, ['macos', 'linux']);
    assert.equal(report.findings[0].file, join('scripts', 'bad.sh'));
  });

  it('prints SARIF and GitHub annotations', () => {
    const sarif = JSON.parse(portsh(['scripts', '-f', 'sarif'], { cwd: dir }).out);
    assert.equal(sarif.version, '2.1.0');
    assert.equal(sarif.runs[0].results.length, 2);
    const gh = portsh(['scripts', '-f', 'github'], { cwd: dir }).out;
    assert.match(gh, /^::error file=scripts\/bad\.sh,line=2,col=1,title=sed-inplace-no-suffix/m);
  });

  it('respects --targets and --disable', () => {
    assert.equal(portsh(['scripts', '--targets', 'linux'], { cwd: dir }).code, 0);
    const r = portsh(['scripts', '--disable', 'sed-inplace-no-suffix,cmd-nproc'], { cwd: dir });
    assert.equal(r.code, 0);
  });

  it('respects --fail-on', () => {
    writeFileSync(join(dir, 'warn.sh'), '#!/bin/bash\nmapfile -t a < f\n');
    assert.equal(portsh(['warn.sh'], { cwd: dir }).code, 0);
    assert.equal(portsh(['warn.sh', '--fail-on', 'warn'], { cwd: dir }).code, 1);
    assert.equal(portsh(['scripts', '--fail-on', 'none'], { cwd: dir }).code, 0);
  });

  it('reads stdin', () => {
    const r = portsh(['--stdin', '--stdin-filename', 'Makefile', '--format', 'json'], { input: 't:\n\trm --force x\n' });
    assert.equal(r.code, 1);
    assert.equal(JSON.parse(r.out).findings[0].ruleId, 'gnu-long-options');
  });

  it('reads .portshrc.json', () => {
    writeFileSync(join(dir, '.portshrc.json'), JSON.stringify({ targets: ['linux'] }));
    try {
      assert.equal(portsh(['scripts'], { cwd: dir }).code, 0);
      writeFileSync(join(dir, '.portshrc.json'), JSON.stringify({ disable: ['cmd-nproc'], exclude: ['scripts/bad.sh'] }));
      assert.equal(portsh(['scripts'], { cwd: dir }).code, 0);
    } finally {
      rmSync(join(dir, '.portshrc.json'));
    }
  });

  it('lists and explains rules', () => {
    const list = portsh(['rules']);
    assert.equal(list.code, 0);
    assert.match(list.out, /sed-inplace-no-suffix/);
    const one = portsh(['explain', 'grep-perl-regexp']);
    assert.equal(one.code, 0);
    assert.match(one.out, /Breaks:/);
    assert.match(one.out, /Portable:/);
  });

  it('reports usage errors with exit 2', () => {
    assert.equal(portsh(['--nope']).code, 2);
    assert.equal(portsh(['--targets', 'windows', 'scripts'], { cwd: dir }).code, 2);
    assert.equal(portsh(['no-such-dir'], { cwd: dir }).code, 2);
    assert.equal(portsh(['explain', 'nope']).code, 2);
    assert.equal(portsh(['--disable', 'nope', 'scripts'], { cwd: dir }).code, 2);
  });

  it('prints help and version', () => {
    assert.match(portsh(['--help']).out, /Usage/);
    assert.match(portsh(['--version']).out, /^\d+\.\d+\.\d+/);
  });
});
