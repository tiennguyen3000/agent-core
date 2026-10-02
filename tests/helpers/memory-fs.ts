import type { DirEntry, SandboxedFs } from '../../src/index.js';

/**
 * In-memory filesystem port keyed by absolute POSIX paths.
 *
 * The keys stay POSIX on every platform: the filesystem port always receives an
 * absolute path, and on Windows `path.resolve` hands it back with backslashes,
 * which would otherwise turn every assertion into a platform question. Paths
 * coming in are normalised, so `/ws/a.txt` and `\\ws\\a.txt` are the same file.
 *
 * `list` behaves like a real filesystem: a known file throws `ENOTDIR` and an
 * unknown directory throws `ENOENT`, which is what lets the search tools tell
 * "this is a file" from "this path is missing".
 */
export interface MemoryFs extends SandboxedFs {
  readonly root: string;
  readonly files: Map<string, string>;
  /** Raw byte contents, for image reads. */
  readonly binary: Map<string, Uint8Array>;
  readonly dirs: Set<string>;
  /** Paths whose read throws, for exercising failure branches. */
  readonly unreadable: Set<string>;
  /** Workdir-relative view of the current contents. */
  snapshot(): Record<string, string>;
}

export interface MemoryFsOptions {
  readonly root?: string;
  readonly files?: Record<string, string>;
  /** Raw byte contents keyed by workdir-relative path. */
  readonly binary?: Record<string, Uint8Array>;
  /** Extra empty directories to materialise. */
  readonly dirs?: readonly string[];
}

/**
 * A real Windows absolute path carries a drive (`D:\ws\a.txt`) while the
 * virtual filesystem is rooted at `/ws`, so the drive is dropped and both
 * spellings address the same file.
 */
function toPosix(value: string): string {
  return value.replace(/^[A-Za-z]:/, '').replace(/\\/g, '/');
}

/** Joins and collapses `.`/`..` without touching the platform's separators. */
function virtualJoin(base: string, ...parts: readonly string[]): string {
  const joined = [base, ...parts].map(toPosix).join('/');
  const isAbsolute = joined.startsWith('/');
  const segments: string[] = [];
  for (const segment of joined.split('/')) {
    if (segment === '' || segment === '.') {
      continue;
    }
    if (segment === '..') {
      segments.pop();
      continue;
    }
    segments.push(segment);
  }
  return `${isAbsolute ? '/' : ''}${segments.join('/')}`;
}

function ancestorsOf(root: string, absolute: string): string[] {
  const parts = absolute.split('/');
  const result: string[] = [];
  for (let index = 1; index < parts.length; index += 1) {
    const candidate = parts.slice(0, index).join('/');
    if (candidate.startsWith(root) && candidate !== '') {
      result.push(candidate);
    }
  }
  return result;
}

export function memoryFs(options: MemoryFsOptions = {}): MemoryFs {
  const root = toPosix(options.root ?? '/ws');
  const files = new Map<string, string>();
  const binary = new Map<string, Uint8Array>();
  const dirs = new Set<string>([root]);

  for (const [path, bytes] of Object.entries(options.binary ?? {})) {
    const absolute = virtualJoin(root, path);
    binary.set(absolute, bytes);
    for (const dir of ancestorsOf(root, absolute)) {
      dirs.add(dir);
    }
  }

  for (const [path, content] of Object.entries(options.files ?? {})) {
    const absolute = virtualJoin(root, path);
    files.set(absolute, content);
    for (const dir of ancestorsOf(root, absolute)) {
      dirs.add(dir);
    }
  }
  for (const path of options.dirs ?? []) {
    const absolute = virtualJoin(root, path);
    dirs.add(absolute);
    for (const dir of ancestorsOf(root, absolute)) {
      dirs.add(dir);
    }
  }

  const unreadable = new Set<string>();

  return {
    root,
    files,
    binary,
    dirs,
    unreadable,
    snapshot: () =>
      Object.fromEntries(
        [...files.entries()].map(([path, content]) => [
          path.startsWith(`${root}/`) ? path.slice(root.length + 1) : path,
          content,
        ]),
      ),
    read: async (rawPath) => {
      const path = virtualJoin(rawPath);
      if (unreadable.has(path)) {
        throw new Error(`EACCES: ${path}`);
      }
      const value = files.get(path);
      if (value === undefined) {
        throw new Error(`ENOENT: ${path}`);
      }
      return value;
    },
    readBytes: async (rawPath) => {
      const path = virtualJoin(rawPath);
      if (unreadable.has(path)) {
        throw new Error(`EACCES: ${path}`);
      }
      const raw = binary.get(path);
      if (raw !== undefined) {
        return raw;
      }
      const value = files.get(path);
      if (value === undefined) {
        throw new Error(`ENOENT: ${path}`);
      }
      return new TextEncoder().encode(value);
    },
    write: async (rawPath, content) => {
      const path = virtualJoin(rawPath);
      files.set(path, content);
      for (const dir of ancestorsOf(root, path)) {
        dirs.add(dir);
      }
    },
    exists: async (rawPath) => {
      const path = virtualJoin(rawPath);
      return files.has(path) || binary.has(path) || dirs.has(path);
    },
    list: async (rawDir) => {
      const dir = virtualJoin(rawDir);
      if (files.has(dir)) {
        throw new Error(`ENOTDIR: ${dir}`);
      }
      if (!dirs.has(dir)) {
        throw new Error(`ENOENT: ${dir}`);
      }
      const prefix = `${dir}/`;
      const entries = new Map<string, boolean>();
      for (const path of [...files.keys(), ...binary.keys(), ...dirs]) {
        if (!path.startsWith(prefix)) {
          continue;
        }
        const rest = path.slice(prefix.length);
        const [head, ...tail] = rest.split('/');
        if (head === undefined || head === '') {
          continue;
        }
        const isDirectory = tail.length > 0 || (dirs.has(path) && !files.has(path));
        entries.set(head, (entries.get(head) ?? false) || isDirectory);
      }
      return [...entries.entries()]
        .map(([name, isDirectory]): DirEntry => ({ name, isDirectory }))
        .sort((a, b) => a.name.localeCompare(b.name));
    },
  };
}
