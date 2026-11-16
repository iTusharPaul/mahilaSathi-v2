import { z } from 'zod';
import { ERROR_CODES } from '../constants/api.js';

export const apiErrorSchema = z.object({
  error: z.object({
    code: z.enum(ERROR_CODES),
    message: z.string(),
    requestId: z.string().optional(),
    details: z.unknown().optional(),
  }),
});
export type ApiError = z.infer<typeof apiErrorSchema>;

export const healthResponseSchema = z.object({
  status: z.literal('ok'),
  service: z.literal('mahilasathi'),
  version: z.string(),
  uptimeSeconds: z.number().nonnegative(),
  time: z.string().datetime(),
});
export type HealthResponse = z.infer<typeof healthResponseSchema>;

const checkSchema = z.object({
  ok: z.boolean(),
  detail: z.string().optional(),
});

export const readyResponseSchema = z.object({
  status: z.enum(['ready', 'not_ready']),
  checks: z.object({
    database: checkSchema,
    migrations: checkSchema.extend({
      applied: z.number().int().nonnegative(),
      pending: z.number().int().nonnegative(),
    }),
    geography: checkSchema.extend({ datasetVersion: z.string().nullable() }),
  }),
});
export type ReadyResponse = z.infer<typeof readyResponseSchema>;

/** Whether an optional integration is usable, and if not, what stands in for it. */
export const providerStatusSchema = z.object({
  configured: z.boolean(),
  /** `live` = real provider; `dev-adapter` = explicitly labelled stand-in; `disabled` = feature off. */
  mode: z.enum(['live', 'dev-adapter', 'disabled']),
});
export type ProviderStatus = z.infer<typeof providerStatusSchema>;

/** Non-secret runtime configuration served to the browser. Never contains key or secret values. */
export const publicConfigSchema = z.object({
  environment: z.enum(['development', 'test', 'production']),
  demoMode: z.boolean(),
  communityModerationEnabled: z.boolean(),
  providers: z.object({
    geoapify: providerStatusSchema,
    nexconn: providerStatusSchema,
    otp: providerStatusSchema,
    push: providerStatusSchema,
    sms: providerStatusSchema,
  }),
});
export type PublicConfig = z.infer<typeof publicConfigSchema>;
