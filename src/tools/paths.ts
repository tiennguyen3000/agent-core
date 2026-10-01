/**
 * Path handling for tools.
 *
 * The filesystem port always receives an absolute path, while everything the
 * model sees (tool output, glob/grep results) is workdir-relative with POSIX
 * separators. Mutations additionally have to prove they stay inside the
 * workspace, so a tool cannot be tricked into writing elsewhere even when the
 * port itself is unconfined.
 */

import { isAbsolute, relative, resolve } from 'node:path';

export interface ResolvedToolPath {
  /** Absolute path handed to the filesystem port. */
  readonly absolute: string;
  /** Workdir-relative POSIX path for display and matching. */
  readonly relative: string;
}

export function toPosixPath(value: string): string {
  return value.replace(/\\/g, '/');
}

export function resolveToolPath(workdir: string, input: string): ResolvedToolPath {
  const cleaned = toPosixPath(input.trim());
  const absolute = isAbsolute(cleaned) ? resolve(cleaned) : resolve(workdir, cleaned);
  return { absolute, relative: toRelativePath(workdir, absolute) };
}

export function toRelativePath(workdir: string, absolute: string): string {
  const rel = toPosixPath(relative(workdir, absolute));
  return rel === '' ? '.' : rel;
}

/** True when `absolute` is the workspace root itself or sits below it. */
export function isInsideWorkdir(workdir: string, absolute: string): boolean {
  const rel = relative(workdir, absolute);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

/** Joins a workdir-relative POSIX path without leaving the relative space. */
export function joinRelative(base: string, name: string): string {
  return base === '.' || base === '' ? name : `${base}/${name}`;
}
