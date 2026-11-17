import crypto from 'node:crypto';
import { OTP_LENGTH, maskPhone, type SendOtpResponse } from '@mahilasathi/shared';
import type { AuthRepository } from '../../repositories/authRepository.js';
import type { AuditRepository } from '../../repositories/auditRepository.js';
import type { UserRepository, UserRow } from '../../repositories/userRepository.js';
import { AppError } from '../../utils/errors.js';
import { hmacHex, randomNumericCode, randomToken, safeEqualHex, sha256Hex, type Clock } from '../../utils/crypto.js';
import { generateCommunityHandle } from '../users/communityHandle.js';
import { GoogleTokenError, type GoogleTokenVerifier } from './googleIdToken.js';
import type { OtpProvider } from './otpProvider.js';

export const OTP_POLICY = {
  ttlMs: 5 * 60_000,
  maxAttempts: 5,
  resendCooldownMs: 30_000,
  windowMs: 15 * 60_000,
  maxSendsPerWindow: 3,
} as const;
export const SESSION_TTL_MS = 30 * 24 * 60 * 60_000;
const TOUCH_INTERVAL_MS = 5 * 60_000;

const INVALID_CODE = 'This code is no longer valid. Request a new code.';

export interface AuthDeps {
  authRepo: AuthRepository;
  users: UserRepository;
  audit: AuditRepository;
  otpProvider: OtpProvider;
  secret: string;
  clock: Clock;
  /**
   * Fictional demo numbers shared by everyone trying a demo server (DEMO_MODE only). Several people may sign in
   * to them at once, so they skip the per-number resend limits and don't cancel each other's codes. The per-IP
   * limit still applies.
   */
  sharedDemoPhones?: ReadonlySet<string>;
  /** Sign in with Google, when GOOGLE_CLIENT_ID is configured. */
  googleVerifier?: GoogleTokenVerifier | null;
  /**
   * When set, phone sign-in is limited to these numbers. Used when Google sign-in is on and the OTP provider is
   * the on-screen development adapter: real people sign in with Google, phone codes stay for the demo accounts.
   */
  phoneSignInOnlyFor?: ReadonlySet<string>;
}

export interface AuthenticatedSession {
  user: UserRow;
  sessionId: string;
}

