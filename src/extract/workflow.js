import { ALL_PLATFORMS, platformOfLabel } from '../platforms.js';

/** @typedef {import('./index.js').Chunk} Chunk */
/** @typedef {import('../platforms.js').Platform} Platform */

const indentOf = (/** @type {string} */ l) => l.length - l.trimStart().length;
const isBlank = (/** @type {string} */ l) => l.trim() === '';

/**
 * Items of a YAML flow list `[a, b]` or a block list following `key:` at `from`.
 * @param {string[]} lines
 * @param {number} from index of the `key:` line
 * @returns {string[]}
 */
function listAfter(lines, from) {
  const line = lines[from];
  const inline = line.slice(line.indexOf(':') + 1).trim();
  if (inline.startsWith('[')) {
    return inline
      .replace(/^\[|\]\s*(#.*)?$/g, '')
      .split(',')
      .map((s) => s.trim().replace(/^["']|["']$/g, ''))
      .filter(Boolean);
  }
  if (inline) return [inline.replace(/^["']|["']$/g, '')];
  const keyIndent = indentOf(line);
  /** @type {string[]} */
  const items = [];
  for (let i = from + 1; i < lines.length; i++) {
    const l = lines[i];
    if (isBlank(l)) continue;
    if (indentOf(l) < keyIndent || (indentOf(l) === keyIndent && !l.trimStart().startsWith('- '))) break;
    const m = l.trim().match(/^-\s+(.*)$/);
    if (m) items.push(m[1].trim().replace(/^["']|["']$/g, ''));
  }
  return items;
}

/**
 * Platforms a job runs on, from `runs-on`, `matrix` and `container`.
 * @param {string[]} job lines of the job
 * @returns {Platform[] | null | 'skip'}
 */
function jobTargets(job) {
  const container = job.findIndex((l) => /^\s*container:/.test(l));
  if (container !== -1) {
    const inline = job[container].replace(/^\s*container:\s*/, '').trim();
    let image = inline;
    if (!image) {
      for (let i = container + 1; i < job.length && indentOf(job[i]) > indentOf(job[container]); i++) {
        const m = job[i].match(/^\s*image:\s*(\S+)/);
        if (m) image = m[1];
      }
    }
    if (image && !image.includes('$')) return /alpine|busybox/i.test(image) ? ['alpine'] : ['linux'];
  }
  const idx = job.findIndex((l) => /^\s*runs-on:/.test(l));
  if (idx === -1) return null;
  let labels = listAfter(job, idx);
  if (!labels.length) return null;
  const expr = labels.find((l) => l.includes('${{'));
  if (expr) {
    const m = expr.match(/matrix\.(\w+)/);
    if (!m) return null;
    const key = job.findIndex((l) => new RegExp(`^\\s*${m[1]}:`).test(l));
    if (key === -1) return null;
    labels = listAfter(job, key);
    if (!labels.length) return null;
  }
  /** @type {Set<Platform>} */
  const platforms = new Set();
  let unknown = false;
  let windows = false;
  for (const label of labels) {
    const p = platformOfLabel(label);
    if (p === 'windows') windows = true;
    else if (p) platforms.add(p);
    else if (label !== 'self-hosted') unknown = true;
  }
  if (unknown) return null;
  if (!platforms.size) return windows ? 'skip' : null;
  return [...platforms];
}

/**
 * Platforms selected by a step `if:` such as `runner.os == 'Linux'` or `matrix.os != 'macos-latest'`.
 * @param {string} cond
 * @returns {Platform[] | null}
 */
function osOfCondition(cond) {
  const m = cond.match(/(runner\.os|matrix\.os|matrix\.platform)\s*(==|!=)\s*['"]([^'"]+)['"]/);
  if (!m || /&&|\|\|/.test(cond)) return null;
  const p = platformOfLabel(m[3]);
  if (!p || p === 'windows') return null;
  const set = p === 'linux' ? /** @type {Platform[]} */ (['linux', 'alpine']) : [p];
  return m[2] === '==' ? set : ALL_PLATFORMS.filter((x) => !set.includes(x));
}

/**
 * `run:` steps of a GitHub Actions workflow or composite action, one chunk per step.
 * A purpose-built scanner rather than a YAML parser, so portsh needs no dependency.
 *
 * @param {string} text
 * @returns {Chunk[]}
 */
export function extractWorkflow(text) {
  const lines = text.split('\n').map((l) => l.replace(/\r$/, ''));
  // job boundaries: keys one level under `jobs:`
  const jobsAt = lines.findIndex((l) => /^jobs:\s*$/.test(l));
  /** @type {{start: number, end: number}[]} */
  const jobs = [];
  if (jobsAt !== -1) {
    let jobIndent = -1;
    for (let i = jobsAt + 1; i < lines.length; i++) {
      const l = lines[i];
      if (isBlank(l) || l.trimStart().startsWith('#')) continue;
      if (indentOf(l) === 0) break;
      if (jobIndent === -1) jobIndent = indentOf(l);
      if (indentOf(l) === jobIndent && /^\s*[\w-]+:\s*$/.test(l)) {
        if (jobs.length) jobs[jobs.length - 1].end = i;
        jobs.push({ start: i, end: lines.length });
      }
    }
  }

  /** @type {Chunk[]} */
  const chunks = [];
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^(\s*)(-\s+)?run:\s*(.*)$/);
    if (!m) continue;
    const keyIndent = m[1].length + (m[2] ? m[2].length : 0);
    let value = m[3];
    const valueCol = lines[i].length - value.length + 1;

    // context
    const job = jobs.find((j) => i >= j.start && i < j.end);
    const targets = job ? jobTargets(lines.slice(job.start, job.end)) : null;
    if (targets === 'skip') continue;
    const stepStart = (() => {
      for (let k = i; k >= 0; k--) {
        if (/^\s*-\s/.test(lines[k]) && indentOf(lines[k]) === keyIndent - 2) return k;
        if (k !== i && !isBlank(lines[k]) && indentOf(lines[k]) < keyIndent - 2) break;
      }
      return i;
    })();
    let stepEnd = i + 1;
    while (stepEnd < lines.length && (isBlank(lines[stepEnd]) || indentOf(lines[stepEnd]) >= keyIndent)) stepEnd++;
    const shellKey = lines
      .slice(stepStart, stepEnd)
      .map((l) => l.match(/^\s*(?:-\s+)?shell:\s*(\S+)/))
      .find(Boolean);
    const shell = shellKey ? shellKey[1].replace(/["']/g, '') : null;
    if (shell && !/^(bash|sh)(\s|$)/.test(shell)) continue; // pwsh, python, cmd...
    const dialect = shell === 'sh' ? 'sh' : 'unknown';
    const cond = lines
      .slice(stepStart, stepEnd)
      .map((l) => l.match(/^\s*(?:-\s+)?if:\s*(.+)$/))
      .find(Boolean);
    const stepOs = cond ? osOfCondition(cond[1]) : null;
    let stepTargets = targets ?? null;
    if (stepOs) {
      stepTargets = stepTargets ? stepTargets.filter((p) => stepOs.includes(p)) : stepOs;
      if (!stepTargets.length) continue;
    }

    /** @type {string[]} */
    const body = [];
    /** @type {{line: number, col: number}[]} */
    const map = [];
    const block = value.match(/^([|>])[+-]?\d*\s*(#.*)?$/);
    if (block) {
      const folded = block[1] === '>';
      let indent = -1;
      let j = i + 1;
      for (; j < lines.length; j++) {
        const l = lines[j];
        if (isBlank(l)) {
          body.push('');
          map.push({ line: j + 1, col: 1 });
          continue;
        }
        if (indent === -1) indent = indentOf(l);
        if (indentOf(l) < Math.max(indent, keyIndent + 1)) break;
        if (folded && body.length && body[body.length - 1] !== '') {
          body[body.length - 1] += ` ${l.slice(indent)}`;
          map.push({ line: j + 1, col: indent + 1 });
          body.push('');
          continue;
        }
        body.push(l.slice(indent));
        map.push({ line: j + 1, col: indent + 1 });
      }
      i = j - 1;
    } else {
      let col = valueCol;
      if (/^"/.test(value) && /"\s*(#.*)?$/.test(value) && value.length > 1) {
        value = value
          .replace(/\s*#.*$/, '')
          .slice(1, -1)
          .replace(/\\"/g, '"')
          .replace(/\\\\/g, '\\');
        col += 1;
      } else if (/^'/.test(value) && /'\s*(#.*)?$/.test(value) && value.length > 1) {
        value = value
          .replace(/\s*#.*$/, '')
          .slice(1, -1)
          .replace(/''/g, "'");
        col += 1;
      }
      body.push(value);
      map.push({ line: i + 1, col });
    }
    const joined = body.join('\n').replace(/\$\{\{[\s\S]*?\}\}/g, (e) => e.replace(/[^\n]/g, 'X'));
    if (!joined.trim()) continue;
    chunks.push({ text: joined, lineMap: map, targets: stepTargets, dialect, interpreter: dialect === 'sh' ? 'sh' : null });
  }
  return chunks;
}
