/**
 * Builds the committed NCR district dataset from a geoBoundaries IND ADM2 GeoJSON file.
 *
 *   npx tsx server/src/cli/geo/buildNcrBoundaries.ts <path-to-geoBoundaries-IND-ADM2.geojson>
 *
 * Writes database/geodata/ncr/districts.geojson and manifest.json. Fails if any NCR constituent
 * district cannot be matched exactly once, so a changed source can never silently drop coverage.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  bboxContains,
  bboxOf,
  multiPolygonAreaKm2,
  simplifyMultiPolygon,
  type MultiPolygonCoords,
} from '@mahilasathi/shared';
import { REPO_ROOT } from '../../config/paths.js';
import { NCR_CONSTITUENT_DISTRICTS, NCR_SEARCH_WINDOW, NCR_STATES } from '../../services/geography/ncrConstituents.js';

const SOURCE = {
  datasetId: 'geoboundaries-ind-adm2-9469f09',
  name: 'geoBoundaries gbOpen IND ADM2 (districts)',
  publisher: 'geoBoundaries (William & Mary geoLab); underlying data: Pathways Data Pvt. Ltd., lgdirectory.gov.in',
  url: 'https://github.com/wmgeolab/geoBoundaries/raw/9469f09/releaseData/gbOpen/IND/ADM2/geoBoundaries-IND-ADM2.geojson',
  license: 'Open Data Commons Open Database License 1.0 (ODbL)',
  yearRepresented: '2021',
  boundaryId: 'IND-ADM2-76128533',
};
const CONSTITUENTS_SOURCE = {
  name: 'NCR Planning Board: NCR constituent areas',
  url: 'https://ncrpb.nic.in/ncrconstituent.html',
  checkedOn: '2026-11-12',
};
const SIMPLIFY_TOLERANCE_M = 30;

interface SourceFeature {
  properties: { shapeName: string; shapeID: string };
  geometry: { type: 'Polygon' | 'MultiPolygon'; coordinates: unknown };
}

const input = process.argv[2];
if (!input) {
  console.error('Usage: tsx server/src/cli/geo/buildNcrBoundaries.ts <geoBoundaries-IND-ADM2.geojson>');
  process.exit(2);
}

const raw = fs.readFileSync(input);
const sha256 = crypto.createHash('sha256').update(raw).digest('hex');
const fc = JSON.parse(raw.toString('utf8')) as { features: SourceFeature[] };

const asMulti = (g: SourceFeature['geometry']): MultiPolygonCoords =>
  (g.type === 'Polygon' ? [g.coordinates] : g.coordinates) as MultiPolygonCoords;

const problems: string[] = [];
const features: { type: 'Feature'; id: string; properties: { state: string; areaKm2: number } & Record<string, unknown>; geometry: unknown }[] = [];
let sourceVertices = 0;
let outputVertices = 0;

for (const d of NCR_CONSTITUENT_DISTRICTS) {
  const matches = fc.features.filter((f) => {
    if (!d.sourceNames.includes(f.properties.shapeName.trim())) return false;
    const b = bboxOf(asMulti(f.geometry));
    const centre: [number, number] = [(b.minLng + b.maxLng) / 2, (b.minLat + b.maxLat) / 2];
    return bboxContains(NCR_SEARCH_WINDOW, centre);
  });
  if (matches.length !== 1) {
    problems.push(`${d.id}: expected 1 source feature named ${d.sourceNames.join('/')}, found ${matches.length}`);
    continue;
  }
  const src = matches[0]!;
  const multi = asMulti(src.geometry);
  const simplified = simplifyMultiPolygon(multi, SIMPLIFY_TOLERANCE_M);
  for (const p of multi) for (const r of p) sourceVertices += r.length;
  for (const p of simplified) for (const r of p) outputVertices += r.length;

  features.push({
    type: 'Feature',
    id: d.id,
    properties: {
      id: d.id,
      name: d.name,
      state: d.state,
      aliases: d.aliases ?? [],
      includes: d.includes ?? [d.name],
      sourceName: src.properties.shapeName.trim(),
      sourceFeatureId: src.properties.shapeID,
      areaKm2: Math.round(multiPolygonAreaKm2(multi) * 10) / 10,
    },
    geometry: { type: 'MultiPolygon' as const, coordinates: simplified },
  });
}

if (problems.length) {
  console.error(`Could not build the NCR dataset:\n  ${problems.join('\n  ')}`);
  process.exit(1);
}

const stateAreas = NCR_STATES.map((s) => {
  const computed = features.filter((f) => f.properties.state === s.id).reduce((sum, f) => sum + f.properties.areaKm2, 0);
  return {
    state: s.id,
    computedKm2: Math.round(computed),
    ncrpbKm2: s.ncrpbAreaKm2,
    differencePct: Math.round(((computed - s.ncrpbAreaKm2) / s.ncrpbAreaKm2) * 1000) / 10,
  };
});

const outDir = path.join(REPO_ROOT, 'database', 'geodata', 'ncr');
fs.mkdirSync(outDir, { recursive: true });
const geojson = JSON.stringify({ type: 'FeatureCollection', features });
fs.writeFileSync(path.join(outDir, 'districts.geojson'), geojson);

const manifest = {
  datasetId: SOURCE.datasetId,
  version: `${SOURCE.yearRepresented}-9469f09-s${SIMPLIFY_TOLERANCE_M}m`,
  geometry: { ...SOURCE, sourceSha256: sha256, retrievedOn: new Date().toISOString().slice(0, 10) },
  constituents: CONSTITUENTS_SOURCE,
  processing: {
    simplification: `Douglas–Peucker, ${SIMPLIFY_TOLERANCE_M} m tolerance; coordinates rounded to 5 decimals (~1 m)`,
    sourceVertices,
    outputVertices,
    outputSha256: crypto.createHash('sha256').update(geojson).digest('hex'),
  },
  stateAreaCheck: stateAreas,
  knownLimitations: [
    'Charkhi Dadri (carved out of Bhiwani in 2016) is not a separate polygon in the source; it is covered by the Bhiwani polygon.',
    'Alwar is the district as constituted when notified as part of NCR; districts carved out of it in 2023 are not separated.',
    'District edges are simplified; points within a few hundred metres of an edge are reported as near a boundary.',
  ],
};
fs.writeFileSync(path.join(outDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);

console.log(`Wrote ${features.length} districts (${sourceVertices} → ${outputVertices} vertices).`);
console.table(stateAreas);