export function createAuthService(deps: AuthDeps) {
  const { authRepo, users, audit, otpProvider, secret, clock } = deps;
  const codeHash = (otpSessionId: string, code: string) => hmacHex(secret, `otp:${otpSessionId}:${code}`);
  const tokenHash = (token: string) => sha256Hex(`session:${secret}:${token}`);

  /** Issues a session cookie token; only its hash is stored. */
  function startSession(user: UserRow, now: Date, ctx: { userAgent?: string; requestId?: string }, method: 'phone' | 'google') {
    const nowIso = now.toISOString();
    const token = randomToken(32);
    const expiresAt = new Date(now.getTime() + SESSION_TTL_MS);
    const sessionId = crypto.randomUUID();
    authRepo.insertUserSession({
      id: sessionId,
      user_id: user.id,
      token_hash: tokenHash(token),
      user_agent: ctx.userAgent?.slice(0, 200) ?? null,
      created_at: nowIso,
      last_seen_at: nowIso,
      expires_at: expiresAt.toISOString(),
    });
    audit.record({ actorType: 'user', actorId: user.id, action: 'auth.login', targetType: 'session', targetId: sessionId, metadata: { method }, requestId: ctx.requestId ?? null });
    return { token, expiresAt };
  }

  return {
    async sendOtp(phone: string, ctx: { requestId?: string } = {}): Promise<SendOtpResponse> {
      if (deps.phoneSignInOnlyFor && !deps.phoneSignInOnlyFor.has(phone)) {
        throw new AppError('FORBIDDEN', 'On this server, phone sign-in is only for the demo accounts. Continue with Google instead.');
      }
      const now = clock();
      const shared = deps.sharedDemoPhones?.has(phone) ?? false;
      const recent = shared ? [] : authRepo.recentOtpSessions(phone, new Date(now.getTime() - OTP_POLICY.windowMs).toISOString());

      const last = recent[0];
      if (last) {
        const waitMs = Date.parse(last.created_at) + OTP_POLICY.resendCooldownMs - now.getTime();
        if (waitMs > 0) {
          throw new AppError('RATE_LIMITED', `Please wait ${Math.ceil(waitMs / 1000)} seconds before requesting another code.`);
        }
      }
      if (recent.length >= OTP_POLICY.maxSendsPerWindow) {
        const oldest = recent[recent.length - 1]!;
        const waitMin = Math.ceil((Date.parse(oldest.created_at) + OTP_POLICY.windowMs - now.getTime()) / 60_000);
        throw new AppError('RATE_LIMITED', `Too many codes requested for this number. Try again in ${waitMin} minutes.`);
      }

      const id = crypto.randomUUID();
      const code = randomNumericCode(OTP_LENGTH);
      const nowIso = now.toISOString();
      if (!shared) authRepo.invalidateActiveOtpSessions(phone, nowIso);
      authRepo.insertOtpSession({
        id,
        phone_e164: phone,
        code_hash: codeHash(id, code),
        provider: otpProvider.name,
        max_attempts: OTP_POLICY.maxAttempts,
        created_at: nowIso,
        expires_at: new Date(now.getTime() + OTP_POLICY.ttlMs).toISOString(),
      });

      let delivery;
      try {
        delivery = await otpProvider.send(phone, code);
      } catch {
        authRepo.invalidateOtpSession(id, nowIso);
        throw new AppError('PROVIDER_UNAVAILABLE', 'We could not send a code right now. Please try again shortly.');
      }
      audit.record({ actorType: 'system', action: 'auth.otp_sent', targetType: 'otp_session', targetId: id, requestId: ctx.requestId ?? null, metadata: { provider: otpProvider.name } });

      return {
        otpSessionId: id,
        maskedPhone: maskPhone(phone),
        expiresAt: new Date(now.getTime() + OTP_POLICY.ttlMs).toISOString(),
        resendAvailableAt: new Date(now.getTime() + OTP_POLICY.resendCooldownMs).toISOString(),
        expiresInSeconds: OTP_POLICY.ttlMs / 1000,
        resendAfterSeconds: OTP_POLICY.resendCooldownMs / 1000,
        delivery: {
          provider: otpProvider.name,
          mode: otpProvider.mode,
          ...(otpProvider.mode === 'dev-adapter' && delivery.devCode ? { devCode: delivery.devCode } : {}),
        },
      };
    },

    verifyOtp(
      otpSessionId: string,
      code: string,
      ctx: { userAgent?: string; requestId?: string } = {},
    ): { user: UserRow; isNewUser: boolean; token: string; expiresAt: Date } {
      const now = clock();
      const nowIso = now.toISOString();
      const session = authRepo.findOtpSession(otpSessionId);
      if (!session || session.consumed_at || session.invalidated_at) throw new AppError('BAD_REQUEST', INVALID_CODE);
      if (Date.parse(session.expires_at) <= now.getTime()) {
        throw new AppError('BAD_REQUEST', 'This code has expired. Request a new code.');
      }
      if (!authRepo.takeOtpAttempt(otpSessionId)) {
        throw new AppError('BAD_REQUEST', 'Too many incorrect attempts. Request a new code.');
      }
      if (!safeEqualHex(session.code_hash, codeHash(otpSessionId, code))) {
        const left = session.max_attempts - session.attempts - 1;
        if (left <= 0) {
          audit.record({ actorType: 'system', action: 'auth.otp_locked', targetType: 'otp_session', targetId: otpSessionId, requestId: ctx.requestId ?? null });
          throw new AppError('BAD_REQUEST', 'Too many incorrect attempts. Request a new code.');
        }
        throw new AppError('BAD_REQUEST', `Incorrect code. ${left} ${left === 1 ? 'attempt' : 'attempts'} left.`);
      }
      if (!authRepo.consumeOtpSession(otpSessionId, nowIso)) throw new AppError('BAD_REQUEST', INVALID_CODE);

      let user = users.findByPhone(session.phone_e164);
      const isNewUser = !user;
      if (!user) {
        user = users.create(session.phone_e164, generateCommunityHandle(users.isHandleTaken), nowIso);
        audit.record({ actorType: 'user', actorId: user.id, action: 'user.created', targetType: 'user', targetId: user.id, requestId: ctx.requestId ?? null });
      }

      return { user, isNewUser, ...startSession(user, now, ctx, 'phone') };
    },

    /** Signs in (or up) with a Google ID token from Google Identity Services. */
    async signInWithGoogle(
      credential: string,
      ctx: { userAgent?: string; requestId?: string } = {},
    ): Promise<{ user: UserRow; isNewUser: boolean; token: string; expiresAt: Date }> {
      if (!deps.googleVerifier) throw new AppError('NOT_FOUND', 'Google sign-in is not configured on this server');
      let identity;
      try {
        identity = await deps.googleVerifier(credential);
      } catch (err) {
        if (err instanceof GoogleTokenError) throw new AppError('UNAUTHENTICATED', 'Google sign-in failed. Please try again.');
        throw err;
      }
      const now = clock();
      const nowIso = now.toISOString();
      let user = users.findByGoogleSub(identity.sub);
      const isNewUser = !user;
      if (!user) {
        user = users.createWithGoogle(identity.sub, identity.email, generateCommunityHandle(users.isHandleTaken), nowIso);
        audit.record({ actorType: 'user', actorId: user.id, action: 'user.created', targetType: 'user', targetId: user.id, metadata: { method: 'google' }, requestId: ctx.requestId ?? null });
      } else if (user.email !== identity.email) {
        users.setEmail(user.id, identity.email, nowIso);
        user = users.findById(user.id)!;
      }
      return { user, isNewUser, ...startSession(user, now, ctx, 'google') };
    },

    authenticate(token: string): AuthenticatedSession | null {
      if (!token || token.length > 200) return null;
      const now = clock();
      const session = authRepo.findLiveSession(tokenHash(token), now.toISOString());
      if (!session) return null;
      const user = users.findById(session.user_id);
      if (!user) return null;
      if (now.getTime() - Date.parse(session.last_seen_at) > TOUCH_INTERVAL_MS) {
        authRepo.touchSession(session.id, now.toISOString());
      }
      return { user, sessionId: session.id };
    },

    logout(sessionId: string, userId: string, requestId?: string): void {
      authRepo.revokeSession(sessionId, clock().toISOString());
      audit.record({ actorType: 'user', actorId: userId, action: 'auth.logout', targetType: 'session', targetId: sessionId, requestId: requestId ?? null });
    },

    purgeExpired(): { otp: number; sessions: number } {
      const now = clock().getTime();
      return authRepo.purge(
        new Date(now - 24 * 60 * 60_000).toISOString(),
        new Date(now - 7 * 24 * 60 * 60_000).toISOString(),
      );
    },
  };
}

export type AuthService = ReturnType<typeof createAuthService>;
