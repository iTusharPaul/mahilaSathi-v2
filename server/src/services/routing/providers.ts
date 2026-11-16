import { z } from 'zod';
import type { LngLat, TravelMode } from '@mahilasathi/shared';
import { ProviderError, type FetchLike } from '../geography/providers/types.js';
import type { PlaceKind, PlaceRecord, RouteCandidate } from '../scoring/types.js';

// ─── Routing ──────────────────────────────────────────────────────────────────

/** The provider answered, but no path exists between the points for this mode (not an outage). */
export class NoRouteError extends ProviderError {
  constructor(provider: string) {
    super(provider, 'No route found between these points');
    this.name = 'NoRouteError';
  }
}

export interface RoutingProvider {
  readonly name: string;
  readonly mode: 'live' | 'dev-adapter';
  /** Route variants to request for a travel mode. */
  variants(mode: TravelMode): { variant: string; label: string }[];
  route(origin: LngLat, destination: LngLat, mode: TravelMode, variant: string): Promise<RouteCandidate>;
}

/**
 * Geoapify does not document an "alternatives" parameter, so alternatives come from its documented
 * route `type` values. `less_maneuvers` is only valid for motorised modes.
 */
const VARIANTS: Record<TravelMode, { variant: string; label: string }[]> = {
  drive: [
    { variant: 'balanced', label: 'Recommended by routing' },
    { variant: 'short', label: 'Shortest distance' },
    { variant: 'less_maneuvers', label: 'Fewest manoeuvres' },
  ],
  walk: [
    { variant: 'balanced', label: 'Recommended by routing' },
    { variant: 'short', label: 'Shortest distance' },
  ],
};

const stepSchema = z
  .object({
    from_index: z.number(),
    to_index: z.number(),
    distance: z.number(),
    road_class: z.string().optional(),
    instruction: z.object({ type: z.string().optional() }).passthrough().optional(),
  })
  .passthrough();
const routingResponse = z.object({
  features: z
    .array(
      z.object({
        geometry: z.object({ type: z.literal('MultiLineString'), coordinates: z.array(z.array(z.tuple([z.number(), z.number()]))) }),
        properties: z.object({ distance: z.number(), time: z.number(), legs: z.array(z.object({ steps: z.array(stepSchema) }).passthrough()) }).passthrough(),
      }),
    )
    .min(1),
});

/** Flattens Geoapify legs into one coordinate list, shifting each leg's step indices accordingly. */
export function normaliseGeoapifyRoute(body: unknown, variant: string, label: string): RouteCandidate {
  const parsed = routingResponse.safeParse(body);
  if (!parsed.success) throw new ProviderError('geoapify', 'Geoapify returned an unexpected route');
  const feature = parsed.data.features[0]!;
  const coordinates: LngLat[] = [];
  const steps: RouteCandidate['steps'] = [];
  feature.geometry.coordinates.forEach((legCoords, legIndex) => {
    const offset = coordinates.length;
    coordinates.push(...(legCoords as LngLat[]));
    for (const s of feature.properties.legs[legIndex]?.steps ?? []) {
      steps.push({
        fromIndex: s.from_index + offset,
        toIndex: s.to_index + offset,
        distanceM: s.distance,
        roadClass: s.road_class ?? null,
        instructionType: s.instruction?.type ?? null,
      });
    }
  });
  return { variant, label, synthetic: false, distanceM: feature.properties.distance, durationS: feature.properties.time, coordinates, steps };
}

