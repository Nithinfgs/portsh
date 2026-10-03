/**
 * Extractors turn a file into one or more shell "chunks", remembering where each
 * line came from and what platform the surrounding context implies.
 */

import { extractDockerfile } from './dockerfile.js';
import { extractMakefile } from './makefile.js';
import { extractMarkdown } from './markdown.js';
import { extractPackageJson } from './package-json.js';
import { extractScript } from './script.js';
import { extractWorkflow } from './workflow.js';

/** @typedef {import('../platforms.js').Platform} Platform */

/**
 * @typedef {'script' | 'makefile' | 'workflow' | 'dockerfile' | 'markdown' | 'package'} FileKind
 */

/**
 * @typedef {object} Chunk
 * @property {string} text         shell source
 * @property {{line: number, col: number}[]} lineMap  file position of each chunk line (index 0 = first chunk line)
 * @property {Platform[] | null} targets   platforms implied by the context, null = use the configured targets
 * @property {'bash' | 'sh' | 'zsh' | 'other' | 'unknown'} dialect
 * @property {string | null} interpreter
 * @property {(Platform[] | null)[]} [lineRestrictions]  per-line platform limits (Makefile conditionals)
 * @property {string} [label]
 */

/**
 * @param {FileKind} kind
 * @param {string} text
 * @param {string} file
 * @returns {Chunk[]}
 */
export function extract(kind, text, file) {
  switch (kind) {
    case 'script':
      return extractScript(text, file);
    case 'makefile':
      return extractMakefile(text);
    case 'workflow':
      return extractWorkflow(text);
    case 'dockerfile':
      return extractDockerfile(text);
    case 'markdown':
      return extractMarkdown(text);
    case 'package':
      return extractPackageJson(text);
    default:
      return [];
  }
}
