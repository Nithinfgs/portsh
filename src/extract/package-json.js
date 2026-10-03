/** @typedef {import('./index.js').Chunk} Chunk */

/**
 * Each entry of `scripts` in package.json becomes a one-line chunk.
 * Lifecycle details (pre/post hooks) do not matter here, only the shell text.
 *
 * @param {string} text
 * @returns {Chunk[]}
 */
export function extractPackageJson(text) {
  /** @type {{scripts?: Record<string, unknown>}} */
  let pkg;
  try {
    pkg = JSON.parse(text);
  } catch {
    return [];
  }
  const scripts = pkg.scripts;
  if (!scripts || typeof scripts !== 'object') return [];
  const lines = text.split('\n');
  /** @type {Chunk[]} */
  const chunks = [];
  for (const [name, value] of Object.entries(scripts)) {
    if (typeof value !== 'string' || !value.trim()) continue;
    const encoded = JSON.stringify(value);
    let lineNo = lines.findIndex((l) => l.includes(`${JSON.stringify(name)}:`) && l.includes(encoded));
    let col = 1;
    if (lineNo === -1) {
      lineNo = lines.findIndex((l) => l.includes(`${JSON.stringify(name)}:`));
    } else {
      col = lines[lineNo].indexOf(encoded) + 2;
    }
    const line = Math.max(lineNo, 0) + 1;
    chunks.push({ text: value, lineMap: [{ line, col }], targets: null, dialect: 'sh', interpreter: 'sh', label: name });
  }
  return chunks;
}
