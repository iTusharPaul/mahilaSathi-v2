import { createRemoteJWKSet, errors, jwtVerify, type JWTVerifyGetKey } from 'jose';

/** What mahilaSathi keeps from a Google sign-in: the stable account id and, if verified, the email. */
export interface GoogleIdentity {
  sub: string;
  email: string | null;
}

/** Checks a Google ID token (the `credential` from Google Identity Services) and returns who it belongs to. */
export type GoogleTokenVerifier = (credential: string) => Promise<GoogleIdentity>;

export class GoogleTokenError extends Error {}

/** Google's published signing keys. jose caches them and refetches when Google rotates keys. */
const GOOGLE_JWKS_URL = new URL('https://www.googleapis.com/oauth2/v3/certs');
const GOOGLE_ISSUERS = ['accounts.google.com', 'https://accounts.google.com'];

/**
 * Verifies the token's signature against Google's keys, that it was issued by Google for THIS app (audience =
 * our OAuth client id), and that it has not expired. See
 * https://developers.google.com/identity/gsi/web/guides/verify-google-id-token
 */
export function createGoogleTokenVerifier(clientId: string, keys: JWTVerifyGetKey = createRemoteJWKSet(GOOGLE_JWKS_URL)): GoogleTokenVerifier {
  return async (credential) => {
    let payload;
    try {
      ({ payload } = await jwtVerify(credential, keys, { issuer: GOOGLE_ISSUERS, audience: clientId, algorithms: ['RS256'], clockTolerance: 30 }));
    } catch (err) {
      if (err instanceof errors.JOSEError) throw new GoogleTokenError(`Google sign-in token rejected (${err.code})`);
      throw err;
    }
    if (typeof payload.sub !== 'string' || payload.sub.length === 0 || payload.sub.length > 255) {
      throw new GoogleTokenError('Google sign-in token has no account id');
    }
    const email = typeof payload.email === 'string' && payload.email_verified === true && payload.email.length <= 254 ? payload.email.toLowerCase() : null;
    return { sub: payload.sub, email };
  };
}
