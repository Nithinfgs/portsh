/** @typedef {import('./index.js').Chunk} Chunk */

const SHELL_LANGS = new Set(['sh', 'bash', 'shell', 'zsh', 'console', 'shell-session', 'sh-session', 'terminal']);
const PROMPT_LANGS = new Set(['console', 'shell-session', 'sh-session', 'terminal']);

/**
 * Fenced shell code blocks in Markdown, one chunk per block.
 *
 * @param {string} text
 * @returns {Chunk[]}
 */
export function extractMarkdown(text) {
  const lines = text.split('\n').map((l) => l.replace(/\r$/, ''));
  /** @type {Chunk[]} */
  const chunks = [];
  for (let i = 0; i < lines.length; i++) {
    const open = lines[i].match(/^(\s*)(`{3,}|~{3,})\s*([\w-]*)/);
    if (!open) continue;
    const [, indent, fence, lang] = open;
    const close = new RegExp(`^\\s*${fence[0]}{${fence.length},}\\s*$`);
    let end = i + 1;
    while (end < lines.length && !close.test(lines[end])) end++;
    if (SHELL_LANGS.has(lang.toLowerCase())) {
      const body = lines.slice(i + 1, end);
      const promptOnly = PROMPT_LANGS.has(lang.toLowerCase());
      const nonBlank = body.filter((l) => l.trim());
      const stripPrompt = promptOnly || (nonBlank.length > 0 && nonBlank.every((l) => /^\s*[$#>]\s/.test(l) && /^\s*\$\s/.test(l)));
      /** @type {string[]} */
      const out = [];
      /** @type {{line: number, col: number}[]} */
      const map = [];
      let continued = false;
      body.forEach((raw, k) => {
        let line = raw.startsWith(indent) ? raw.slice(indent.length) : raw;
        let col = indent.length + 1;
        if (stripPrompt) {
          const m = line.match(/^(\s*\$\s)(.*)$/);
          if (m) {
            col += m[1].length;
            line = m[2];
            continued = /\\$/.test(line);
          } else if (continued) {
            continued = /\\$/.test(line);
          } else {
            line = ''; // command output
          }
        }
        out.push(line);
        map.push({ line: i + 2 + k, col });
      });
      if (out.some((l) => l.trim())) {
        chunks.push({ text: out.join('\n'), lineMap: map, targets: null, dialect: 'unknown', interpreter: null, label: lang });
      }
    }
    i = end;
  }
  return chunks;
}
