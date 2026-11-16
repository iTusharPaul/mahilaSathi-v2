import type { ErrorRequestHandler, RequestHandler } from 'express';
import type { ApiError } from '@mahilasathi/shared';
import { ZodError } from 'zod';
import { AppError } from '../utils/errors.js';

export const apiNotFound: RequestHandler = (req, _res, next) => {
  next(new AppError('NOT_FOUND', `No API route for ${req.method} ${req.path}`));
};

interface BodyParserError extends Error {
  type?: string;
  status?: number;
}

function toAppError(err: unknown): AppError | null {
  if (err instanceof AppError) return err;
  if (err instanceof ZodError) {
    return new AppError(
      'VALIDATION_FAILED',
      'Request validation failed',
      err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    );
  }
  const bp = err as BodyParserError;
  if (bp?.type === 'entity.parse.failed') return new AppError('BAD_REQUEST', 'Request body is not valid JSON');
  if (bp?.type === 'entity.too.large') return new AppError('PAYLOAD_TOO_LARGE', 'Request body is too large');
  // http-errors raised by Express internals (e.g. a missing static asset).
  if (bp?.status === 404) return new AppError('NOT_FOUND', 'Not found');
  if (bp?.status === 400) return new AppError('BAD_REQUEST', 'Bad request');
  return null;
}

/**
 * Converts every error into the shared ApiError envelope. Unknown errors are logged with the
 * request id and returned as a generic INTERNAL error, so stack traces and internals never leak.
 */
export const errorHandler: ErrorRequestHandler = (err, req, res, _next) => {
  const known = toAppError(err);
  const appError = known ?? new AppError('INTERNAL', 'Something went wrong. Please try again.');

  if (!known) req.log?.error({ err, requestId: req.id }, 'unhandled error');
  else if (appError.status >= 500) req.log?.warn({ code: appError.code, requestId: req.id }, appError.message);

  if (res.headersSent) return;
  const body: ApiError = {
    error: {
      code: appError.code,
      message: appError.message,
      requestId: req.id,
      ...(appError.details !== undefined ? { details: appError.details } : {}),
    },
  };
  res.status(appError.status).json(body);
};
