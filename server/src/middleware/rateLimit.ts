import { rateLimit } from 'express-rate-limit';
import { AppError } from '../utils/errors.js';

/** Creates a per-IP limiter that responds with the standard ApiError envelope. */
export function createRateLimiter(options: { windowMs: number; limit: number; message?: string }) {
  return rateLimit({
    windowMs: options.windowMs,
    limit: options.limit,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    handler: (_req, _res, next) => {
      next(new AppError('RATE_LIMITED', options.message ?? 'Too many requests. Please slow down.'));
    },
  });
}
