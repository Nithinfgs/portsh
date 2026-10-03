/**
 * A small, forgiving shell parser.
 *
 * It is not a full POSIX/bash grammar. It extracts the *simple commands* of a
 * script (name, arguments, position) while correctly skipping comments, quoted
 * strings, here-documents and arithmetic, descending into `$(...)`, backticks,
 * `<(...)`, and tracking platform conditions such as
 * `if [ "$(uname)" = Darwin ]` or `case "$OSTYPE" in linux*)`.
 */

import { ALL_PLATFORMS, intersect } from './platforms.js';

/** @typedef {import('./platforms.js').Platform} Platform */

/**
 * @typedef {object} Word
 * @property {string} text   value with quotes removed
 * @property {string} raw    source text
 * @property {boolean} quoted  any part of the word was quoted
 * @property {number} start  offset in the source
 */

/**
 * @typedef {object} Command
 * @property {string} name        basename of the command word
 * @property {Word[]} words       command word first
 * @property {string[]} args      argument texts (without the command word)
 * @property {number} line        1-based
 * @property {number} col         1-based
 * @property {Platform[] | null} restriction  platforms the surrounding condition limits this to
 * @property {boolean} fallback   followed by `|| alternative`
 * @property {string[]} ops       bash-only operators attached to this command (`&>>`, `|&`)
 * @property {string | null} via  wrapper that runs this command (xargs, find -exec, sh -c ...)
 */

/**
 * @typedef {object} ParseResult
 * @property {Command[]} commands
 * @property {{line: number, text: string}[]} comments
 * @property {{interpreter: string, raw: string} | null} shebang
 */

const OPERATOR_START = new Set([';', '&', '|', '(', ')', '<', '>']);
const KEYWORD_RESET = new Set(['then', 'else', 'elif', 'do', '{', '!', 'time', 'if', 'while', 'until']);
const ERROR_HANDLERS = new Set([
  'true',
  ':',
  'false',
  'exit',
  'return',
  'echo',
  'printf',
  'die',
  'fail',
  'error',
  'fatal',
  'warn',
  'log',
  'abort',
]);

/**
 * @param {string} src
 * @param {{fixedPos?: {line: number, col: number}}} [opts]
 * @returns {ParseResult}
 */
export function parseShell(src, opts = {}) {
  const lineStarts = [0];
  for (let i = 0; i < src.length; i++) if (src.charCodeAt(i) === 10) lineStarts.push(i + 1);
  /** @type {Ctx} */
  const ctx = {
    src,
    lineStarts,
    commands: [],
    comments: [],
    fixedPos: opts.fixedPos ?? null,
    depth: 0,
  };
  const p = new Parser(ctx, 0, src.length, false, null);
  p.parse();
  return { commands: ctx.commands, comments: ctx.comments, shebang: parseShebang(src) };
}

/**
 * @typedef {{t: 'eof'} | {t: 'nl'} | {t: 'op', v: string, start: number} | {t: 'redir', v: string} | {t: 'word', w: Word}} Token
 */

/**
 * @typedef {object} Ctx
 * @property {string} src
 * @property {number[]} lineStarts
 * @property {Command[]} commands
 * @property {{line: number, text: string}[]} comments
 * @property {{line: number, col: number} | null} fixedPos
 * @property {number} depth
 */

/** @param {string} src */
export function parseShebang(src) {
  if (!src.startsWith('#!')) return null;
  const first = src.split('\n', 1)[0].slice(2).trim();
  const parts = first.split(/\s+/);
  let prog = parts[0] ?? '';
  if (/(^|\/)env$/.test(prog)) {
    const next = parts.slice(1).find((x) => !x.startsWith('-') && !x.includes('='));
    prog = next ?? '';
  }
  const interpreter = prog.split('/').pop() ?? '';
  return { interpreter, raw: first };
}

class Parser {
  /**
   * @param {Ctx} ctx
   * @param {number} start
   * @param {number} end
   * @param {boolean} closeParen stop at the matching `)`
   * @param {Platform[] | null} restriction
   */
  constructor(ctx, start, end, closeParen, restriction) {
    this.ctx = ctx;
    this.src = ctx.src;
    this.i = start;
    this.end = end;
    this.closeParen = closeParen;
    this.baseRestriction = restriction;
    /** @type {Word[]} */
    this.words = [];
    /** @type {string[]} */
    this.assigns = [];
    /** @type {string[]} */
    this.ops = [];
    this.cmdStart = true;
    this.expectTarget = false;
    this.pendingFd = false;
    this.inDbl = false;
    this.mode = 'cmd'; // cmd | casehead | casepat | forhead | forwords | funcname
    /** @type {Frame[]} */
    this.frames = [];
    /** @type {{delim: string, strip: boolean, quoted: boolean}[]} */
    this.heredocs = [];
    this.heredocTarget = null;
    /** @type {Platform[] | null | undefined} */
    this.chainRestriction = undefined;
    /** @type {Platform[] | null} */
    this.pendingTest = null;
    this.chainStart = ctx.commands.length;
    /** @type {Command[]} */
    this.pendingFallback = [];
    this.altMode = false;
    this.wordStart = 0;
  }

