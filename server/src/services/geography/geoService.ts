import type { GeoSearchResponse, ReverseResponse } from '@mahilasathi/shared';
import type { Logger } from 'pino';
import type { GeoRegistry } from './geoRegistry.js';
import { ProviderError, type GeocodingProvider } from './providers/types.js';

const REGISTRY_PROVIDER = { name: 'local-gazetteer', mode: 'dev-adapter' as const };

/**
 * Geocoding facade. With a live provider, results come from it, are filtered to NCR by polygon and
 * merged after matching registry neighbourhoods. Without one (or when it fails), the local NCR
 * gazetteer answers and the response says so; it is never presented as live address search.
 */
export function createGeoService(deps: { registry: GeoRegistry; provider: GeocodingProvider | null; logger: Logger }) {
  const { registry, provider, logger } = deps;

  return {
    async search(q: string, limit: number): Promise<GeoSearchResponse> {
      const local = registry.search(q, limit);
      if (!provider) {
        return { results: local, provider: REGISTRY_PROVIDER, outsideNcrHidden: 0, degraded: false };
      }
      try {
        const places = await provider.search(q, { limit });
        let outsideNcrHidden = 0;
        const remote: GeoSearchResponse['results'] = [];
        for (const p of places) {
          const r = registry.resolve(p.lat, p.lng);
          if (!r.inNcr) {
            outsideNcrHidden++;
            continue;
          }
          remote.push({
            id: p.id,
            label: p.label,
            secondary: p.secondary,
            lat: p.lat,
            lng: p.lng,
            kind: p.kind,
            source: 'geoapify',
            neighbourhoodId: r.neighbourhood?.id ?? null,
            districtId: r.district?.id ?? null,
            stateName: r.state?.name ?? null,
          });
        }
        const localNeighbourhoods = local.filter((l) => l.kind === 'neighbourhood').slice(0, 3);
        return {
          results: [...localNeighbourhoods, ...remote].slice(0, limit),
          provider: { name: provider.name, mode: provider.mode },
          outsideNcrHidden,
          degraded: false,
        };
      } catch (err) {
        if (!(err instanceof ProviderError)) throw err;
        logger.warn({ provider: err.provider, reason: err.message }, 'geocoding provider failed; using local gazetteer');
        return { results: local, provider: REGISTRY_PROVIDER, outsideNcrHidden: 0, degraded: true };
      }
    },

    async reverse(lat: number, lng: number): Promise<ReverseResponse> {
      const resolution = registry.resolve(lat, lng);
      const fallbackLabel =
        resolution.neighbourhood?.name ?? resolution.city?.name ?? resolution.district?.name ?? null;
      if (!provider || !resolution.inNcr) {
        return { label: fallbackLabel, resolution, provider: provider ? { name: provider.name, mode: provider.mode } : REGISTRY_PROVIDER, degraded: false };
      }
      try {
        const place = await provider.reverse(lat, lng);
        return {
          label: place?.label ?? fallbackLabel,
          resolution,
          provider: { name: provider.name, mode: provider.mode },
          degraded: false,
        };
      } catch (err) {
        if (!(err instanceof ProviderError)) throw err;
        logger.warn({ provider: err.provider, reason: err.message }, 'reverse geocoding failed; using registry label');
        return { label: fallbackLabel, resolution, provider: REGISTRY_PROVIDER, degraded: true };
      }
    },
  };
}

export type GeoService = ReturnType<typeof createGeoService>;
