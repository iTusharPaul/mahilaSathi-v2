import type { Request } from 'express';
import type { z } from 'zod';

/**
 * Parses part of a request with a Zod schema. Throws ZodError, which the error handler turns
 * into a VALIDATION_FAILED response. Handlers use the returned value, never the raw input.
 */
export function parseBody<S extends z.ZodTypeAny>(req: Request, schema: S): z.infer<S> {
  return schema.parse(req.body);
}

export function parseQuery<S extends z.ZodTypeAny>(req: Request, schema: S): z.infer<S> {
  return schema.parse(req.query);
}

export function parseParams<S extends z.ZodTypeAny>(req: Request, schema: S): z.infer<S> {
  return schema.parse(req.params);
}
