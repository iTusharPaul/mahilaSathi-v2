import { z } from 'zod';
import { ProviderError, type FetchLike, type GeocodingProvider, type ProviderPlace } from './types.js';

const BASE_URL = 'https://api.geoapify.com/v1/geocode';
const TIMEOUT_MS = 8000;

/** Search is restricted to a rectangle around NCR; results are still filtered by polygon afterwards. */
const NCR_RECT = { minLng: 75.4, minLat: 26.7, maxLng: 78.3, maxLat: 30.0 };
const NCR_BIAS = { lng: 77.209, lat: 28.6139 };

const resultSchema = z.object({
  lat: z.number(),
  lon: z.number(),
  formatted: z.string().optional(),
  address_line1: z.string().optional(),
  address_line2: z.string().optional(),
  result_type: z.string().optional(),
  place_id: z.string().optional(),
});
const responseSchema = z.object({ results: z.array(resultSchema) });

const KIND_BY_RESULT_TYPE: Record<string, ProviderPlace['kind']> = {
  building: 'address',
  street: 'address',
  postcode: 'address',
  amenity: 'place',
  suburb: 'neighbourhood',
  district: 'neighbourhood',
  city: 'city',
  county: 'district',
};

export function createGeoapifyGeocoder(apiKey: string, fetchImpl: FetchLike = fetch as unknown as FetchLike): GeocodingProvider {
  async function call(path: string, params: Record<string, string>) {
    const url = `${BASE_URL}/${path}?${new URLSearchParams({ ...params, format: 'json', lang: 'en', apiKey })}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const res = await fetchImpl(url, { signal: controller.signal, headers: { Accept: 'application/json' } });
      if (!res.ok) throw new ProviderError('geoapify', `Geoapify responded with HTTP ${res.status}`);
      const parsed = responseSchema.safeParse(await res.json());
      if (!parsed.success) throw new ProviderError('geoapify', 'Geoapify returned an unexpected response');
      return parsed.data.results;
    } catch (err) {
      if (err instanceof ProviderError) throw err;
      // Never include the URL: it carries the API key.
      throw new ProviderError('geoapify', controller.signal.aborted ? 'Geoapify timed out' : 'Geoapify request failed');
    } finally {
      clearTimeout(timer);
    }
  }

  const toPlace = (r: z.infer<typeof resultSchema>, i: number): ProviderPlace => ({
    id: `geoapify:${r.place_id ?? `${r.lat},${r.lon},${i}`}`,
    label: r.address_line1 ?? r.formatted ?? `${r.lat.toFixed(4)}, ${r.lon.toFixed(4)}`,
    secondary: r.address_line2 ?? null,
    lat: r.lat,
    lng: r.lon,
    kind: KIND_BY_RESULT_TYPE[r.result_type ?? ''] ?? 'place',
  });

  return {
    name: 'geoapify',
    mode: 'live',
    async search(query, { limit }) {
      const results = await call('autocomplete', {
        text: query,
        limit: String(limit),
        filter: `rect:${NCR_RECT.minLng},${NCR_RECT.minLat},${NCR_RECT.maxLng},${NCR_RECT.maxLat}`,
        bias: `proximity:${NCR_BIAS.lng},${NCR_BIAS.lat}`,
      });
      return results.map(toPlace);
    },
    async reverse(lat, lng) {
      const results = await call('reverse', { lat: String(lat), lon: String(lng) });
      return results[0] ? toPlace(results[0], 0) : null;
    },
  };
}
