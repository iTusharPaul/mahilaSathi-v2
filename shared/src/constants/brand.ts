export const BRAND = {
  name: 'mahilaSathi',
  tagline: 'Safer journeys. Stronger together.',
  positioning:
    'Google Maps gets you home fastest. mahilaSathi helps you make a more informed journey and stay accompanied.',
} as const;

/** Shown wherever a score or route insight appears. The product never promises safety. */
export const SAFETY_DISCLAIMER =
  'Night Activity Scores describe available context, not a guarantee of personal safety. In an emergency, call 112.';

export const EMERGENCY_NUMBERS = {
  national: '112',
  women_helpline: '1091',
  women_helpline_national: '181',
} as const;

/**
 * Fictional demo accounts, created only by `npm run demo:seed` with DEMO_MODE=true. The numbers are
 * placeholders: sign-in uses the development OTP adapter, so nothing is ever sent to them.
 */
export const DEMO_ACCOUNTS = [
  { handle: 'Lotus-42', phone: '9000000042', displayName: 'Lotus Demo', role: 'Traveller', homeNeighbourhoodId: 'gurugram-cyber-city' },
  { handle: 'Jasmine-17', phone: '9000000017', displayName: 'Jasmine Demo', role: 'Lotus’s guardian', homeNeighbourhoodId: 'delhi-saket' },
  { handle: 'Neem-08', phone: '9000000008', displayName: 'Neem Demo', role: 'Walking companion', homeNeighbourhoodId: 'delhi-saket' },
] as const;
