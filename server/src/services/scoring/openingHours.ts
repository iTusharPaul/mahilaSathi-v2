import OpeningHours from 'opening_hours';

const IST_OFFSET_MIN = 330;

/**
 * opening_hours evaluates a Date in the server's local time zone. Establishments keep Indian time,
 * so we build a Date whose *local* fields equal the IST wall-clock time of the instant.
 */
export function istWallClock(instant: Date): Date {
  const ist = new Date(instant.getTime() + IST_OFFSET_MIN * 60_000);
  return new Date(ist.getUTCFullYear(), ist.getUTCMonth(), ist.getUTCDate(), ist.getUTCHours(), ist.getUTCMinutes(), ist.getUTCSeconds());
}

const NOMINATIM = { lat: 28.6, lon: 77.2, address: { country_code: 'in', state: 'Delhi' } };
const cache = new Map<string, OpeningHours | null>();

/**
 * true/false when the OSM opening_hours value can be evaluated for that instant; null when it is
 * missing, unparseable, or explicitly "unknown" at that time. Never guesses.
 */
export function isOpenAt(openingHours: string | null, instant: Date): boolean | null {
  if (!openingHours) return null;
  let parsed = cache.get(openingHours);
  if (parsed === undefined) {
    try {
      parsed = new OpeningHours(openingHours, NOMINATIM);
    } catch {
      parsed = null;
    }
    if (cache.size > 5000) cache.clear();
    cache.set(openingHours, parsed);
  }
  if (!parsed) return null;
  const local = istWallClock(instant);
  if (parsed.getUnknown(local)) return null;
  return parsed.getState(local);
}
