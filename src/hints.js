/**
 * Platform hints from a file's path: `install-macos.sh`, `plugins/archlinux/...`.
 * A script that is obviously for one platform should not be judged against the others.
 */

import { basename } from 'node:path';

/** @typedef {import('./platforms.js').Platform} Platform */

const MAC = new Set(['macos', 'darwin', 'osx', 'mac']);
const LINUX = new Set(['linux', 'ubuntu', 'debian', 'archlinux', 'fedora', 'centos', 'rhel']);

/**
 * @param {string} path  repo-relative path using / or the OS separator
 * @returns {Platform[] | null} the platforms the path suggests, or null for no hint
 */
export function platformsFromPath(path) {
  const segments = path.split(/[\\/]/).filter(Boolean);
  let mac = false;
  let linux = false;
  let alpine = false;
  for (const seg of [...segments.slice(0, -1), basename(path)]) {
    for (const token of seg.toLowerCase().split(/[^a-z0-9]+/)) {
      if (MAC.has(token)) mac = true;
      else if (LINUX.has(token)) linux = true;
      else if (token === 'alpine') alpine = true;
    }
  }
  const picked = /** @type {Platform[]} */ ([]);
  if (mac) picked.push('macos');
  if (linux) picked.push('linux');
  if (alpine) picked.push('alpine');
  return picked.length === 1 ? picked : null;
}
