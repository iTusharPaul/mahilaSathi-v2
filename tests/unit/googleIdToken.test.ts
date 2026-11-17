import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair, type JWTPayload, type KeyLike } from 'jose';
import { beforeAll, describe, expect, it } from 'vitest';
import { GoogleTokenError, createGoogleTokenVerifier, type GoogleTokenVerifier } from '../../server/src/services/auth/googleIdToken.js';

const CLIENT_ID = '123456789012-abcdefghijklmnop.apps.googleusercontent.com';

describe('Google ID token verification', () => {
  let sign: (claims: JWTPayload, opts?: { issuer?: string; audience?: string; expiresIn?: string; key?: KeyLike }) => Promise<string>;
  let verify: GoogleTokenVerifier;
  let otherKey: KeyLike;

  beforeAll(async () => {
    const google = await generateKeyPair('RS256');
    otherKey = (await generateKeyPair('RS256')).privateKey;
    const jwk = { ...(await exportJWK(google.publicKey)), kid: 'google-key-1', alg: 'RS256', use: 'sig' };
    verify = createGoogleTokenVerifier(CLIENT_ID, createLocalJWKSet({ keys: [jwk] }));
    sign = (claims, opts = {}) =>
      new SignJWT(claims)
        .setProtectedHeader({ alg: 'RS256', kid: 'google-key-1' })
        .setIssuer(opts.issuer ?? 'https://accounts.google.com')
        .setAudience(opts.audience ?? CLIENT_ID)
        .setSubject('110169484474386276334')
        .setIssuedAt()
        .setExpirationTime(opts.expiresIn ?? '1h')
        .sign(opts.key ?? google.privateKey);
  });

  it('returns the account id and the verified email, lower-cased', async () => {
    expect(await verify(await sign({ email: 'Asha.Rao@Gmail.com', email_verified: true }))).toEqual({ sub: '110169484474386276334', email: 'asha.rao@gmail.com' });
    // Both issuer spellings Google documents are accepted.
    expect((await verify(await sign({}, { issuer: 'accounts.google.com' }))).sub).toBe('110169484474386276334');
  });

  it('drops an email Google has not verified', async () => {
    expect((await verify(await sign({ email: 'someone@example.com', email_verified: false }))).email).toBeNull();
    expect((await verify(await sign({ email: 'someone@example.com' }))).email).toBeNull();
  });

  it.each([
    ['another app’s token', { audience: '999-other.apps.googleusercontent.com' }],
    ['a token from another issuer', { issuer: 'https://evil.example.com' }],
    ['an expired token', { expiresIn: '-2m' }],
  ])('rejects %s', async (_label, opts) => {
    await expect(verify(await sign({ email: 'a@gmail.com', email_verified: true }, opts))).rejects.toBeInstanceOf(GoogleTokenError);
  });

  it('rejects a token signed with someone else’s key, and garbage', async () => {
    await expect(verify(await sign({}, { key: otherKey }))).rejects.toBeInstanceOf(GoogleTokenError);
    await expect(verify('eyJhbGciOiJSUzI1NiJ9.e30.c2ln')).rejects.toBeInstanceOf(GoogleTokenError);
  });
});
