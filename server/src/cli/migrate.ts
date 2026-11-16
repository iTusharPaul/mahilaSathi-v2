import { ConfigError, GEODATA_DIR, MIGRATIONS_DIR, loadConfigFromProcess } from '../config/index.js';
import { openDatabase } from '../db/connection.js';
import { getMigrationStatus, runMigrations } from '../db/migrator.js';
import { readGeoDataFiles, seedGeography } from '../services/geography/geoSeeder.js';

const command = process.argv[2] ?? 'status';

try {
  const config = loadConfigFromProcess();
  const db = openDatabase(config.databasePath);
  console.log(`Database: ${config.databasePath}`);

  if (command === 'up') {
    const applied = runMigrations(db, MIGRATIONS_DIR);
    console.log(applied.length ? `Applied: ${applied.map((m) => m.filename).join(', ')}` : 'Already up to date.');
    const seeded = seedGeography(db, readGeoDataFiles(GEODATA_DIR));
    console.log(`NCR geography: districts ${seeded.districts ? 'loaded' : 'current'}, places ${seeded.places ? 'loaded' : 'current'}.`);
  } else if (command === 'status') {
    const { applied, pending } = getMigrationStatus(db, MIGRATIONS_DIR);
    for (const m of applied) console.log(`  applied  ${String(m.version).padStart(4, '0')}_${m.name}  (${m.applied_at})`);
    for (const m of pending) console.log(`  pending  ${m.filename}`);
    if (!applied.length && !pending.length) console.log('  no migrations found');
  } else if (command === 'backup') {
    // Online, consistent copy (SQLite backup API): safe while the server is running.
    const target = process.argv[3] ?? `${config.databasePath}.${new Date().toISOString().replace(/[:.]/g, '-')}.bak`;
    await db.backup(target);
    console.log(`Backed up to ${target}`);
  } else {
    console.error(`Unknown command "${command}". Use "up", "status" or "backup [file]".`);
    process.exitCode = 2;
  }
  db.close();
} catch (err) {
  console.error(err instanceof ConfigError ? err.message : `Database command failed: ${(err as Error).message}`);
  process.exitCode = 1;
}
