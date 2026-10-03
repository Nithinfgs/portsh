/** @typedef {import('./index.js').Chunk} Chunk */
/** @typedef {import('../platforms.js').Platform} Platform */

/**
 * Platform implied by a base image name.
 * @param {string} image
 * @returns {Platform[]}
 */
export function platformsOfImage(image) {
  const img = image.toLowerCase();
  if (/alpine|busybox/.test(img)) return ['alpine'];
  if (img.includes('$')) return ['linux', 'alpine']; // ARG-driven base image
  return ['linux'];
}

/**
 * RUN instructions of a Dockerfile, grouped per build stage so each stage keeps
 * the platform of its own `FROM` line.
 *
 * @param {string} text
 * @returns {Chunk[]}
 */
export function extractDockerfile(text) {
  const lines = text.split('\n').map((l) => l.replace(/\r$/, ''));
  /** @type {Map<string, Platform[]>} */
  const stages = new Map();
  /** @type {Platform[]} */
  let targets = ['linux'];
  let dialect = /** @type {Chunk['dialect']} */ ('sh');
  /** @type {Chunk[]} */
  const chunks = [];

  /** @type {string[]} */
  let buf = [];
  /** @type {{line: number, col: number}[]} */
  let map = [];
  const flush = () => {
    if (buf.length) {
      chunks.push({ text: buf.join('\n'), lineMap: map, targets, dialect, interpreter: dialect === 'bash' ? 'bash' : 'sh' });
    }
    buf = [];
    map = [];
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const from = line.match(/^\s*FROM\s+(?:--\S+\s+)*(\S+)(?:\s+AS\s+(\S+))?/i);
    if (from) {
      flush();
      const base = from[1];
      targets = stages.get(base.toLowerCase()) ?? platformsOfImage(base);
      dialect = 'sh';
      if (from[2]) stages.set(from[2].toLowerCase(), targets);
      continue;
    }
    const shell = line.match(/^\s*SHELL\s+\[\s*"([^"]+)"/i);
    if (shell) {
      flush();
      dialect = /bash$/.test(shell[1]) ? 'bash' : 'sh';
      continue;
    }
    const run = line.match(/^(\s*RUN\s+)(.*)$/i);
    if (!run) continue;
    let rest = run[2];
    if (/^\s*\[/.test(rest)) continue; // exec form has no shell
    rest = rest.replace(/^(?:--\S+\s+)+/, (m) => ' '.repeat(m.length));
    const startCol = line.length - rest.length + 1;
    const heredoc = rest.match(/<<-?\s*["']?(\w+)["']?/);
    if (heredoc && /^\s*<</.test(rest)) {
      for (let j = i + 1; j < lines.length; j++) {
        if (lines[j].trim() === heredoc[1]) {
          i = j;
          break;
        }
        buf.push(lines[j]);
        map.push({ line: j + 1, col: 1 });
      }
      continue;
    }
    buf.push(rest);
    map.push({ line: i + 1, col: startCol });
    let cur = rest;
    while (/\\\s*$/.test(cur) && i + 1 < lines.length) {
      i++;
      cur = lines[i];
      if (/^\s*#/.test(cur)) {
        buf.push('');
      } else {
        buf.push(cur);
      }
      map.push({ line: i + 1, col: 1 });
    }
  }
  flush();
  return chunks;
}
