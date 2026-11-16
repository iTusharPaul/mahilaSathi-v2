import crypto from 'node:crypto';
import type { RequestHandler } from 'express';

const SAFE_INCOMING_ID = /^[A-Za-z0-9_-]{8,64}$/;

declare module 'express-serve-static-core' {
  interface Request {
    id: string;
  }
}

/** Assigns every request an id, reusing a well-formed upstream X-Request-Id when present. */
export const requestId: RequestHandler = (req, res, next) => {
  const incoming = req.header('x-request-id');
  req.id = incoming && SAFE_INCOMING_ID.test(incoming) ? incoming : crypto.randomUUID();
  res.setHeader('X-Request-Id', req.id);
  next();
};
