import { analyzeCondition } from '../parse.js';
import { ALL_PLATFORMS, intersect } from '../platforms.js';

/** @typedef {import('./index.js').Chunk} Chunk */
/** @typedef {import('../platforms.js').Platform} Platform */

/**
 * Blank out make variable references and functions so the shell parser does not
 * mistake `$(MAKE)` or `$(shell uname)` for command substitution. Length is preserved.
 * @param {string} line
 */
function neutralizeMake(line) {
  let out = '';
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '$' && line[i + 1] === '$') {
      out += ' $';
      i++;
      continue;
    }
    if (c === '$' && (line[i + 1] === '(' || line[i + 1] === '{')) {
      const open = line[i + 1];
      const close = open === '(' ? ')' : '}';
      let depth = 0;
      let j = i + 1;
      for (; j < line.length; j++) {
        if (line[j] === open) depth++;
        else if (line[j] === close && --depth === 0) break;
      }
      out += 'X'.repeat(Math.max(1, j - i + 1));
      i = j;
      continue;
    }
    if (c === '$' && /[@<^?*%+|]/.test(line[i + 1] ?? '')) {
      out += 'XX';
      i++;
      continue;
    }
    out += c;
  }
  return out;
}

/**
 * Recipe lines (those starting with a tab) of a Makefile as one shell chunk.
 * Make-level conditionals (`ifeq ($(UNAME_S),Darwin)`) become per-line restrictions.
 *
 * @param {string} text
 * @returns {Chunk[]}
 */
export function extractMakefile(text) {
  const lines = text.split('\n');
  /** @type {string[]} */
  const out = [];
  /** @type {(Platform[] | null)[]} */
  const restrictions = [];
  /** @type {{cond: Platform[] | null, taken: Platform[][]}[]} */
  const stack = [];
  let continued = false;

  const current = () => {
    /** @type {Platform[] | null} */
    let r = null;
    for (const f of stack) if (f.cond) r = intersect(r ?? ALL_PLATFORMS, f.cond);
    return r;
  };

  for (const raw of lines) {
    const line = raw.replace(/\r$/, '');
    const trimmed = line.trim();
    const cond = trimmed.match(/^(ifeq|ifneq|ifdef|ifndef)\b(.*)$/);
    if (!continued && cond) {
      let a = analyzeCondition(cond[2], { loose: true });
      if (a && (cond[1] === 'ifneq' || cond[1] === 'ifndef')) a = ALL_PLATFORMS.filter((p) => !(/** @type {Platform[]} */ (a).includes(p)));
      stack.push({ cond: a, taken: a ? [a] : [] });
      out.push('');
      restrictions.push(null);
      continue;
    }
    if (!continued && /^else\b/.test(trimmed) && stack.length) {
      const top = stack[stack.length - 1];
      const elseIf = trimmed.match(/^else\s+(ifeq|ifneq|ifdef|ifndef)\b(.*)$/);
      const taken = top.taken.flat();
      if (elseIf) {
        let a = analyzeCondition(elseIf[2], { loose: true });
        if (a && (elseIf[1] === 'ifneq' || elseIf[1] === 'ifndef'))
          a = ALL_PLATFORMS.filter((p) => !(/** @type {Platform[]} */ (a).includes(p)));
        top.cond = a
          ? intersect(
              ALL_PLATFORMS.filter((p) => !taken.includes(p)),
              a,
            )
          : null;
        if (a) top.taken.push(a);
      } else {
        top.cond = top.taken.length ? ALL_PLATFORMS.filter((p) => !taken.includes(p)) : null;
      }
      out.push('');
      restrictions.push(null);
      continue;
    }
    if (!continued && /^endif\b/.test(trimmed)) {
      stack.pop();
      out.push('');
      restrictions.push(null);
      continue;
    }
    if (line.startsWith('\t') || continued) {
      let body = line.startsWith('\t') ? line.slice(1) : line;
      if (!continued) body = body.replace(/^[@+-]+/, (m) => ' '.repeat(m.length));
      out.push(neutralizeMake(body));
      continued = /\\$/.test(line);
      restrictions.push(current());
      continue;
    }
    out.push('');
    restrictions.push(null);
  }

  // Recipe text was shifted left by one column (the tab) plus any @-+ prefixes.
  const lineMap = out.map((_, i) => ({ line: i + 1, col: 2 }));
  if (!out.some((l) => l.trim())) return [];
  return [{ text: out.join('\n'), lineMap, targets: null, dialect: 'sh', interpreter: 'sh', lineRestrictions: restrictions }];
}
