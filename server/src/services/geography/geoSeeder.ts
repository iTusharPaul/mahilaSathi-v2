import fs from 'node:fs';
import path from 'node:path';
import {
  bboxOf,
  pointInMultiPolygon,
  type LngLat,
  type MultiPolygonCoords,
} from '@mahilasathi/shared';
import { NCR_STATES } from './ncrConstituents.js';
import type { Db } from '../../db/connection.js';

export interface GeoDataFiles {
  manifest: GeoManifest;
  districts: { features: DistrictFeature[] };
  places: PlacesFile;
}

interface GeoManifest {
  datasetId: string;
  version: string;
  geometry: { name: string; publisher: string; url: string; license: string; sourceSha256?: string; retrievedOn?: string };
  constituents: { name: string; url: string; checkedOn: string };
}

interface DistrictFeature {
  properties: {
    id: string;
    name: string;
    state: string;
    aliases: string[];
    includes: string[];
    sourceName: string;
    sourceFeatureId: string;
    areaKm2: number;
  };
  geometry: { type: 'MultiPolygon'; coordinates: MultiPolygonCoords };
}

interface PlacesFile {
  version: string;
  source: string;
  cities: {
    id: string;
    name: string;
    state: string;
    kind: 'districts' | 'circle';
    districts?: string[];
    center?: LngLat;
    radiusM?: number;
    aliases?: string[];
  }[];
  neighbourhoods: {
    id: string;
    name: string;
    city?: string;
    state: string;
    center: LngLat;
    radiusM: number;
    aliases?: string[];
  }[];
}

export class GeoDataError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GeoDataError';
  }
}

export function readGeoDataFiles(dir: string): GeoDataFiles {
  const read = <T>(file: string): T => JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8')) as T;
  return { manifest: read('manifest.json'), districts: read('districts.geojson'), places: read('places.json') };
}

/**
 * Loads the NCR registry. Idempotent: districts are keyed by dataset version and places by
 * gazetteer version, so restarting is a no-op and a new version replaces geometry in place
 * (ids stay stable, so users' home areas survive boundary updates).
 * Every curated point is checked against the district polygons; a mismatch aborts the load.
 */
