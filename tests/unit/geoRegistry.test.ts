import { beforeAll, describe, expect, it } from 'vitest';
import { MIGRATIONS_DIR } from '../../server/src/config/index.js';
import { openDatabase, type Db } from '../../server/src/db/connection.js';
import { runMigrations } from '../../server/src/db/migrator.js';
import { BOUNDARY_UNCERTAINTY_M, GeoRegistry } from '../../server/src/services/geography/geoRegistry.js';
import { GeoDataError, seedGeography } from '../../server/src/services/geography/geoSeeder.js';
import { geoData } from '../helpers/testApp.js';

let db: Db;
let registry: GeoRegistry;

beforeAll(() => {
  db = openDatabase(':memory:');
  runMigrations(db, MIGRATIONS_DIR);
  seedGeography(db, geoData());
  registry = new GeoRegistry(db);
});

describe('NCR dataset', () => {
  it('covers every NCR constituent: all of Delhi plus 13 Haryana, 8 UP and 2 Rajasthan polygons', () => {
    const byState = new Map<string, number>();
    for (const d of registry.listDistricts()) byState.set(d.state.id, (byState.get(d.state.id) ?? 0) + 1);
    expect(Object.fromEntries(byState)).toEqual({ delhi: 11, haryana: 13, 'uttar-pradesh': 8, rajasthan: 2 });
  });

  it('records the source, licence and version of the boundary dataset', () => {
    const row = db.prepare('SELECT * FROM boundary_datasets WHERE is_active = 1').get() as Record<string, string>;
    expect(row.source_url).toContain('geoBoundaries');
    expect(row.license).toContain('ODbL');
    expect(row.version).toMatch(/^2021-9469f09/);
    expect(row.source_sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('matches the official NCRPB state areas within 2%', () => {
    const manifest = geoData().manifest as unknown as { stateAreaCheck: { differencePct: number }[] };
    for (const s of manifest.stateAreaCheck) expect(Math.abs(s.differencePct)).toBeLessThan(2);
  });
});

describe('point resolution', () => {
  it.each([
    ['Connaught Place', 28.6315, 77.2167, 'delhi', 'Connaught Place', 'Delhi'],
    ['Cyber City, Gurugram', 28.495, 77.0895, 'haryana', 'Cyber City', 'Gurugram'],
    ['Sector 18, Noida', 28.57, 77.326, 'uttar-pradesh', 'Sector 18, Noida', 'Noida'],
    ['Indirapuram, Ghaziabad', 28.6415, 77.3712, 'uttar-pradesh', 'Indirapuram', 'Ghaziabad'],
    ['Sector 15, Faridabad', 28.395, 77.323, 'haryana', 'Sector 15, Faridabad', 'Faridabad'],
    ['Alwar town', 27.553, 76.6346, 'rajasthan', 'Alwar', 'Alwar'],
  ])('%s resolves to its state, neighbourhood and city', (_label, lat, lng, state, neighbourhood, city) => {
    const r = registry.resolve(lat, lng);
    expect(r.inNcr).toBe(true);
    expect(r.state?.id).toBe(state);
    expect(r.neighbourhood?.name).toBe(neighbourhood);
    expect(r.city?.name).toBe(city);
  });

  it.each([
    ['Jaipur', 26.9124, 75.7873],
    ['Agra', 27.1767, 78.0081],
    ['Mathura', 27.4924, 77.6737],
    ['Aligarh', 27.8974, 78.088],
    ['Chandigarh', 30.7333, 76.7794],
    ['Bengaluru', 12.9716, 77.5946],
  ])('%s is outside NCR and says so', (_label, lat, lng) => {
    const r = registry.resolve(lat, lng);
    expect(r).toMatchObject({ inNcr: false, state: null, district: null, needsManualConfirmation: false });
    expect(r.message).toMatch(/outside the National Capital Region/);
    expect(r.coverage.level).toBe('unknown');
  });

  it('resolves places with no mapped neighbourhood to their district without inventing one', () => {
    const r = registry.resolve(29.3159, 76.3159); // Jind town
    expect(r).toMatchObject({ inNcr: true, state: { id: 'haryana' }, district: { id: 'hr-jind' }, neighbourhood: null, city: { id: 'jind' } });
    expect(r.message).toMatch(/No neighbourhood is mapped here yet/);
  });

  it('flags points on a district edge as needing confirmation', () => {
    const vertex = (geoData().districts.features.find((f) => f.properties.id === 'dl-new-delhi')!.geometry.coordinates[0]![0]![5])!;
    const r = registry.resolve(vertex[1], vertex[0]);
    expect(r.inNcr).toBe(true);
    expect(r.uncertainty).not.toBe('none');
    expect(r.needsManualConfirmation).toBe(true);
  });

  it('treats a point just outside the mapped NCR edge as uncertain, and one far outside as outside', () => {
    const ring = geoData().districts.features.find((f) => f.properties.id === 'rj-alwar')!.geometry.coordinates[0]![0]!;
    const west = ring.reduce((a, b) => (b[0] < a[0] ? b : a));
    const near = registry.resolve(west[1], west[0] - 0.001); // ~100 m beyond the westernmost vertex
    expect(near).toMatchObject({ inNcr: true, uncertainty: 'near_ncr_boundary', needsManualConfirmation: true });
    expect(BOUNDARY_UNCERTAINTY_M).toBeGreaterThan(100);
    expect(registry.resolve(west[1], west[0] - 0.03).inNcr).toBe(false); // ~3 km beyond
  });

  it.each([
    ['Delhi ↔ Haryana', [28.6315, 77.2167], [28.495, 77.0895], 'delhi', 'haryana'],
    ['Delhi ↔ Uttar Pradesh', [28.6315, 77.2167], [28.627, 77.365], 'delhi', 'uttar-pradesh'],
    ['Haryana ↔ Uttar Pradesh', [28.395, 77.323], [28.4744, 77.504], 'haryana', 'uttar-pradesh'],
  ])('supports cross-state endpoints: %s', (_label, a, b, stateA, stateB) => {
    const ra = registry.resolve(a[0]!, a[1]!);
    const rb = registry.resolve(b[0]!, b[1]!);
    expect([ra.inNcr, rb.inNcr]).toEqual([true, true]);
    expect([ra.state?.id, rb.state?.id]).toEqual([stateA, stateB]);
  });

  it('never treats missing coverage data as negative', () => {
    const r = registry.resolve(28.6315, 77.2167);
    expect(r.coverage.level).toBe('unknown');
    expect(r.coverage.summary).toMatch(/not a sign that an area is unsafe/);
  });
});

describe('registry search', () => {
  it('finds neighbourhoods, aliases and districts', () => {
    expect(registry.search('cyber', 5)[0]).toMatchObject({ label: 'Cyber City', kind: 'neighbourhood', stateName: 'Haryana' });
    expect(registry.search('gurgaon', 5).map((r) => r.label)).toContain('Gurugram');
    expect(registry.search('rajiv chowk', 5)[0]?.label).toBe('Connaught Place');
    expect(registry.search('alwar', 5).some((r) => r.kind === 'district')).toBe(true);
    expect(registry.search('xyzzy', 5)).toEqual([]);
  });

  it('every search result point resolves inside NCR', () => {
    for (const q of ['delhi', 'noida', 'sector', 'ghaziabad', 'road']) {
      for (const r of registry.search(q, 15)) expect(registry.resolve(r.lat, r.lng).inNcr).toBe(true);
    }
  });
});

describe('geography seeder', () => {
  it('is idempotent', () => {
    const before = (db.prepare('SELECT COUNT(*) AS n FROM neighbourhoods').get() as { n: number }).n;
    expect(seedGeography(db, geoData())).toEqual({ districts: false, places: false });
    expect((db.prepare('SELECT COUNT(*) AS n FROM neighbourhoods').get() as { n: number }).n).toBe(before);
  });

  it('rejects a curated place declared in the wrong state', () => {
    const fresh = openDatabase(':memory:');
    runMigrations(fresh, MIGRATIONS_DIR);
    const data = structuredClone(geoData());
    data.places.neighbourhoods[0] = { ...data.places.neighbourhoods[0]!, state: 'haryana' };
    expect(() => seedGeography(fresh, data)).toThrow(GeoDataError);
    // The failed load left nothing half-written.
    expect((fresh.prepare('SELECT COUNT(*) AS n FROM districts').get() as { n: number }).n).toBe(0);
  });

  it('deactivates places removed from a newer gazetteer version without deleting them', () => {
    const fresh = openDatabase(':memory:');
    runMigrations(fresh, MIGRATIONS_DIR);
    seedGeography(fresh, geoData());
    const data = structuredClone(geoData());
    const removed = data.places.neighbourhoods.pop()!;
    data.places.version = `${data.places.version}-next`;
    seedGeography(fresh, data);
    const row = fresh.prepare('SELECT is_active FROM neighbourhoods WHERE id = ?').get(removed.id) as { is_active: number };
    expect(row.is_active).toBe(0);
  });
});
