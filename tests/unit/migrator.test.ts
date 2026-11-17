import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { MIGRATIONS_DIR } from '../../server/src/config/index.js';
import { openDatabase } from '../../server/src/db/connection.js';
import { MigrationError, getMigrationStatus, runMigrations } from '../../server/src/db/migrator.js';
import { createAuditRepository } from '../../server/src/repositories/auditRepository.js';
import { makeTempDir } from '../helpers/testApp.js';

function migrationsDir(files: Record<string, string>): string {
  const dir = makeTempDir('ms-migrations-');
  for (const [name, sql] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), sql);
  return dir;
}

const tableNames = (db: ReturnType<typeof openDatabase>) =>
  (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as { name: string }[]).map(
    (r) => r.name,
  );

describe('migration runner', () => {
  it('applies pending migrations in order and records them', () => {
    const dir = migrationsDir({
      '0002_b.sql': 'ALTER TABLE a ADD COLUMN extra TEXT;',
      '0001_a.sql': 'CREATE TABLE a (id INTEGER PRIMARY KEY);',
      'README.md': 'ignored',
    });
    const db = openDatabase(':memory:');
    const applied = runMigrations(db, dir);
    expect(applied.map((m) => m.filename)).toEqual(['0001_a.sql', '0002_b.sql']);
    expect(tableNames(db)).toContain('a');
    expect(getMigrationStatus(db, dir)).toMatchObject({ pending: [], applied: [{ version: 1 }, { version: 2 }] });
  });

  it('is idempotent', () => {
    const dir = migrationsDir({ '0001_a.sql': 'CREATE TABLE a (id INTEGER);' });
    const db = openDatabase(':memory:');
    runMigrations(db, dir);
    expect(runMigrations(db, dir)).toEqual([]);
  });

  it('rolls back a failing migration completely', () => {
    const dir = migrationsDir({
      '0001_a.sql': 'CREATE TABLE a (id INTEGER);',
      '0002_bad.sql': 'CREATE TABLE b (id INTEGER); INSERT INTO missing_table VALUES (1);',
    });
    const db = openDatabase(':memory:');
    expect(() => runMigrations(db, dir)).toThrow(/0002_bad\.sql failed and was rolled back/);
    expect(tableNames(db)).not.toContain('b');
    expect(getMigrationStatus(db, dir).pending.map((m) => m.version)).toEqual([2]);
  });

  it('refuses to run when an applied migration was edited', () => {
    const dir = migrationsDir({ '0001_a.sql': 'CREATE TABLE a (id INTEGER);' });
    const db = openDatabase(':memory:');
    runMigrations(db, dir);
    fs.writeFileSync(path.join(dir, '0001_a.sql'), 'CREATE TABLE a (id INTEGER, sneaky TEXT);');
    expect(() => runMigrations(db, dir)).toThrow(/modified after being applied/);
  });

  it('treats CRLF and LF checkouts as the same migration', () => {
    const dir = migrationsDir({ '0001_a.sql': 'CREATE TABLE a (id INTEGER);\nCREATE TABLE b (id INTEGER);\n' });
    const db = openDatabase(':memory:');
    runMigrations(db, dir);
    fs.writeFileSync(path.join(dir, '0001_a.sql'), 'CREATE TABLE a (id INTEGER);\r\nCREATE TABLE b (id INTEGER);\r\n');
    expect(() => runMigrations(db, dir)).not.toThrow();
  });

  it('detects a database that is newer than the code', () => {
    const dir = migrationsDir({ '0001_a.sql': 'CREATE TABLE a (id INTEGER);', '0002_b.sql': 'CREATE TABLE b (id INTEGER);' });
    const db = openDatabase(':memory:');
    runMigrations(db, dir);
    fs.rmSync(path.join(dir, '0002_b.sql'));
    expect(() => getMigrationStatus(db, dir)).toThrow(/database is newer than this code/);
  });

  it('rejects badly named or duplicate-version files', () => {
    const db = openDatabase(':memory:');
    expect(() => runMigrations(db, migrationsDir({ 'add_users.sql': '' }))).toThrow(MigrationError);
    expect(() => runMigrations(db, migrationsDir({ '0001_a.sql': '', '0001_b.sql': '' }))).toThrow(/share version 1/);
  });
});

