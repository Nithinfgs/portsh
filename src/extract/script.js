import { parseShebang } from '../parse.js';

/** @typedef {import('./index.js').Chunk} Chunk */

/**
 * @param {string | null | undefined} interpreter
 * @returns {Chunk['dialect']}
 */
export function dialectOf(interpreter) {
  if (!interpreter) return 'unknown';
  if (interpreter === 'bash') return 'bash';
  if (interpreter === 'sh' || interpreter === 'dash' || interpreter === 'ash') return 'sh';
  if (interpreter === 'zsh') return 'zsh';
  return 'other';
}

/**
 * A whole shell script is one chunk.
 * @param {string} text
 * @param {string} file
 * @returns {Chunk[]}
 */
export function extractScript(text, file) {
  const shebang = parseShebang(text);
  let interpreter = shebang?.interpreter ?? null;
  if (!interpreter) {
    if (file.endsWith('.bash')) interpreter = 'bash';
    else if (file.endsWith('.zsh')) interpreter = 'zsh';
  }
  const dialect = dialectOf(interpreter);
  if (dialect === 'other' && interpreter && !/^(ksh|mksh|busybox)$/.test(interpreter)) return []; // python, node, perl...
  const lineMap = text.split('\n').map((_, i) => ({ line: i + 1, col: 1 }));
  return [{ text, lineMap, targets: null, dialect, interpreter }];
}