  // ---- positions -------------------------------------------------------

  /** @param {number} offset */
  pos(offset) {
    if (this.ctx.fixedPos) return this.ctx.fixedPos;
    const ls = this.ctx.lineStarts;
    let lo = 0;
    let hi = ls.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (ls[mid] <= offset) lo = mid;
      else hi = mid - 1;
    }
    return { line: lo + 1, col: offset - ls[lo] + 1 };
  }

  currentRestriction() {
    if (this.chainRestriction !== undefined) return this.chainRestriction;
    const top = this.frames[this.frames.length - 1];
    if (top && top.restriction !== undefined) return top.restriction;
    return this.baseRestriction;
  }

  // ---- main loop -------------------------------------------------------

  parse() {
    for (;;) {
      const tok = this.next();
      if (tok.t === 'eof') {
        this.finishCommand();
        return this.i;
      }
      if (tok.t === 'nl') {
        this.finishCommand();
        this.endChain();
        if (this.mode === 'forwords' || this.mode === 'forhead') this.mode = 'cmd';
        if (this.mode === 'cmd') this.cmdStart = true;
        continue;
      }
      if (tok.t === 'op') {
        const done = this.handleOp(tok.v, tok.start);
        if (done) return this.i;
        continue;
      }
      if (tok.t === 'redir') {
        this.expectTarget = true;
        this.heredocTarget = tok.v === '<<' || tok.v === '<<-' ? { strip: tok.v === '<<-' } : null;
        if (tok.v === '&>>') this.ops.push('&>>');
        continue;
      }
      this.handleWord(tok.w);
    }
  }

  /**
   * @param {string} v
   * @param {number} start
   * @returns {boolean} true when the parser should return
   */
  handleOp(v, start) {
    if (this.mode === 'casepat') {
      if (v === ')') {
        this.applyCasePattern();
        this.mode = 'cmd';
        this.cmdStart = true;
      }
      return false;
    }
    switch (v) {
      case ';':
        this.finishCommand();
        this.endChain();
        if (this.mode === 'forwords' || this.mode === 'forhead') this.mode = 'cmd';
        this.cmdStart = true;
        return false;
      case ';;':
      case ';&':
      case ';;&': {
        this.finishCommand();
        this.endChain();
        const top = this.topFrame('case');
        if (top) {
          top.restriction = undefined;
          this.mode = 'casepat';
          top.patterns = [];
        }
        return false;
      }
      case '&':
        this.finishCommand();
        this.endChain();
        this.cmdStart = true;
        return false;
      case '&&':
      case '||':
        this.finishCommand();
        this.chainOp(v);
        this.cmdStart = true;
        return false;
      case '|':
      case '|&': {
        const last = this.ctx.commands[this.ctx.commands.length - 1];
        this.finishCommand();
        if (v === '|&') {
          const emitted = this.ctx.commands[this.ctx.commands.length - 1];
          if (emitted && emitted !== last) emitted.ops.push('|&');
        }
        this.cmdStart = true;
        return false;
      }
      case '(': {
        if (this.words.length === 1 && this.peekNonSpace() === ')') {
          // function definition: name() { ... }
          this.skipTo(')');
          this.words = [];
          this.cmdStart = true;
          return false;
        }
        if (this.src[this.i] === '(') {
          this.skipArithmetic();
          return false;
        }
        this.finishCommand();
        this.frames.push({ kind: 'sub', restriction: this.currentRestriction() });
        this.cmdStart = true;
        return false;
      }
      case ')': {
        this.finishCommand();
        if (this.closeParen) return true;
        const top = this.frames[this.frames.length - 1];
        if (top && top.kind === 'sub') this.frames.pop();
        this.cmdStart = false;
        return false;
      }
      default:
        void start;
        return false;
    }
  }

  /** @param {Word} w */
  handleWord(w) {
    if (this.expectTarget) {
      this.expectTarget = false;
      if (this.heredocTarget) {
        const delim = w.text;
        this.heredocs.push({ delim, strip: this.heredocTarget.strip, quoted: w.quoted });
        this.heredocTarget = null;
      }
      return;
    }
    const text = w.text;
    const kwOk = !w.quoted && w.raw === text;

    switch (this.mode) {
      case 'casehead':
        if (kwOk && text === 'in') {
          this.mode = 'casepat';
          const top = this.topFrame('case');
          if (top) {
            top.patterns = [];
            top.seen = [];
          }
        } else {
          const top = this.topFrame('case');
          if (top) top.head += `${w.raw} `;
        }
        return;
      case 'casepat': {
        const top = this.topFrame('case');
        if (kwOk && text === 'esac' && top && top.patterns.length === 0) {
          this.frames.pop();
          this.mode = 'cmd';
          this.cmdStart = false;
          return;
        }
        if (top) top.patterns.push(w.raw);
        return;
      }
      case 'forhead':
        if (kwOk && text === 'in') this.mode = 'forwords';
        return;
      case 'forwords':
        return;
      case 'funcname':
        this.mode = 'cmd';
        this.cmdStart = true;
        return;
      default:
    }

    if (this.cmdStart && this.words.length === 0 && kwOk) {
      if (this.handleKeyword(text)) return;
    }

    if (this.inDbl) {
      this.words.push(w);
      if (text === ']]') this.inDbl = false;
      return;
    }

    if (this.words.length === 0 && /^[A-Za-z_][A-Za-z0-9_]*(\[[^\]]*\])?\+?=/.test(w.raw)) {
      this.assigns.push(w.raw);
      return;
    }
    if (this.words.length === 0 && text === '[[' && kwOk) this.inDbl = true;
    this.words.push(w);
    this.cmdStart = false;
  }

  /**
   * @param {string} kw
   * @returns {boolean} handled as keyword
   */
  handleKeyword(kw) {
    switch (kw) {
      case 'if':
        this.frames.push({
          kind: 'if',
          restriction: undefined,
          parent: this.currentRestriction(),
          neg: [],
          condStart: this.i,
          sawUnrestricted: false,
        });
        return true;
      case 'then': {
        const f = this.topFrame('if');
        if (f) {
          const cond = this.src.slice(f.condStart, this.i - 4);
          const a = analyzeCondition(cond);
          f.neg.push(a);
          if (a === null) f.sawUnrestricted = true;
          f.restriction = a === null ? f.parent : intersect(f.parent ?? ALL_PLATFORMS, a);
        }
        return true;
      }
      case 'elif': {
        const f = this.topFrame('if');
        if (f) {
          f.restriction = complementOf(f.parent, f.neg);
          f.condStart = this.i;
        }
        return true;
      }
      case 'else': {
        const f = this.topFrame('if');
        if (f) f.restriction = complementOf(f.parent, f.neg);
        return true;
      }
      case 'fi': {
        const f = this.topFrame('if');
        if (f) this.frames.splice(this.frames.lastIndexOf(f), 1);
        this.cmdStart = false;
        return true;
      }
      case 'while':
      case 'until':
        this.frames.push({ kind: 'loop', restriction: undefined });
        return true;
      case 'for':
      case 'select':
        this.frames.push({ kind: 'loop', restriction: undefined });
        this.mode = 'forhead';
        if (this.peekNonSpace() === '(') {
          // for ((i=0; i<n; i++))
          this.skipTo('(');
          this.skipArithmetic();
          this.mode = 'cmd';
        }
        return true;
      case 'do':
        return true;
      case 'done': {
        const f = this.topFrame('loop');
        if (f) this.frames.splice(this.frames.lastIndexOf(f), 1);
        this.cmdStart = false;
        return true;
      }
      case 'case':
        this.frames.push({ kind: 'case', restriction: undefined, head: '', patterns: [], seen: [], parent: this.currentRestriction() });
        this.mode = 'casehead';
        return true;
      case 'esac': {
        const f = this.topFrame('case');
        if (f) this.frames.splice(this.frames.lastIndexOf(f), 1);
        this.mode = 'cmd';
        this.cmdStart = false;
        return true;
      }
      case '{':
        this.frames.push({ kind: 'brace', restriction: undefined });
        return true;
      case '}': {
        const f = this.topFrame('brace');
        if (f) this.frames.splice(this.frames.lastIndexOf(f), 1);
        this.cmdStart = false;
        return true;
      }
      case '!':
      case 'time':
        return true;
      case 'function':
        this.mode = 'funcname';
        return true;
      case 'coproc': {
        const pos = this.pos(this.wordStart);
        this.ctx.commands.push({
          name: 'coproc',
          words: [],
          args: [],
          line: pos.line,
          col: pos.col,
          restriction: this.currentRestriction(),
          fallback: false,
          ops: [],
          via: null,
        });
        return true;
      }
      default:
        void KEYWORD_RESET;
        return false;
    }
  }

  // ---- case/platform helpers ---------------------------------------------

  applyCasePattern() {
    const f = this.topFrame('case');
    if (!f) return;
    if (!/\b(uname|OSTYPE|MACHTYPE)\b/.test(f.head) && !mentionsOsVariable(f.head)) {
      f.restriction = undefined;
      return;
    }
    /** @type {Platform[] | null} */
    let set = [];
    for (const raw of f.patterns) {
      for (const alt of raw.replace(/^\(/, '').split('|')) {
        const a = alt.replace(/["']/g, '').replace(/^_+/, '').toLowerCase();
        if (a === '*' || a === '') {
          set = null;
          break;
        }
        if (/^(darwin|macos|mac|osx)/.test(a)) set.push('macos');
        else if (/^linux[-_]?gnu/.test(a)) set.push('linux');
        else if (/^linux[-_]?musl/.test(a)) set.push('alpine');
        else if (/^linux/.test(a)) set.push('linux', 'alpine');
      }
      if (set === null) break;
    }
    const parent = f.parent ?? ALL_PLATFORMS;
    if (set === null) {
      const seen = f.seen.flat();
      f.restriction = parent.filter((/** @type {Platform} */ p) => !seen.includes(p));
    } else {
      f.seen.push(set);
      f.restriction = intersect(parent, [...new Set(set)]);
    }
  }

  /** @param {'if' | 'case' | 'loop' | 'brace' | 'sub'} kind */
  topFrame(kind) {
    for (let k = this.frames.length - 1; k >= 0; k--) {
      if (this.frames[k].kind === kind) return /** @type {any} */ (this.frames[k]);
    }
    return null;
  }

  /** @param {'&&' | '||'} op */
  chainOp(op) {
    if (op === '||') {
      this.pendingFallback = this.ctx.commands.slice(this.chainStart);
    }
    const a = this.pendingTest;
    if (a) {
      const base = this.chainBase();
      this.chainRestriction = op === '&&' ? intersect(base ?? ALL_PLATFORMS, a) : (base ?? ALL_PLATFORMS).filter((p) => !a.includes(p));
    }
  }

  chainBase() {
    const top = this.frames[this.frames.length - 1];
    if (top && top.restriction !== undefined) return top.restriction;
    return this.baseRestriction;
  }

  endChain() {
    this.chainRestriction = undefined;
    this.pendingTest = null;
    this.pendingFallback = [];
    this.altMode = false;
    this.chainStart = this.ctx.commands.length;
  }

  // ---- command assembly ------------------------------------------------

  finishCommand() {
    const words = this.words;
    const ops = this.ops;
    this.words = [];
    this.assigns = [];
    this.ops = [];
    this.expectTarget = false;
    this.heredocTarget = null;
    this.inDbl = false;
    if (!words.length) return;
    const first = words[0];
    const name = commandName(first.text);
    const pos = this.pos(first.start);
    /** @type {Command} */
    const cmd = {
      name,
      words,
      args: words.slice(1).map((w) => w.text),
      line: pos.line,
      col: pos.col,
      restriction: this.currentRestriction(),
      fallback: false,
      ops,
      via: null,
    };
    this.ctx.commands.push(cmd);
    if (this.pendingFallback.length && !ERROR_HANDLERS.has(name)) {
      for (const c of this.pendingFallback) c.fallback = true;
      this.pendingFallback = [];
      this.altMode = true;
    }
    if (this.altMode) cmd.fallback = true;
    if (name === '[' || name === '[[' || name === 'test') {
      this.pendingTest = analyzeCondition(words.map((w) => w.raw).join(' '));
    }
  }

  // ---- lexer -----------------------------------------------------------

  /** @returns {Token} */
  next() {
    const s = this.src;
    for (;;) {
      // skip blanks and line continuations
      while (this.i < this.end) {
        const c = s[this.i];
        if (c === ' ' || c === '\t' || c === '\r') this.i++;
        else if (c === '\\' && s[this.i + 1] === '\n') this.i += 2;
        else break;
      }
      if (this.i >= this.end) return { t: 'eof' };
      const c = s[this.i];

      if (c === '#') {
        const eol = s.indexOf('\n', this.i);
        const stop = eol === -1 || eol > this.end ? this.end : eol;
        this.ctx.comments.push({ line: this.pos(this.i).line, text: s.slice(this.i, stop) });
        this.i = stop;
        continue;
      }
      if (c === '\n') {
        this.i++;
        if (this.heredocs.length) this.readHeredocs();
        return { t: 'nl' };
      }
      if (this.inDbl && c !== ';') return { t: 'word', w: this.readWord() };

      if (OPERATOR_START.has(c)) {
        if ((c === '<' || c === '>') && s[this.i + 1] === '(') {
          return { t: 'word', w: this.readWord() };
        }
        return this.readOperator();
      }
      const w = this.readWord();
      if (/^[0-9]+$/.test(w.raw) && (s[this.i] === '<' || s[this.i] === '>') && s[this.i + 1] !== '(') {
        continue; // file-descriptor prefix of a redirection
      }
      return { t: 'word', w };
    }
  }

  /** @returns {Token} */
  readOperator() {
    const s = this.src;
    const start = this.i;
    const c = s[this.i];
    const three = s.slice(this.i, this.i + 3);
    const two = s.slice(this.i, this.i + 2);
    if (c === '<' || c === '>' || (c === '&' && s[this.i + 1] === '>')) {
      for (const op of ['&>>', '<<<', '<<-', '&>', '>>', '<<', '>&', '<&', '>|', '<>']) {
        if (s.startsWith(op, this.i)) {
          this.i += op.length;
          return { t: /** @type {'redir'} */ ('redir'), v: op };
        }
      }
      this.i++;
      return { t: 'redir', v: c };
    }
    if (three === ';;&') {
      this.i += 3;
      return { t: 'op', v: three, start };
    }
    if (['&&', '||', '|&', ';;', ';&'].includes(two)) {
      this.i += 2;
      return { t: 'op', v: two, start };
    }
    this.i++;
    return { t: 'op', v: c, start };
  }

  /** @returns {Word} */
  readWord() {
    const s = this.src;
    const start = this.i;
    this.wordStart = start;
    let text = '';
    let quoted = false;
    const dbl = this.inDbl;
    while (this.i < this.end) {
      const c = s[this.i];
      if (c === ' ' || c === '\t' || c === '\n' || c === '\r') break;
      if (c === '\\') {
        const n = s[this.i + 1];
        if (n === '\n') {
          this.i += 2;
          continue;
        }
        if (n !== undefined) {
          text += n;
          quoted = true;
          this.i += 2;
          continue;
        }
        this.i++;
        continue;
      }
      if (c === "'") {
        const close = s.indexOf("'", this.i + 1);
        const stop = close === -1 || close >= this.end ? this.end : close;
        text += s.slice(this.i + 1, stop);
        quoted = true;
        this.i = stop + 1;
        continue;
      }
      if (c === '"') {
        quoted = true;
        text += this.readDoubleQuoted();
        continue;
      }
      if (c === '$') {
        const n = s[this.i + 1];
        if (n === "'") {
          quoted = true;
          this.i += 2;
          while (this.i < this.end && s[this.i] !== "'") {
            if (s[this.i] === '\\') {
              text += s[this.i + 1] ?? '';
              this.i += 2;
            } else text += s[this.i++];
          }
          this.i++;
          continue;
        }
        if (n === '(') {
          text += this.readSubstitution();
          continue;
        }
        if (n === '{') {
          const e = this.skipBraces(this.i + 2);
          text += s.slice(this.i, e);
          this.i = e;
          continue;
        }
        text += c;
        this.i++;
        continue;
      }
      if (c === '`') {
        text += this.readBackticks();
        continue;
      }
      if (dbl && c === ';') break;
      if (!dbl) {
        if (c === '(' && /^[A-Za-z_][A-Za-z0-9_]*(\[[^\]]*\])?\+?=$/.test(s.slice(start, this.i))) {
          // array literal: name=(a b c)
          const e = this.skipParens(this.i + 1);
          text += s.slice(this.i, e);
          this.i = e;
          continue;
        }
        if ((c === '<' || c === '>') && s[this.i + 1] === '(') {
          text += this.readSubstitution(1);
          continue;
        }
        if (c === '(' && /[@+!?*]/.test(s[this.i - 1] ?? '') && this.i > start) {
          const e = this.skipParens(this.i + 1);
          text += s.slice(this.i, e);
          this.i = e;
          continue;
        }
        if (OPERATOR_START.has(c)) break;
      }
      text += c;
      this.i++;
    }
    return { text, raw: s.slice(start, this.i), quoted, start };
  }

  readDoubleQuoted() {
    const s = this.src;
    let out = '';
    this.i++; // opening quote
    while (this.i < this.end && s[this.i] !== '"') {
      const c = s[this.i];
      if (c === '\\' && this.i + 1 < this.end) {
        const n = s[this.i + 1];
        if (n === '\n') {
          this.i += 2;
          continue;
        }
        out += '$`"\\'.includes(n) ? n : c + n;
        this.i += 2;
        continue;
      }
      if (c === '$' && s[this.i + 1] === '(') {
        out += this.readSubstitution();
        continue;
      }
      if (c === '$' && s[this.i + 1] === '{') {
        const e = this.skipBraces(this.i + 2);
        out += s.slice(this.i, e);
        this.i = e;
        continue;
      }
      if (c === '`') {
        out += this.readBackticks();
        continue;
      }
      out += c;
      this.i++;
    }
    this.i++; // closing quote
    return out;
  }

  /**
   * `$(...)`, `$((...))`, `<(...)` and `>(...)`. Parses the inner commands.
   * @param {number} [prefix] length of the introducer minus 1 (`$` = 0, `<`/`>` = 1)
   */
  readSubstitution(prefix = 0) {
    const s = this.src;
    const open = this.i + 1; // position of the opening paren for $(, <( and >(
    if (prefix === 0 && s[open + 1] === '(') {
      const e = this.skipParens(open + 1);
      const text = s.slice(this.i, e);
      this.i = e;
      return text;
    }
    const from = this.i;
    if (this.ctx.depth > 40) {
      this.i = this.end;
      return '';
    }
    this.ctx.depth++;
    const sub = new Parser(this.ctx, open + 1, this.end, true, this.currentRestriction());
    const after = sub.parse();
    this.ctx.depth--;
    this.i = after;
    return s.slice(from, after);
  }

  readBackticks() {
    const s = this.src;
    const from = this.i;
    let j = this.i + 1;
    while (j < this.end && s[j] !== '`') {
      if (s[j] === '\\') j++;
      j++;
    }
    if (this.ctx.depth <= 40) {
      this.ctx.depth++;
      const sub = new Parser(this.ctx, from + 1, Math.min(j, this.end), false, this.currentRestriction());
      sub.parse();
      this.ctx.depth--;
    }
    this.i = j + 1;
    return s.slice(from, this.i);
  }

  /** @param {number} from offset just after `${` */
  skipBraces(from) {
    const s = this.src;
    let depth = 1;
    let j = from;
    while (j < this.end && depth > 0) {
      const c = s[j];
      if (c === '\\') j++;
      else if (c === "'") {
        const e = s.indexOf("'", j + 1);
        j = e === -1 ? this.end : e;
      } else if (c === '{') depth++;
      else if (c === '}') depth--;
      j++;
    }
    return j;
  }

  /** @param {number} from offset just after the opening paren */
  skipParens(from) {
    const s = this.src;
    let depth = 1;
    let j = from;
    while (j < this.end && depth > 0) {
      const c = s[j];
      if (c === '\\') j++;
      else if (c === "'") {
        const e = s.indexOf("'", j + 1);
        j = e === -1 ? this.end : e;
      } else if (c === '(') depth++;
      else if (c === ')') depth--;
      j++;
    }
    return j;
  }

  skipArithmetic() {
    // positioned just after the first "(" of "(("
    this.i = this.skipParens(this.i + 1);
    if (this.src[this.i] === ')') this.i++;
    this.cmdStart = false;
  }

  /** @param {string} ch */
  skipTo(ch) {
    const k = this.src.indexOf(ch, this.i);
    this.i = k === -1 ? this.end : k + 1;
  }

  peekNonSpace() {
    let j = this.i;
    while (j < this.end && (this.src[j] === ' ' || this.src[j] === '\t')) j++;
    return this.src[j];
  }

  readHeredocs() {
    const s = this.src;
    for (const h of this.heredocs) {
      for (;;) {
        if (this.i >= this.end) break;
        let eol = s.indexOf('\n', this.i);
        if (eol === -1 || eol > this.end) eol = this.end;
        let line = s.slice(this.i, eol);
        this.i = Math.min(eol + 1, this.end);
        if (h.strip) line = line.replace(/^\t+/, '');
        if (line === h.delim) break;
      }
    }
    this.heredocs = [];
  }
}

/**
 * @typedef {{kind: 'sub' | 'loop' | 'brace', restriction: Platform[] | null | undefined}} SimpleFrame
 * @typedef {{kind: 'if', restriction: Platform[] | null | undefined, parent: Platform[] | null, neg: (Platform[] | null)[], condStart: number, sawUnrestricted: boolean}} IfFrame
 * @typedef {{kind: 'case', restriction: Platform[] | null | undefined, head: string, patterns: string[], seen: Platform[][], parent: Platform[] | null}} CaseFrame
 * @typedef {SimpleFrame | IfFrame | CaseFrame} Frame
 */

/**
 * @param {Platform[] | null} parent
 * @param {(Platform[] | null)[]} branches platforms of the previous branches (null = unrestricted)
 * @returns {Platform[] | null}
 */
function complementOf(parent, branches) {
  if (branches.some((b) => b === null)) return parent;
  const taken = branches.flat();
  return (parent ?? ALL_PLATFORMS).filter((p) => !taken.includes(p));
}

/** Variable names that conventionally hold the operating system: OS, OSTYPE, NVM_OS, platform... */
const OS_VARIABLE = /\$\{?_*([A-Za-z][A-Za-z0-9_]*)/g;
const OS_VARIABLE_NAME = /(^|_)(os|ostype|osname|platform|uname|kernel|sysname|distro)(_|$)/i;

/**
 * @param {string} text
 * @returns {boolean} the text mentions a variable that probably holds the operating system
 */
export function mentionsOsVariable(text) {
  for (const m of text.matchAll(OS_VARIABLE)) if (OS_VARIABLE_NAME.test(m[1])) return true;
  return false;
}

/**
 * Which platforms does a shell condition select? Returns null when the
 * condition says nothing about the operating system.
 *
 * @param {string} cond source text of the condition
 * @param {{loose?: boolean}} [opts] loose: also accept make-style variable names such as UNAME_S or DETECTED_OS
 * @returns {Platform[] | null}
 */
export function analyzeCondition(cond, opts = {}) {
  const text = cond.replace(/\s+/g, ' ');
  const mentionsOs =
    /\b(uname|OSTYPE|MACHTYPE)\b|sw_vers|\/etc\/os-release|\/etc\/alpine-release|\/etc\/debian_version|\/proc\/version/.test(text) ||
    mentionsOsVariable(text) ||
    (opts.loose === true && /uname|ostype|detected_os|platform|\bOS\b/i.test(text));
  const featureTest = /\bgnu\b|(?<![a-z])bsd\b/i.test(text);
  if (!mentionsOs && !featureTest) return null;

  const mac = /darwin|macos|\bosx\b|sw_vers/i.test(text);
  const linux = /linux|os-release|debian_version|\/proc\/version/i.test(text);
  const alp = /alpine/i.test(text);
  /** @type {Platform[] | null} */
  let set = null;
  if (mac && !linux && !alp) set = ['macos'];
  else if (alp && !mac) set = ['alpine'];
  else if (linux && !mac) set = /linux-?gnu/i.test(text) ? ['linux'] : ['linux', 'alpine'];
  else if (!mac && !linux && !alp) {
    if (/\bgnu\b/i.test(text) && !/(?<![a-z])bsd\b/i.test(text)) set = ['linux'];
    else if (/(?<![a-z])bsd\b/i.test(text) && !/\bgnu\b/i.test(text)) set = ['macos'];
    else if (mentionsOs && /freebsd|openbsd|netbsd|dragonfly|solaris|sunos|cygwin|msys|mingw|\baix\b|haiku/i.test(text)) set = [];
  }
  if (!set) return null;
  const negated = /!=|-ne\b|(^|\s)!\s*\[|\bnot\b/.test(text) || /!\s*(grep|test)/.test(text);
  if (negated) return ALL_PLATFORMS.filter((p) => !(/** @type {Platform[]} */ (set).includes(p)));
  return set;
}

// ---- wrappers ------------------------------------------------------------

/**
 * Name used to look a command up in the rules. A path to a system directory
 * (`/usr/bin/sed`) is the system tool; `./install` or `scripts/build` is the project's own script.
 * @param {string} word
 */
function commandName(word) {
  if (!word.includes('/')) return word;
  if (/^\/(usr\/)?(local\/)?s?bin\//.test(word) || /^\/opt\/homebrew\/bin\//.test(word)) return word.slice(word.lastIndexOf('/') + 1);
  return word;
}

const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ash', 'ksh']);

const OPTS_WITH_ARG = {
  sudo: new Set(['-u', '-g', '-h', '-p', '-C', '-D', '-r', '-t', '-T', '-U', '-R']),
  doas: new Set(['-u', '-C']),
  nice: new Set(['-n']),
  timeout: new Set(['-s', '-k', '--signal', '--kill-after']),
  xargs: new Set([
    '-I',
    '-n',
    '-P',
    '-s',
    '-d',
    '-E',
    '-L',
    '-a',
    '-J',
    '-R',
    '-S',
    '--max-args',
    '--max-procs',
    '--delimiter',
    '--arg-file',
    '--max-lines',
  ]),
  env: new Set(['-u', '-C', '-S', '--unset', '--chdir']),
  watch: new Set(['-n', '-d']),
};

/**
 * Commands run *by* another command (`xargs sed -i ...`, `find -exec ...`, `sh -c '...'`).
 * Returns the wrapped commands, with the wrapper recorded in `via`.
 *
 * @param {Command} cmd
 * @returns {Command[]}
 */
export function unwrap(cmd) {
  /** @type {Command[]} */
  const out = [];
  const w = cmd.words;
  /** @param {Word[]} words @param {string} via */
  const make = (words, via) => {
    if (!words.length) return null;
    const name = commandName(words[0].text);
    /** @type {Command} */
    const inner = {
      name,
      words,
      args: words.slice(1).map((x) => x.text),
      line: cmd.line,
      col: cmd.col,
      restriction: cmd.restriction,
      fallback: cmd.fallback,
      ops: [],
      via,
    };
    return inner;
  };
  /** @param {Command | null} inner */
  const push = (inner) => {
    if (!inner) return;
    out.push(inner);
    out.push(...unwrap(inner));
  };

  const n = cmd.name;
  if (n === 'sudo' || n === 'doas' || n === 'nice' || n === 'timeout' || n === 'env' || n === 'xargs' || n === 'watch') {
    const withArg = /** @type {Set<string>} */ (OPTS_WITH_ARG[/** @type {keyof typeof OPTS_WITH_ARG} */ (n)]);
    let k = 1;
    while (k < w.length) {
      const t = w[k].text;
      if (t === '--') {
        k++;
        break;
      }
      if (n === 'env' && /^[A-Za-z_][A-Za-z0-9_]*=/.test(t)) {
        k++;
        continue;
      }
      if (t.startsWith('-') && t.length > 1) {
        if (n === 'timeout' && /^-[a-z]$/.test(t) === false && !withArg.has(t) && /^-/.test(t)) {
          k++;
          continue;
        }
        k += withArg.has(t) ? 2 : 1;
        continue;
      }
      break;
    }
    if (n === 'timeout' && k < w.length) k++; // DURATION
    if (n === 'nice' && k <= w.length) {
      /* options consumed above */
    }
    push(make(w.slice(k), n));
  } else if (n === 'nohup' || n === 'exec' || n === 'builtin' || n === 'time') {
    push(make(w.slice(1), n));
  } else if (n === 'command') {
    let k = 1;
    while (k < w.length && w[k].text.startsWith('-')) {
      if (/^-[vV]/.test(w[k].text)) return out; // existence query, not an invocation
      k++;
    }
    push(make(w.slice(k), 'command'));
  } else if (n === 'find') {
    for (let k = 1; k < w.length; k++) {
      if (['-exec', '-execdir', '-ok', '-okdir'].includes(w[k].text)) {
        let e = k + 1;
        while (e < w.length && w[e].text !== ';' && w[e].text !== '+') e++;
        push(make(w.slice(k + 1, e), 'find -exec'));
        k = e;
      }
    }
  } else if (SHELLS.has(n)) {
    for (let k = 1; k < w.length - 1; k++) {
      const t = w[k].text;
      if (/^-[a-zA-Z]*c[a-zA-Z]*$/.test(t)) {
        const inner = parseShell(w[k + 1].text, { fixedPos: { line: cmd.line, col: cmd.col } });
        for (const c of inner.commands) {
          out.push({ ...c, restriction: cmd.restriction, fallback: cmd.fallback, via: `${n} -c` });
          out.push(...unwrap(c));
        }
        break;
      }
    }
  } else if (n === 'eval' && w.length > 1) {
    const inner = parseShell(
      w
        .slice(1)
        .map((x) => x.text)
        .join(' '),
      { fixedPos: { line: cmd.line, col: cmd.col } },
    );
    for (const c of inner.commands) {
      out.push({ ...c, restriction: cmd.restriction, fallback: cmd.fallback, via: 'eval' });
      out.push(...unwrap(c));
    }
  }
  return out;
}
