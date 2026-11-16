import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Resolves identically from server/src/config (tsx) and server/dist/config (node).
const here = path.dirname(fileURLToPath(import.meta.url));

export const REPO_ROOT = path.resolve(here, '../../..');
export const MIGRATIONS_DIR = path.join(REPO_ROOT, 'database', 'migrations');
export const GEODATA_DIR = path.join(REPO_ROOT, 'database', 'geodata', 'ncr');
export const CLIENT_DIST_DIR = path.join(REPO_ROOT, 'client', 'dist');

/** Relative paths in configuration are resolved against the repository root, not the shell cwd. */
export function resolveFromRoot(p: string): string {
  return path.isAbsolute(p) ? p : path.resolve(REPO_ROOT, p);
}
