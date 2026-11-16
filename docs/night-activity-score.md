# Night Activity Score: methodology

The Night Activity Score is a **contextual** 0–100 score for how active a route is likely to be at the
time you travel. It is **not** a crime prediction, a safety probability or a guarantee. The app shows
this disclaimer with every result.

Code: `server/src/services/scoring/` (pure functions, unit-tested in `tests/unit/scoring.test.ts`).

## Inputs

| Data | Source | Notes |
|---|---|---|
| Routes | Geoapify Routing, with `route_details` and `instruction_details` | Geoapify documents no "alternatives" parameter. Alternatives are its documented route `type` values (`balanced`, `short`, plus `less_maneuvers` for driving). Near-identical variants are merged (length within 3% and ≥90% overlap within 60 m) |
| Establishments, transit, assistance | Geoapify Places (OpenStreetMap data), per ~2 km grid cell | Two queries per cell: amenities, and transit separately (combined queries crowded transit out). Cached 7 days, with the fetch time shown |
| Opening hours | OSM `opening_hours`, evaluated with `opening_hours@3.15` in **IST** at the time you pass each place | Departure time + share of the route covered × duration. Missing or unparseable hours are **unknown**, never open |
| Cameras | OpenStreetMap `man_made=surveillance` via Overpass | Public servers are often down. Short timeouts, a mirror fallback, and a 10-minute back-off after failures. Whether a camera works is unknown |
| Community Pulse | Not live until Phase 4 | Cold start: neutral 0.5, low confidence, labelled "Insufficient community data" |

Observed on 2026-11-12: in a 2.5 km² area of Saket, 205 establishments are mapped but only 24 (12%)
have opening hours. Opening-hours coverage is the biggest data gap, and the app says so on each route.

## Factors

| Factor | Weight | Score (0–1) | Unknown when | Confidence |
|---|---|---|---|---|
| Open establishments | 0.22 | `1 − e^(−openPerKm / 2.5)`, counting only places verified open within 80 m | Place data unavailable, none mapped, or no hours known | High if ≥50% have known hours and ≥8 known; medium if ≥25% and ≥3; else low |
| Public transport | 0.10 | `1 − e^(−(2·metro + bus)/km / 1.5)` within 150 m | Place data unavailable | Low (no verified night schedules) |
| Main road coverage | 0.16 | Share of known-class distance on motorway, trunk, primary or secondary roads | Road class unknown for >50% | High if ≥90% known, else medium |
| Longest low-activity stretch | 0.20 | `1 / (1 + (gap/half)²)`, where half = 500 m walking or 2 km driving. A gap is a stretch with no mapped establishment, stop or facility within 100 m, from start to end | Place data unavailable | Medium |
| Route simplicity | 0.07 | `1 / (1 + (turnsPerKm/3)²)` | No instructions (synthetic route) | High |
| Assistance infrastructure | 0.10 | `1 − e^(−(police + hospital + 0.5·fuel)/km / 0.6)` within 300 m | Place data unavailable | Medium (staffing not verified) |
| Mapped cameras | 0.05 | `1 − e^(−cameras/km / 2)` within 50 m | Overpass unavailable | Low |
| Community Pulse | 0.10 | 0.5 (cold start) | Never | Low |

**Preferences.** "Prefer fewer isolated stretches" and "Prefer main roads" multiply that factor's weight
by 1.5, then all weights are renormalised to sum to 1.

## Combining

1. Unknown factors are **excluded**. The remaining weights are scaled up proportionally, so a missing
   factor is never treated as zero.
2. Score = `100 × Σ(wᵢ·sᵢ) / Σ(wᵢ known)`, rounded.
3. If known factors other than Community Pulse carry less than 40% of the weight, **no score is shown**:
   "Not enough information to score this route".
4. Confidence value = `Σ(wᵢ known × cᵢ)`, with high = 1, medium = 0.7, low = 0.4. Unknown factors add 0.
   The label is high if ≥0.70, medium if ≥0.45, else low. It falls with every missing or weak factor.

## Explanations and rankings

- **Reasons** compare each route with the mean of its alternatives, factor by factor, wherever the
  difference is ≥0.08. They are ordered by difference × weight.
- Duration differences are added to the reasons. A route with no alternative instead shows its strongest
  factors with their plain values.
- Data caveats always follow: low opening-hours coverage, and any factor not counted.
- **Rankings:**
  - highest score;
  - fastest;
  - balanced (70% score + 30% speed relative to the fastest route).

## Cross-city and cross-state journeys

A route is one journey regardless of borders. It is sampled every 1 km and resolved against the NCR
registry to list the districts and states it passes through. Planning requires both endpoints inside NCR.
