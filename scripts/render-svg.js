// Renders the real output of portsh on examples/demo as docs/assets/demo.svg.
// Nothing is mocked: the SVG is the ANSI output of the CLI converted to text spans.
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const bin = join(root, 'bin', 'portsh.js');

/** @type {string} */
let out;
try {
  out = execFileSync(process.execPath, [bin, 'examples/demo/scripts', 'examples/demo/Dockerfile', '--color'], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, FORCE_COLOR: '1' },
  });
} catch (e) {
  out = /** @type {{stdout: string}} */ (e).stdout; // exit status 1 means "problems found"
}

/** @type {Record<number, string>} */
const COLORS = { 31: '#ff7b72', 32: '#7ee787', 33: '#e3b341', 36: '#79c0ff' };
const esc = (/** @type {string} */ s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** @param {string} line */
function spans(line) {
  let bold = false;
  let dim = false;
  let color = '';
  let text = '';
  /** @type {string[]} */
  const parts = [];
  const flush = () => {
    if (!text) return;
    const style = [color && `fill:${color}`, bold && 'font-weight:700', dim && 'opacity:.6'].filter(Boolean).join(';');
    parts.push(style ? `<tspan style="${style}">${esc(text)}</tspan>` : esc(text));
    text = '';
  };
  const re = /\x1b\[(\d+)m/g;
  let last = 0;
  for (let m = re.exec(line); m; m = re.exec(line)) {
    text += line.slice(last, m.index);
    flush();
    last = re.lastIndex;
    const code = Number(m[1]);
    if (code === 0) {
      bold = false;
      dim = false;
      color = '';
    } else if (code === 1) bold = true;
    else if (code === 2) dim = true;
    else if (COLORS[code]) color = COLORS[code];
  }
  text += line.slice(last);
  flush();
  return parts.join('');
}

const lines = out.replace(/\n+$/, '').split('\n');
const lh = 19;
const pad = 20;
const width = 980;
const height = pad * 2 + 34 + lines.length * lh;
const body = lines.map((l, i) => `<text x="${pad}" y="${pad + 34 + (i + 1) * lh - 5}" xml:space="preserve">${spans(l)}</text>`).join('\n');

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="portsh output: portability problems found in a demo project">
<rect width="${width}" height="${height}" rx="10" fill="#0d1117"/>
<circle cx="${pad + 6}" cy="${pad + 6}" r="6" fill="#ff5f56"/><circle cx="${pad + 26}" cy="${pad + 6}" r="6" fill="#ffbd2e"/><circle cx="${pad + 46}" cy="${pad + 6}" r="6" fill="#27c93f"/>
<text x="${pad + 70}" y="${pad + 10}" fill="#8b949e" font-family="ui-monospace,SFMono-Regular,Menlo,Consolas,monospace" font-size="12">$ npx portsh examples/demo</text>
<g fill="#c9d1d9" font-family="ui-monospace,SFMono-Regular,Menlo,Consolas,'DejaVu Sans Mono',monospace" font-size="13">
${body}
</g>
</svg>
`;
writeFileSync(join(root, 'docs', 'assets', 'demo.svg'), svg);
console.log(`wrote docs/assets/demo.svg (${lines.length} lines, ${svg.length} bytes)`);
