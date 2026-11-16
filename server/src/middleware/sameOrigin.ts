import type { RequestHandler } from 'express';
import { AppError } from '../utils/errors.js';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * CSRF defence for cookie-authenticated requests. Browsers always send Origin on cross-site
 * state-changing requests, so a mismatched Origin is rejected. Requests without Origin (same-origin
 * navigations, server-to-server tools) are allowed; SameSite=Lax cookies cover the rest.
 */
export function requireTrustedOrigin(allowedOrigins: string[]): RequestHandler {
  return (req, _res, next) => {
    if (SAFE_METHODS.has(req.method)) return next();
    const origin = req.header('origin');
    if (!origin) return next();
    const self = `${req.protocol}://${req.get('host')}`;
    if (origin === self || allowedOrigins.includes(origin)) return next();
    next(new AppError('FORBIDDEN', 'Cross-site request blocked'));
  };
}
