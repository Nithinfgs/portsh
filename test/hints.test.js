import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { platformsFromPath } from '../src/hints.js';
import { lintPaths } from '../src/index.js';

describe('platformsFromPath', () => {
  it('reads a single platform from directory or file names', () => {
    assert.deepEqual(platformsFromPath('plugins/macos/macos.plugin.zsh'), ['macos']);
    assert.deepEqual(platformsFromPath('scripts/install-darwin.sh'), ['macos']);
    assert.deepEqual(platformsFromPath('plugins/archlinux/a.sh'), ['linux']);
    assert.deepEqual(platformsFromPath('ci/ubuntu_setup.sh'), ['linux']);
    assert.deepEqual(platformsFromPath('docker/alpine/build.sh'), ['alpine']);
  });

  it('gives no hint when the path is ambiguous or unrelated', () => {
    assert.equal(platformsFromPath('scripts/build.sh'), null);
    assert.equal(platformsFromPath('docs/macos-and-linux.md'), null);
    assert.equal(platformsFromPath('scripts/macosx-helper.sh'), null);
  });
});

describe('lintPaths targets', () => {
  /** @type {string} */
  let dir;
  before(() => {
    dir = mkdtempSync(join(tmpdir(), 'portsh-hints-'));
    mkdirSync(join(dir, 'macos'));
    mkdirSync(join(dir, 'tools'));
    writeFileSync(join(dir, 'macos', 'setup.sh'), '#!/bin/sh\npbcopy < f\n');
    writeFileSync(join(dir, 'tools', 'copy.sh'), '#!/bin/sh\npbcopy < f\n');
  });
  after(() => rmSync(dir, { recursive: true, force: true }));

  it('narrows files whose path names a platform', () => {
    const report = lintPaths(['.'], { cwd: dir });
    assert.deepEqual(
      report.findings.map((f) => f.file),
      [join('tools', 'copy.sh')],
    );
  });

  it('can turn hints off', () => {
    assert.equal(lintPaths(['.'], { cwd: dir, pathHints: false }).findings.length, 2);
  });

  it('applies config overrides, and explicit targets win over everything', () => {
    const overrides = [{ files: ['tools/**'], targets: /** @type {import('../src/platforms.js').Platform[]} */ (['macos']) }];
    assert.equal(lintPaths(['.'], { cwd: dir, overrides }).findings.length, 0);
    assert.equal(lintPaths(['.'], { cwd: dir, overrides, targets: ['linux'] }).findings.length, 2);
  });
});