describe('foreign-keys-off directive (table rebuilds)', () => {
  const parent = `CREATE TABLE p (id INTEGER PRIMARY KEY, kind TEXT CHECK (kind IN ('a')));
CREATE TABLE c (id INTEGER PRIMARY KEY, p_id INTEGER REFERENCES p (id) ON DELETE CASCADE);
INSERT INTO p VALUES (1, 'a');
INSERT INTO c VALUES (10, 1);`;
  const rebuild = `-- migrate:foreign-keys-off
CREATE TABLE p_new (id INTEGER PRIMARY KEY, kind TEXT CHECK (kind IN ('a', 'b')));
INSERT INTO p_new SELECT * FROM p;
DROP TABLE p;
ALTER TABLE p_new RENAME TO p;`;

  it('rebuilds a referenced table without cascading deletes, and restores enforcement', () => {
    const dir = migrationsDir({ '0001_a.sql': parent, '0002_rebuild.sql': rebuild });
    const db = openDatabase(':memory:');
    runMigrations(db, dir);
    expect(db.prepare('SELECT COUNT(*) AS n FROM c').get()).toEqual({ n: 1 }); // child row survived
    db.prepare("INSERT INTO p VALUES (2, 'b')").run(); // new CHECK applies
    expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
    expect(() => db.prepare('INSERT INTO c VALUES (11, 99)').run()).toThrow(/FOREIGN KEY/);
  });

  it('rolls back if the rebuild leaves broken references', () => {
    const broken = rebuild.replace('INSERT INTO p_new SELECT * FROM p;', '');
    const dir = migrationsDir({ '0001_a.sql': parent, '0002_rebuild.sql': broken });
    const db = openDatabase(':memory:');
    expect(() => runMigrations(db, dir)).toThrow(/foreign key violation/);
    expect(db.prepare('SELECT COUNT(*) AS n FROM p').get()).toEqual({ n: 1 });
    expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
  });
});

describe('project migrations', () => {
  it('apply cleanly to a fresh database', () => {
    const db = openDatabase(':memory:');
    const applied = runMigrations(db, MIGRATIONS_DIR);
    expect(applied.length).toBeGreaterThan(0);
    expect(tableNames(db)).toEqual(expect.arrayContaining(['schema_migrations', 'audit_events']));
    expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
  });

  it('apply to an on-disk database in WAL mode and survive reopening', () => {
    const file = path.join(makeTempDir(), 'nested', 'test.db');
    const db = openDatabase(file);
    runMigrations(db, MIGRATIONS_DIR);
    expect(db.pragma('journal_mode', { simple: true })).toBe('wal');
    db.close();
    const reopened = openDatabase(file);
    expect(getMigrationStatus(reopened, MIGRATIONS_DIR).pending).toEqual([]);
    reopened.close();
  });

  it('keep audit events append-only', () => {
    const db = openDatabase(':memory:');
    runMigrations(db, MIGRATIONS_DIR);
    const audit = createAuditRepository(db);
    const id = audit.record({ actorType: 'system', action: 'test.event', targetType: 'thing', targetId: 't1', metadata: { n: 1 } });
    expect(audit.listForTarget('thing', 't1')).toMatchObject([{ id, action: 'test.event', metadata_json: '{"n":1}' }]);
    expect(() => db.prepare("UPDATE audit_events SET action = 'tampered' WHERE id = ?").run(id)).toThrow(/append-only/);
  });

  it('0010 keeps existing phone accounts and their data, and allows Google-only accounts', () => {
    const before = makeTempDir('ms-migrations-');
    for (const f of fs.readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql') && f < '0010')) fs.copyFileSync(path.join(MIGRATIONS_DIR, f), path.join(before, f));
    const db = openDatabase(':memory:');
    runMigrations(db, before);
    db.prepare("INSERT INTO users (id, phone_e164, community_handle, is_demo) VALUES ('u1', '+919811122233', 'Mango-11', 0)").run();
    db.prepare("INSERT INTO user_preferences (user_id, notify_community) VALUES ('u1', 1)").run();

    expect(runMigrations(db, MIGRATIONS_DIR).map((m) => m.version)).toEqual([10]);
    expect(db.prepare("SELECT phone_e164, google_sub, email, community_handle FROM users WHERE id = 'u1'").get()).toEqual({ phone_e164: '+919811122233', google_sub: null, email: null, community_handle: 'Mango-11' });
    // ON DELETE CASCADE did not fire during the rebuild.
    expect(db.prepare("SELECT notify_community FROM user_preferences WHERE user_id = 'u1'").get()).toEqual({ notify_community: 1 });
    expect(db.pragma('foreign_keys', { simple: true })).toBe(1);

    db.prepare("INSERT INTO users (id, google_sub, email, community_handle) VALUES ('u2', 'g-1', 'a@gmail.com', 'Neem-99')").run();
    expect(() => db.prepare("INSERT INTO users (id, community_handle) VALUES ('u3', 'Tulsi-12')").run()).toThrow(/CHECK/);
    expect(() => db.prepare("INSERT INTO users (id, google_sub, community_handle) VALUES ('u4', 'g-1', 'Tulsi-13')").run()).toThrow(/UNIQUE/);
  });
});
