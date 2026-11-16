# NCR geography: data sources, resolution and coverage

## What "NCR" means here

The supported region is the **officially notified National Capital Region**, as listed by the NCR Planning Board
([ncrpb.nic.in/ncrconstituent.html](https://ncrpb.nic.in/ncrconstituent.html), checked 2026-11-12):

| State | Constituent districts | Official area |
|---|---|---|
| NCT of Delhi | Whole territory | 1,483 km² |
| Haryana | Faridabad, Gurugram, Nuh, Rohtak, Sonipat, Rewari, Jhajjar, Panipat, Palwal, Bhiwani, Charkhi Dadri, Mahendragarh, Jind, Karnal | 25,327 km² |
| Uttar Pradesh | Meerut, Ghaziabad, Gautam Buddh Nagar, Bulandshahr, Baghpat, Hapur, Shamli, Muzaffarnagar | 14,826 km² |
| Rajasthan | Alwar, Bharatpur | 13,447 km² |

The list lives in code (`server/src/services/geography/ncrConstituents.ts`), not in a UI dropdown. Everything
else is derived from polygons.

## Boundary geometry

| | |
|---|---|
| Source | geoBoundaries gbOpen, India ADM2 (districts), commit `9469f09` |
| Underlying data | Pathways Data Pvt. Ltd., lgdirectory.gov.in; year represented 2021 |
| Licence | Open Data Commons Open Database License 1.0 (ODbL) |
| Source file SHA-256 | recorded in `database/geodata/ncr/manifest.json` and the `boundary_datasets` table |
| Processing | NCR districts selected by name, disambiguated by location; Douglas–Peucker simplification at 30 m; coordinates rounded to 5 decimals |
| Result | 34 polygons, 74,979 → 16,591 vertices, 338 KB |

**Cross-check against official areas.** These figures come from the build pipeline and are stored in the
manifest.

| State | Computed | NCRPB | Difference |
|---|---|---|---|
| Delhi | 1,488 km² | 1,483 km² | +0.3% |
| Haryana | 25,275 km² | 25,327 km² | −0.2% |
| Uttar Pradesh | 15,063 km² | 14,826 km² | +1.6% |
| Rajasthan | 13,398 km² | 13,447 km² | −0.4% |

**Rebuilding.** Download the source GeoJSON into its own folder, then run:

```bash
npx tsx server/src/cli/geo/buildNcrBoundaries.ts <path>/geoBoundaries-IND-ADM2.geojson
```

The build fails if any constituent district is not matched exactly once.

**Known limitations**

- Charkhi Dadri (carved out of Bhiwani in 2016) is not a separate polygon in the source. It is covered by the Bhiwani polygon, labelled "Bhiwani & Charkhi Dadri".
- Alwar is the district as constituted when it was notified as part of NCR. Districts carved out of it in 2023 are not separated.
- Delhi uses the 11 revenue districts present in the source.

## Cities and neighbourhoods

`database/geodata/ncr/places.json` is a **curated gazetteer**. Each entry is an approximate centre point and
radius read from public maps. These are not official locality boundaries, and the product never presents
them as official.

- Neighbourhoods give community identity: the home area, and neighbourhood channels in Phase 2.
- A neighbourhood's district is **derived by point-in-polygon** when the gazetteer is loaded, never typed by hand. Loading stops if a point falls outside NCR or in a different state from the one declared.
- Removing an entry in a newer gazetteer version deactivates it rather than deleting it. Ids are stable, so users' saved home areas survive boundary updates.
- Analytical aggregation (Community Pulse, Phase 4) uses H3 cells, not neighbourhoods.

## Resolving a point

`GET /api/geo/resolve?lat=&lng=` returns state, district, city and neighbourhood, plus an `uncertainty` field.

| Situation | Result |
|---|---|
| Inside a district, more than 300 m from its edge | `uncertainty: none` |
| Inside a district, within 300 m of an edge | `near_district_boundary`; the user is asked to confirm |
| Outside every polygon, but within 300 m of one | `near_ncr_boundary`; treated as NCR, user asked to confirm |
| Further out | `inNcr: false`, with an explanatory message |
| In NCR with no curated neighbourhood nearby | District (and city if known); `neighbourhood: null`. One is never invented |

The UI always offers manual correction: nearby neighbourhoods, a district-only option, or a full list by
district.

## Data coverage

Coverage describes **how much information we have**. It is shown separately from any Night Activity Score.

- Levels: `high`, `medium`, `low`, `unknown`.
- A missing assessment is `unknown`, with the summary "Missing information is not a sign that an area is unsafe."
- The UI styles `unknown` neutrally, never in warning colours.
- **Neighbourhoods are assessed from live place data.** Each curated neighbourhood is checked using the same OpenStreetMap-via-Geoapify places (and 7-day cache) as route scoring, counted within its radius:
  - **High:** at least 40 shops, cafés and similar places per km², with at least 20% having opening hours.
  - **Medium:** at least 15 per km², with at least 8% having opening hours.
  - **Low:** anything less.
- **What the result records:** the counts, the thresholds and the data timestamp, all stored in `coverage_assessments`. The summary says plainly that coverage describes the completeness of map data, not safety.
- **When it runs:**
  - in the background the first time an area is viewed;
  - every 7 days after that;
  - for every neighbourhood, with `npm run coverage:assess`.
- **Districts** are not graded. They are too large to assess consistently, so they stay "not assessed yet".
- **Data quality is shown per route.** Each factor shows its data source, a confidence level (high, medium or low) and when its data was fetched. A factor with no data is marked "Not counted". Opening-hours coverage is shown as "N open of M with known hours".
- **Too little data withholds the score.** If less than 40% of the factor weight has data, no score is given. See [night-activity-score.md](night-activity-score.md).

## Geocoding

| Mode | When | Behaviour |
|---|---|---|
| `geoapify` (live) | `GEOAPIFY_API_KEY` set | Autocomplete restricted to an NCR rectangle, then filtered by polygon. Results outside NCR are counted and hidden. Matching gazetteer neighbourhoods are listed first |
| `local-gazetteer` (development adapter) | No key | Name search over neighbourhoods, cities and districts. The UI says that street-level search is not configured |
| Degraded | Live provider fails or times out (8 s) | Falls back to the gazetteer with `degraded: true`. Errors never include the provider URL or key |
