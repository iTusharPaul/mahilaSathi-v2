export const API_PREFIX = '/api';

/** Machine-readable error codes returned in the `error.code` field of API responses. */
export const ERROR_CODES = [
  'BAD_REQUEST',
  'VALIDATION_FAILED',
  'UNAUTHENTICATED',
  'FORBIDDEN',
  'NOT_FOUND',
  'CONFLICT',
  'RATE_LIMITED',
  'PAYLOAD_TOO_LARGE',
  'PROVIDER_UNAVAILABLE',
  'NOT_READY',
  'INTERNAL',
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];
