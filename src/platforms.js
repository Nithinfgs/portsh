import { existsSync } from 'node:fs';

/**
 * The three userlands portsh reasons about.
 *
 * - macos:  BSD userland (sed, grep, date, stat...) and /bin/bash 3.2
 * - linux:  GNU coreutils / glibc distributions (Debian, Ubuntu, Fedora...)
 * - alpine: BusyBox userland on musl (Alpine and BusyBox-based images)
 */

/** @typedef {'macos' | 'linux' | 'alpine'} Platform */

export const ALL_PLATFORMS = /** @type {Platform[]} */ (['macos', 'linux', 'alpine']);

/** Platforms checked when nothing narrows the scope. Alpine is opt-in (or inferred from a Dockerfile). */
export const DEFAULT_TARGETS = /** @type {Platform[]} */ (['macos', 'linux']);

export const PLATFORM_LABELS = {
  macos: 'macOS',
  linux: 'Linux',
  alpine: 'Alpine',
};

/**
 * @param {string} value
 * @returns {Platform | null}
 */
export function parsePlatform(value) {
  const v = value.trim().toLowerCase();
  if (v === 'macos' || v === 'darwin' || v === 'mac' || v === 'osx') return 'macos';
  if (v === 'linux' || v === 'gnu' || v === 'debian' || v === 'ubuntu') return 'linux';
  if (v === 'alpine' || v === 'busybox' || v === 'musl') return 'alpine';
  return null;
}

/**
 * @param {string} list comma separated
 * @returns {Platform[]}
 */
export function parsePlatformList(list) {
  /** @type {Platform[]} */
  const out = [];
  for (const part of list.split(',')) {
    if (!part.trim()) continue;
    const p = parsePlatform(part);
    if (!p) throw new Error(`unknown platform "${part.trim()}" (expected macos, linux or alpine)`);
    if (!out.includes(p)) out.push(p);
  }
  return out;
}

/**
 * Platform of the machine running portsh. Used by `portsh verify`.
 * @returns {Platform | null}
 */
export function detectHostPlatform() {
  if (process.platform === 'darwin') return 'macos';
  if (process.platform === 'linux') {
    return existsSync('/etc/alpine-release') ? 'alpine' : 'linux';
  }
  return null;
}

/**
 * @param {Platform[]} a
 * @param {Platform[] | null} b null means "unrestricted"
 * @returns {Platform[]}
 */
export function intersect(a, b) {
  if (!b) return a;
  return a.filter((p) => b.includes(p));
}

/**
 * Map a workflow runner label or container image to a platform.
 * @param {string} label
 * @returns {Platform | 'windows' | null}
 */
export function platformOfLabel(label) {
  const l = label.toLowerCase();
  if (/^(ubuntu|debian|linux|fedora|centos|rockylinux|almalinux|amazonlinux)/.test(l) || l.includes('ubuntu')) return 'linux';
  if (/^(macos|darwin|osx)/.test(l)) return 'macos';
  if (/^windows/.test(l)) return 'windows';
  if (/alpine|busybox/.test(l)) return 'alpine';
  return null;
}
