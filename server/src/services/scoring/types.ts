import type { LngLat } from '@mahilasathi/shared';
import type { TravelMode } from '@mahilasathi/shared';

/** A route as returned by a routing provider, normalised. Coordinates are flattened across legs. */
export interface RouteCandidate {
  variant: string;
  label: string;
  synthetic: boolean;
  distanceM: number;
  durationS: number;
  coordinates: LngLat[];
  /** Index ranges into `coordinates`. roadClass/instructionType are null when the provider gives none. */
  steps: { fromIndex: number; toIndex: number; distanceM: number; roadClass: string | null; instructionType: string | null }[];
}

export type PlaceKind = 'food' | 'shop' | 'pharmacy' | 'fuel' | 'hotel' | 'metro' | 'bus' | 'police' | 'hospital';

export interface PlaceRecord {
  id: string;
  name: string | null;
  kind: PlaceKind;
  lat: number;
  lng: number;
  /** OSM opening_hours string, or null when not mapped. Never assumed open. */
  openingHours: string | null;
}

/** Context for scoring. A null list means the data source was unavailable (unknown), not empty. */
export interface ScoringContext {
  mode: TravelMode;
  departure: Date;
  places: PlaceRecord[] | null;
  placesFetchedAt: string | null;
  cameras: { lat: number; lng: number }[] | null;
  camerasFetchedAt: string | null;
  /** Community Pulse per H3 cell, only for cells with enough distinct contributors. Absent = cold start. */
  pulse?: { sufficient: Map<string, number>; updatedAt: string | null; cellsFor: (geometry: LngLat[]) => string[] };
}

export const ESTABLISHMENT_KINDS: PlaceKind[] = ['food', 'shop', 'pharmacy', 'fuel', 'hotel'];
