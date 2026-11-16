import { Router } from 'express';
import { sendOtpRequestSchema, verifyOtpRequestSchema, type AuthResult } from '@mahilasathi/shared';
import { SESSION_COOKIE, clearSessionCookie, currentAuth, requireAuth, sessionCookieOptions } from '../middleware/auth.js';
import { createRateLimiter } from '../middleware/rateLimit.js';
import { parseBody } from '../middleware/validate.js';
import type { AuthService } from '../services/auth/authService.js';
import type { UserService } from '../services/users/userService.js';

export function authRouter(deps: { auth: AuthService; userService: UserService; secureCookies: boolean; ipLimit: number }): Router {
  const { auth, userService, secureCookies } = deps;
  const router = Router();
  const authLimiter = createRateLimiter({
    windowMs: 15 * 60_000,
    limit: deps.ipLimit,
    message: 'Too many sign-in attempts from this network. Please try again later.',
  });

  router.post('/auth/send-otp', authLimiter, async (req, res) => {
    const { phone } = parseBody(req, sendOtpRequestSchema);
    res.status(201).json(await auth.sendOtp(phone, { requestId: req.id }));
  });

  router.post('/auth/verify-otp', authLimiter, (req, res) => {
    const { otpSessionId, code } = parseBody(req, verifyOtpRequestSchema);
    const result = auth.verifyOtp(otpSessionId, code, { userAgent: req.header('user-agent'), requestId: req.id });
    res.cookie(SESSION_COOKIE, result.token, sessionCookieOptions(secureCookies, result.expiresAt));
    const body: AuthResult = { user: userService.toMe(result.user), isNewUser: result.isNewUser };
    res.json(body);
  });

  router.post('/auth/logout', (req, res) => {
    if (req.auth) auth.logout(req.auth.sessionId, req.auth.user.id, req.id);
    clearSessionCookie(res, secureCookies);
    res.status(204).end();
  });

  router.get('/auth/me', requireAuth, (req, res) => {
    res.json(userService.toMe(currentAuth(req).user));
  });

  return router;
}