export function seedGeography(db: Db, data: GeoDataFiles): { districts: boolean; places: boolean } {
  const { manifest, districts, places } = data;
  const placesVersion = `${places.version}+${manifest.version}`;

  const haveDataset = db
    .prepare('SELECT 1 FROM boundary_datasets WHERE id = ? AND version = ? AND is_active = 1')
    .get(manifest.datasetId, manifest.version);
  const havePlaces = db
    .prepare('SELECT 1 FROM neighbourhoods WHERE source_version = ? LIMIT 1')
    .get(placesVersion);
  if (haveDataset && havePlaces) return { districts: false, places: false };

  const featureById = new Map(districts.features.map((f) => [f.properties.id, f]));
  const districtOf = (center: LngLat, label: string, expectedState: string): string => {
    const hits = districts.features.filter((f) => pointInMultiPolygon(center, f.geometry.coordinates));
    if (hits.length === 0) throw new GeoDataError(`${label} is not inside any NCR district polygon`);
    const hit = hits[0]!;
    if (hit.properties.state !== expectedState) {
      throw new GeoDataError(`${label} is declared in ${expectedState} but falls in ${hit.properties.id}`);
    }
    return hit.properties.id;
  };

  const tx = db.transaction(() => {
    if (!haveDataset) {
      db.prepare('UPDATE boundary_datasets SET is_active = 0').run();
      db.prepare(
        `INSERT INTO boundary_datasets (id, name, publisher, source_url, license, version, source_sha256, retrieved_on, manifest_json, is_active)
         VALUES (@id, @name, @publisher, @url, @license, @version, @sha, @retrieved, @manifest, 1)
         ON CONFLICT (id) DO UPDATE SET version = excluded.version, source_sha256 = excluded.source_sha256,
           retrieved_on = excluded.retrieved_on, manifest_json = excluded.manifest_json, is_active = 1,
           loaded_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`,
      ).run({
        id: manifest.datasetId,
        name: manifest.geometry.name,
        publisher: manifest.geometry.publisher,
        url: manifest.geometry.url,
        license: manifest.geometry.license,
        version: manifest.version,
        sha: manifest.geometry.sourceSha256 ?? null,
        retrieved: manifest.geometry.retrievedOn ?? null,
        manifest: JSON.stringify(manifest),
      });

      const upsertState = db.prepare(
        `INSERT INTO states (id, name, code, official_ncr_area_km2) VALUES (?, ?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET name = excluded.name, code = excluded.code, official_ncr_area_km2 = excluded.official_ncr_area_km2`,
      );
      for (const s of NCR_STATES) upsertState.run(s.id, s.name, s.code, s.ncrpbAreaKm2);

      const upsertDistrict = db.prepare(
        `INSERT INTO districts (id, state_id, dataset_id, name, aliases_json, includes_json, source_name, source_feature_id,
           geometry_json, min_lat, min_lng, max_lat, max_lng, area_km2, is_active)
         VALUES (@id, @state, @dataset, @name, @aliases, @includes, @sourceName, @sourceFeatureId,
           @geometry, @minLat, @minLng, @maxLat, @maxLng, @area, 1)
         ON CONFLICT (id) DO UPDATE SET state_id = excluded.state_id, dataset_id = excluded.dataset_id, name = excluded.name,
           aliases_json = excluded.aliases_json, includes_json = excluded.includes_json, source_name = excluded.source_name,
           source_feature_id = excluded.source_feature_id, geometry_json = excluded.geometry_json,
           min_lat = excluded.min_lat, min_lng = excluded.min_lng, max_lat = excluded.max_lat, max_lng = excluded.max_lng,
           area_km2 = excluded.area_km2, is_active = 1, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`,
      );
      const allBox = { minLat: Infinity, minLng: Infinity, maxLat: -Infinity, maxLng: -Infinity };
      let totalArea = 0;
      for (const f of districts.features) {
        const b = bboxOf(f.geometry.coordinates);
        allBox.minLat = Math.min(allBox.minLat, b.minLat);
        allBox.minLng = Math.min(allBox.minLng, b.minLng);
        allBox.maxLat = Math.max(allBox.maxLat, b.maxLat);
        allBox.maxLng = Math.max(allBox.maxLng, b.maxLng);
        totalArea += f.properties.areaKm2;
        upsertDistrict.run({
          id: f.properties.id,
          state: f.properties.state,
          dataset: manifest.datasetId,
          name: f.properties.name,
          aliases: JSON.stringify(f.properties.aliases),
          includes: JSON.stringify(f.properties.includes),
          sourceName: f.properties.sourceName,
          sourceFeatureId: f.properties.sourceFeatureId,
          geometry: JSON.stringify(f.geometry.coordinates),
          ...b,
          area: f.properties.areaKm2,
        });
      }
      const ids = districts.features.map((f) => f.properties.id);
      db.prepare(
        `UPDATE districts SET is_active = 0 WHERE id NOT IN (SELECT value FROM json_each(?))`,
      ).run(JSON.stringify(ids));

      db.prepare(
        `INSERT INTO ncr_boundaries (id, dataset_id, name, constituents_source, constituents_checked, district_ids_json,
           min_lat, min_lng, max_lat, max_lng, area_km2)
         VALUES ('ncr', @dataset, 'National Capital Region', @src, @checked, @ids, @minLat, @minLng, @maxLat, @maxLng, @area)
         ON CONFLICT (id) DO UPDATE SET dataset_id = excluded.dataset_id, constituents_source = excluded.constituents_source,
           constituents_checked = excluded.constituents_checked, district_ids_json = excluded.district_ids_json,
           min_lat = excluded.min_lat, min_lng = excluded.min_lng, max_lat = excluded.max_lat, max_lng = excluded.max_lng,
           area_km2 = excluded.area_km2, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`,
      ).run({
        dataset: manifest.datasetId,
        src: manifest.constituents.url,
        checked: manifest.constituents.checkedOn,
        ids: JSON.stringify(ids),
        ...allBox,
        area: Math.round(totalArea),
      });
    }

    // Cities and neighbourhoods (re-derived whenever either source version changes).
    const upsertCity = db.prepare(
      `INSERT INTO cities (id, state_id, district_id, name, aliases_json, kind, district_ids_json, center_lat, center_lng, radius_m, source, is_active)
       VALUES (@id, @state, @district, @name, @aliases, @kind, @districtIds, @lat, @lng, @radius, @source, 1)
       ON CONFLICT (id) DO UPDATE SET state_id = excluded.state_id, district_id = excluded.district_id, name = excluded.name,
         aliases_json = excluded.aliases_json, kind = excluded.kind, district_ids_json = excluded.district_ids_json,
         center_lat = excluded.center_lat, center_lng = excluded.center_lng, radius_m = excluded.radius_m,
         source = excluded.source, is_active = 1, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`,
    );
    for (const c of places.cities) {
      if (c.kind === 'districts') {
        for (const d of c.districts ?? []) {
          if (featureById.get(d)?.properties.state !== c.state) throw new GeoDataError(`City ${c.id} lists unknown district ${d}`);
        }
      }
      upsertCity.run({
        id: c.id,
        state: c.state,
        district: c.kind === 'circle' ? districtOf(c.center!, `City ${c.id}`, c.state) : null,
        name: c.name,
        aliases: JSON.stringify(c.aliases ?? []),
        kind: c.kind,
        districtIds: c.kind === 'districts' ? JSON.stringify(c.districts) : null,
        lat: c.center?.[1] ?? null,
        lng: c.center?.[0] ?? null,
        radius: c.radiusM ?? null,
        source: places.source,
      });
    }

    const cityIds = new Set(places.cities.map((c) => c.id));
    const upsertNeighbourhood = db.prepare(
      `INSERT INTO neighbourhoods (id, name, aliases_json, state_id, district_id, city_id, center_lat, center_lng, radius_m, source, source_version, is_active)
       VALUES (@id, @name, @aliases, @state, @district, @city, @lat, @lng, @radius, @source, @version, 1)
       ON CONFLICT (id) DO UPDATE SET name = excluded.name, aliases_json = excluded.aliases_json, state_id = excluded.state_id,
         district_id = excluded.district_id, city_id = excluded.city_id, center_lat = excluded.center_lat,
         center_lng = excluded.center_lng, radius_m = excluded.radius_m, source = excluded.source,
         source_version = excluded.source_version, is_active = 1, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`,
    );
    for (const n of places.neighbourhoods) {
      if (n.city && !cityIds.has(n.city)) throw new GeoDataError(`Neighbourhood ${n.id} references unknown city ${n.city}`);
      upsertNeighbourhood.run({
        id: n.id,
        name: n.name,
        aliases: JSON.stringify(n.aliases ?? []),
        state: n.state,
        district: districtOf(n.center, `Neighbourhood ${n.id}`, n.state),
        city: n.city ?? null,
        lat: n.center[1],
        lng: n.center[0],
        radius: n.radiusM,
        source: places.source,
        version: placesVersion,
      });
    }
    // Entries removed from the gazetteer are deactivated, never deleted: users may reference them.
    db.prepare('UPDATE neighbourhoods SET is_active = 0 WHERE source_version != ?').run(placesVersion);
  });
  tx();
  return { districts: !haveDataset, places: true };
}
