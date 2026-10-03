/**
 * `portsh verify`: run every rule's probe on THIS machine and compare reality with the rule.
 *
 * A rule claims "this breaks on macOS". Verification actually runs the snippet and checks:
 *   - on platforms the rule lists, the `bad` snippet fails or prints the wrong thing;
 *   - on every other platform, it works;
 *   - the recommended `good` snippet works everywhere.
 *
 * Probes are small and run in a temporary directory.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RULES } from './rules/index.js';

/** @typedef {import('./platforms.js').Platform} Platform */

/**
 * @typedef {object} ProbeResult
 * @property {string} ruleId
 * @property {string} what
 * @property {'pass' | 'fail' | 'skip'} status
 * @property {string} detail
 */

/**
 * @param {string} shell
 * @param {string} setup
 * @param {string} code
 */
function run(shell, setup, code) {
  const dir = mkdtempSync(join(tmpdir(), 'portsh-verify-'));
  try {
    if (setup) spawnSync('sh', ['-c', setup], { cwd: dir, encoding: 'utf8', timeout: 10_000 });
    const r = spawnSync(shell, ['-c', code], {
      cwd: dir,
      encoding: 'utf8',
      timeout: 10_000,
      env: { ...process.env, TZ: 'UTC', LC_ALL: 'C' },
    });
    return { status: r.status ?? -1, stdout: (r.stdout ?? '').trim(), stderr: (r.stderr ?? '').trim(), error: r.error };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * @param {Platform} host
 * @param {{rule?: string}} [opts]
 * @returns {ProbeResult[]}
 */
export function verify(host, opts = {}) {
  /** @type {ProbeResult[]} */
  const results = [];
  for (const rule of RULES) {
    if (opts.rule && rule.id !== opts.rule) continue;
    for (const probe of rule.probes) {
      const what = probe.presence ? `command -v ${probe.presence}` : (probe.bad ?? probe.good ?? '').split('\n')[0].slice(0, 70);
      if (probe.skip?.includes(host)) {
        results.push({ ruleId: rule.id, what, status: 'skip', detail: `not meaningful on ${host}` });
        continue;
      }
      const shell = probe.shell ?? 'sh';
      if (shell.startsWith('/') && !existsSync(shell)) {
        results.push({ ruleId: rule.id, what, status: 'skip', detail: `${shell} is not installed here` });
        continue;
      }
      const shouldFail = (probe.fails ?? rule.fails).includes(host);

      if (probe.presence) {
        const r = run('sh', '', `command -v ${probe.presence}`);
        const present = r.status === 0;
        if (present === !shouldFail) {
          results.push({ ruleId: rule.id, what, status: 'pass', detail: present ? 'present, as expected' : 'missing, as expected' });
        } else {
          results.push({
            ruleId: rule.id,
            what,
            status: 'fail',
            detail: shouldFail
              ? `rule says ${probe.presence} is missing on ${host}, but it exists here`
              : `rule says ${probe.presence} exists on ${host}, but it is missing here`,
          });
        }
      } else if (probe.bad !== undefined) {
        const r = run(shell, probe.setup ?? '', probe.bad);
        const works = r.status === 0 && (probe.expect === undefined || r.stdout === probe.expect);
        if (works === !shouldFail) {
          results.push({ ruleId: rule.id, what, status: 'pass', detail: works ? 'works, as expected' : 'breaks, as expected' });
        } else {
          const got =
            r.status !== 0 ? `exit ${r.status}${r.stderr ? `: ${r.stderr.split('\n')[0]}` : ''}` : `printed ${JSON.stringify(r.stdout)}`;
          results.push({
            ruleId: rule.id,
            what,
            status: 'fail',
            detail: shouldFail
              ? `rule says this breaks on ${host}, but it worked here (${got})`
              : `rule says this works on ${host}, but it broke (${got})`,
          });
        }
      }

      if (probe.good !== undefined) {
        const r = run(shell, probe.setup ?? '', probe.good);
        const works = r.status === 0 && (probe.expect === undefined || r.stdout === probe.expect);
        results.push({
          ruleId: rule.id,
          what: `fix: ${probe.good.split('\n')[0].slice(0, 64)}`,
          status: works ? 'pass' : 'fail',
          detail: works
            ? 'recommended replacement works'
            : `recommended replacement failed on ${host}: exit ${r.status}${r.stderr ? `, ${r.stderr.split('\n')[0]}` : ''}${r.stdout ? `, printed ${JSON.stringify(r.stdout)}` : ''}`,
        });
      }
    }
  }
  return results;
}