export function createGeoapifyRouting(apiKey: string, fetchImpl: FetchLike = fetch as unknown as FetchLike): RoutingProvider {
  return {
    name: 'geoapify',
    mode: 'live',
    variants: (mode) => VARIANTS[mode],
    async route(origin, destination, mode, variant) {
      const params = new URLSearchParams({
        waypoints: `${origin[1]},${origin[0]}|${destination[1]},${destination[0]}`,
        mode,
        type: variant,
        details: 'route_details,instruction_details',
        format: 'geojson',
        apiKey,
      });
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 15_000);
      try {
        const res = await fetchImpl(`https://api.geoapify.com/v1/routing?${params}`, { signal: controller.signal });
        if (res.status === 400) {
          const body = (await res.json().catch(() => null)) as { message?: string } | null;
          if (/no path could be found/i.test(body?.message ?? '')) throw new NoRouteError('geoapify');
        }
        if (!res.ok) throw new ProviderError('geoapify', `Geoapify routing responded with HTTP ${res.status}`);
        return normaliseGeoapifyRoute(await res.json(), variant, VARIANTS[mode].find((v) => v.variant === variant)?.label ?? variant);
      } catch (err) {
        if (err instanceof ProviderError) throw err;
        throw new ProviderError('geoapify', controller.signal.aborted ? 'Geoapify routing timed out' : 'Geoapify routing request failed');
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

/**
 * Development adapter for when no routing key is configured: a straight line between the endpoints,
 * marked `synthetic`. It has no road classes or turns, so those factors are unknown. The UI labels it
 * as synthetic; it is never shown as real road data.
 */
export function createSyntheticRouting(): RoutingProvider {
  const SPEED = { walk: 1.2, drive: 7 }; // m/s, deliberately rough
  return {
    name: 'synthetic',
    mode: 'dev-adapter',
    variants: () => [{ variant: 'synthetic', label: 'Synthetic straight-line route' }],
    async route(origin, destination, mode, variant) {
      const n = 40;
      const coordinates: LngLat[] = Array.from({ length: n + 1 }, (_, i) => [
        origin[0] + ((destination[0] - origin[0]) * i) / n,
        origin[1] + ((destination[1] - origin[1]) * i) / n,
      ]);
      const R = 6_371_008.8;
      const rad = Math.PI / 180;
      const dLat = (destination[1] - origin[1]) * rad;
      const dLng = (destination[0] - origin[0]) * rad * Math.cos(((origin[1] + destination[1]) / 2) * rad);
      const distanceM = Math.round(Math.hypot(dLat, dLng) * R * 1.3);
      return {
        variant,
        label: 'Synthetic straight-line route',
        synthetic: true,
        distanceM,
        durationS: Math.round(distanceM / SPEED[mode]),
        coordinates,
        steps: [{ fromIndex: 0, toIndex: n, distanceM, roadClass: null, instructionType: null }],
      };
    },
  };
}

// ─── Places ───────────────────────────────────────────────────────────────────

export type PlaceLayer = 'amenities' | 'transit';
export const PLACE_LAYER_CATEGORIES: Record<PlaceLayer, string> = {
  amenities:
    'catering.restaurant,catering.cafe,catering.fast_food,commercial.convenience,commercial.supermarket,healthcare.pharmacy,service.vehicle.fuel,accommodation.hotel,service.police,healthcare.hospital',
  // Queried separately: in a combined query transit features were crowded out entirely (observed 2026-11-12).
  transit: 'public_transport.subway,public_transport.subway.entrance,public_transport.train,public_transport.bus',
};
const PAGE_LIMIT = 500;

export function placeKind(categories: string[]): PlaceKind | null {
  const has = (prefix: string) => categories.some((c) => c === prefix || c.startsWith(`${prefix}.`));
  if (has('service.police')) return 'police';
  if (has('healthcare.hospital')) return 'hospital';
  if (has('healthcare.pharmacy') || has('commercial.health_and_beauty.pharmacy')) return 'pharmacy';
  if (has('service.vehicle.fuel') || has('commercial.gas')) return 'fuel';
  if (has('accommodation.hotel')) return 'hotel';
  if (has('public_transport.subway') || has('public_transport.train')) return 'metro';
  if (has('public_transport.bus')) return 'bus';
  if (has('catering')) return 'food';
  if (has('commercial.convenience') || has('commercial.supermarket')) return 'shop';
  return null;
}

// Validated per feature: one odd record (e.g. a shop whose name is the number 24) must not discard a whole area.
const placeFeature = z.object({
      properties: z
        .object({
          place_id: z.union([z.string(), z.number()]).transform(String).optional(),
          name: z.union([z.string(), z.number()]).transform(String).optional(),
          lat: z.number(),
          lon: z.number(),
          categories: z.array(z.string()).default([]),
          opening_hours: z.string().optional(),
          datasource: z.object({ raw: z.record(z.unknown()).optional() }).passthrough().optional(),
        })
        .passthrough(),
});
const placesResponse = z.object({ features: z.array(z.unknown()) });

export interface PlacesProvider {
  readonly name: string;
  fetchCell(bbox: { minLng: number; minLat: number; maxLng: number; maxLat: number }, layer: PlaceLayer): Promise<{ places: PlaceRecord[]; truncated: boolean }>;
}

export function createGeoapifyPlaces(apiKey: string, fetchImpl: FetchLike = fetch as unknown as FetchLike): PlacesProvider {
  return {
    name: 'geoapify-places',
    async fetchCell(b, layer) {
      const params = new URLSearchParams({
        categories: PLACE_LAYER_CATEGORIES[layer],
        filter: `rect:${b.minLng},${b.minLat},${b.maxLng},${b.maxLat}`,
        limit: String(PAGE_LIMIT),
        apiKey,
      });
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 15_000);
      try {
        const res = await fetchImpl(`https://api.geoapify.com/v2/places?${params}`, { signal: controller.signal });
        if (!res.ok) throw new ProviderError('geoapify', `Geoapify places responded with HTTP ${res.status}`);
        const parsed = placesResponse.safeParse(await res.json());
        if (!parsed.success) throw new ProviderError('geoapify', 'Geoapify returned unexpected place data');
        const places: PlaceRecord[] = [];
        for (const raw of parsed.data.features) {
          const f = placeFeature.safeParse(raw);
          if (!f.success) continue;
          const p = f.data.properties;
          const kind = placeKind(p.categories);
          if (!kind) continue;
          const rawHours = p.datasource?.raw?.opening_hours;
          places.push({
            id: p.place_id ?? `${p.lat},${p.lon}`,
            name: p.name ?? null,
            kind,
            lat: p.lat,
            lng: p.lon,
            openingHours: p.opening_hours ?? (typeof rawHours === 'string' ? rawHours : null),
          });
        }
        return { places, truncated: parsed.data.features.length >= PAGE_LIMIT };
      } catch (err) {
        if (err instanceof ProviderError) throw err;
        throw new ProviderError('geoapify', controller.signal.aborted ? 'Geoapify places timed out' : 'Geoapify places request failed');
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

// ─── Cameras (Overpass) ───────────────────────────────────────────────────────

export interface CameraProvider {
  readonly name: string;
  fetch(bbox: { minLng: number; minLat: number; maxLng: number; maxLat: number }): Promise<{ lat: number; lng: number }[]>;
}

const OVERPASS_ENDPOINTS = ['https://overpass-api.de/api/interpreter', 'https://overpass.kumi.systems/api/interpreter'];
const overpassResponse = z.object({ elements: z.array(z.object({ lat: z.number().optional(), lon: z.number().optional() }).passthrough()) });

/** Public Overpass servers are often busy; short timeouts and a fallback keep planning responsive. */
export function createOverpassCameras(fetchImpl: typeof fetch = fetch, endpoints = OVERPASS_ENDPOINTS, timeoutMs = 6000): CameraProvider {
  return {
    name: 'overpass',
    async fetch(b) {
      const query = `[out:json][timeout:15];node["man_made"="surveillance"](${b.minLat},${b.minLng},${b.maxLat},${b.maxLng});out 2000;`;
      let last = 'no endpoint tried';
      for (const endpoint of endpoints) {
        try {
          const res = await fetchImpl(endpoint, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'mahilaSathi/0.1 (route context)' },
            body: `data=${encodeURIComponent(query)}`,
            signal: AbortSignal.timeout(timeoutMs),
          });
          if (!res.ok) {
            last = `HTTP ${res.status}`;
            continue;
          }
          const parsed = overpassResponse.safeParse(await res.json());
          if (!parsed.success) {
            last = 'unexpected response';
            continue;
          }
          return parsed.data.elements.filter((e) => e.lat !== undefined && e.lon !== undefined).map((e) => ({ lat: e.lat!, lng: e.lon! }));
        } catch (err) {
          last = (err as Error).name === 'TimeoutError' ? 'timed out' : 'request failed';
        }
      }
      throw new ProviderError('overpass', `Overpass unavailable (${last})`);
    },
  };
}
