import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { Db } from './connection.js';

const FILE_PATTERN = /^(\d{4})_([a-z0-9_]+)\.sql$/;

export interface MigrationFile {
  version: number;
  name: string;
  filename: string;
  checksum: string;
  sql: string;
}

export interface AppliedMigration {
  version: number;
  name: string;
  checksum: string;
  applied_at: string;
}

export interface MigrationStatus {
  applied: AppliedMigration[];
  pending: MigrationFile[];
}

export class MigrationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MigrationError';
  }
}

/** Line endings are normalised so a CRLF checkout on Windows yields the same checksum. */
function checksumOf(sql: string): string {
  return crypto.createHash('sha256').update(sql.replace(/\r\n/g, '\n')).digest('hex');
}

export function readMigrationFiles(dir: string): MigrationFile[] {
  if (!fs.existsSync(dir)) throw new MigrationError(`Migrations directory not found: ${dir}`);

  const files: MigrationFile[] = [];
  const seen = new Map<number, string>();
  for (const filename of fs.readdirSync(dir).sort()) {
    if (!filename.endsWith('.sql')) continue;
    const match = FILE_PATTERN.exec(filename);
    if (!match) {
      throw new MigrationError(
        `Migration "${filename}" must be named NNNN_lower_snake_name.sql (e.g. 0002_add_users.sql)`,
      );
    }
    const version = Number(match[1]);
    const clash = seen.get(version);
    if (clash) throw new MigrationError(`Migrations "${clash}" and "${filename}" share version ${version}`);
    seen.set(version, filename);

    const sql = fs.readFileSync(path.join(dir, filename), 'utf8');
    files.push({ version, name: match[2]!, filename, checksum: checksumOf(sql), sql });
  }
  return files;
}

function ensureLedger(db: Db): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version     INTEGER PRIMARY KEY,
      name        TEXT    NOT NULL,
      checksum    TEXT    NOT NULL,
      applied_at  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    )
  `);
}

/**
 * Compares the ledger with the files on disk. Throws if an applied migration was edited or
 * deleted: the database would no longer match the schema the code expects.
 */
export function getMigrationStatus(db: Db, dir: string): MigrationStatus {
  ensureLedger(db);
  const files = readMigrationFiles(dir);
  const applied = db
    .prepare('SELECT version, name, checksum, applied_at FROM schema_migrations ORDER BY version')
    .all() as AppliedMigration[];

  const byVersion = new Map(files.map((f) => [f.version, f]));
  for (const row of applied) {
    const file = byVersion.get(row.version);
    if (!file) {
      throw new MigrationError(
        `Database has migration ${row.version} (${row.name}) but no matching file exists. ` +
          'The database is newer than this code; deploy the matching code version.',
      );
    }
    if (file.checksum !== row.checksum) {
      throw new MigrationError(
        `Migration ${file.filename} was modified after being applied. ` +
          'Never edit an applied migration; add a new migration instead.',
      );
    }
  }

  const appliedVersions = new Set(applied.map((a) => a.version));
  return { applied, pending: files.filter((f) => !appliedVersions.has(f.version)) };
}

/**
 * A migration starting with this line runs with foreign-key enforcement off, as SQLite's documented
 * table-rebuild procedure requires (https://www.sqlite.org/lang_altertable.html#otheralter). The
 * foreign keys are re-checked before commit, and the migration rolls back if any are violated.
 */
export const FOREIGN_KEYS_OFF_DIRECTIVE = '-- migrate:foreign-keys-off';

/** Applies every pending migration in order, each inside its own transaction. */
export function runMigrations(db: Db, dir: string): MigrationFile[] {
  const { pending } = getMigrationStatus(db, dir);
  const record = db.prepare('INSERT INTO schema_migrations (version, name, checksum) VALUES (?, ?, ?)');

  for (const migration of pending) {
    const fkOff = migration.sql.trimStart().startsWith(FOREIGN_KEYS_OFF_DIRECTIVE);
    const apply = db.transaction(() => {
      db.exec(migration.sql);
      if (fkOff) {
        const violations = db.pragma('foreign_key_check') as unknown[];
        if (violations.length) throw new Error(`${violations.length} foreign key violation(s) after rebuild`);
      }
      record.run(migration.version, migration.name, migration.checksum);
    });
    // The pragma is a no-op inside a transaction, so it is switched outside it.
    if (fkOff) db.pragma('foreign_keys = OFF');
    try {
      apply();
    } catch (err) {
      throw new MigrationError(
        `Migration ${migration.filename} failed and was rolled back: ${(err as Error).message}`,
      );
    } finally {
      if (fkOff) db.pragma('foreign_keys = ON');
    }
  }
  return pending;
}
