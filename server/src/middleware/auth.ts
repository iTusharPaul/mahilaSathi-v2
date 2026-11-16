import type { CookieOptions, RequestHandler, Response } from 'express';
import type { UserRow } from '../repositories/userRepository.js';
import type { AuthService } from '../services/auth/authService.js';
import { parseCookies } from '../utils/cookies.js';
import { AppError } from '../utils/errors.js';

export const SESSION_COOKIE = 'ms_session';

declare module 'express-serve-static-core' {
  interface Request {
    auth?: { user: UserRow; sessionId: string };
  }
}

/** Attaches req.auth when a valid session cookie is present. Never rejects on its own. */
export function attachSession(auth: AuthService): RequestHandler {
  return (req, _res, next) => {
    const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];
    if (token) {
      const session = auth.authenticate(token);
      if (session) req.auth = session;
    }
    next();
  };
}

export const requireAuth: RequestHandler = (req, _res, next) => {
  if (!req.auth) return next(new AppError('UNAUTHENTICATED', 'Please sign in to continue'));
  next();
};

/** Narrows req.auth for handlers mounted behind requireAuth. */
export function currentAuth(req: { auth?: { user: UserRow; sessionId: string } }) {
  if (!req.auth) throw new AppError('UNAUTHENTICATED', 'Please sign in to continue');
  return req.auth;
}

export function sessionCookieOptions(secure: boolean, expires?: Date): CookieOptions {
  return { httpOnly: true, secure, sameSite: 'lax', path: '/', ...(expires ? { expires } : {}) };
}

export function clearSessionCookie(res: Response, secure: boolean): void {
  res.clearCookie(SESSION_COOKIE, sessionCookieOptions(secure));
}
