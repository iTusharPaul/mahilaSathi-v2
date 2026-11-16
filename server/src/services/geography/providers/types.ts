/** A geocoding provider. Implementations must not leak their API keys into results or errors. */
export interface GeocodingProvider {
  readonly name: string;
  readonly mode: 'live' | 'dev-adapter';
  search(query: string, options: { limit: number }): Promise<ProviderPlace[]>;
  reverse(lat: number, lng: number): Promise<ProviderPlace | null>;
}

export interface ProviderPlace {
  id: string;
  label: string;
  secondary: string | null;
  lat: number;
  lng: number;
  kind: 'address' | 'place' | 'neighbourhood' | 'city' | 'district';
}

/** Raised when an external provider fails; callers degrade to the local registry. */
export class ProviderError extends Error {
  constructor(
    readonly provider: string,
    message: string,
  ) {
    super(message);
    this.name = 'ProviderError';
  }
}

export type FetchLike = (url: string, init?: { signal?: AbortSignal; headers?: Record<string, string> }) => Promise<{
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}>;
