import crypto from 'node:crypto';
import { z } from 'zod';
import { resolveFromRoot } from './paths.js';

export const SUPPORTED_OTP_PROVIDERS = ['mock'] as const;
/** `webpush`: the Web Push standard (VAPID). Works in Chrome, Edge, Firefox and installed web apps. */
export const SUPPORTED_PUSH_PROVIDERS = ['none', 'webpush'] as const;
/** SMS for SOS alerts to emergency contacts. `mock` is a labelled development adapter that sends nothing. */
export const SUPPORTED_SMS_PROVIDERS = ['none', 'mock'] as const;
const MIN_SECRET_LENGTH = 32;

/** https://docs.nexconn.ai/platform-chat-api/prepare-to-use-api/base-url */
const NEXCONN_HOSTS = {
  sg: ['api.sg-light-api.com', 'api-b.sg-light-api.com'],
  na: ['api.us-light-api.com', 'api-b.us-light-api.com'],
} as const satisfies Record<string, readonly string[]>;

const isBlank = (v: unknown) => v === undefined || (typeof v === 'string' && v.trim() === '');

/** Blank values copied from .env.example mean "not set". */
const optionalString = z.preprocess(
  (v) => (isBlank(v) ? undefined : v),
  z.string().trim().optional(),
);

const booleanFlag = (fallback: boolean) =>
  z.preprocess((v) => {
    if (isBlank(v)) return fallback;
    if (typeof v === 'string') {
      const s = v.trim().toLowerCase();
      if (['true', '1', 'yes', 'on'].includes(s)) return true;
      if (['false', '0', 'no', 'off'].includes(s)) return false;
    }
    return v;
  }, z.boolean({ invalid_type_error: 'must be true or false' }));

const rawEnvSchema = z.object({
  PORT: z.preprocess((v) => (isBlank(v) ? 8080 : Number(v)), z.number().int().min(1).max(65535)),
  NODE_ENV: z.preprocess(
    (v) => (isBlank(v) ? 'development' : v),
    z.enum(['development', 'test', 'production']),
  ),
  LOG_LEVEL: z.preprocess(
    (v) => (isBlank(v) ? undefined : v),
    z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).optional(),
  ),
  CORS_ORIGINS: optionalString,
  DATABASE_PATH: optionalString,
  JWT_SECRET: optionalString,
  ADMIN_TOKEN: optionalString,
  GEOAPIFY_API_KEY: optionalString,
  NEXCONN_APP_KEY: optionalString,
  NEXCONN_APP_SECRET: optionalString,
  NEXCONN_API_HOST: optionalString,
  NEXCONN_AREA: z.preprocess((v) => (isBlank(v) ? 'sg' : String(v).toLowerCase()), z.enum(['sg', 'na'])),
  OTP_PROVIDER: optionalString,
  OTP_PROVIDER_API_KEY: optionalString,
  PUSH_PROVIDER: optionalString,
  PUSH_PROVIDER_API_KEY: optionalString,
  VAPID_PUBLIC_KEY: optionalString,
  VAPID_PRIVATE_KEY: optionalString,
  VAPID_SUBJECT: optionalString,
  SMS_PROVIDER: optionalString,
  DEMO_MODE: booleanFlag(false),
  DEMO_AUTOSEED: booleanFlag(false),
  CLIENT_IP_HEADER: z.preprocess(
    (v) => (isBlank(v) ? undefined : String(v).trim().toLowerCase()),
    z.string().regex(/^[a-z0-9-]+$/, 'must be a header name such as cf-connecting-ip').optional(),
  ),
  TRUST_PROXY: z.preprocess((v) => (isBlank(v) ? 1 : Number(v)), z.number().int().min(0).max(10)),
  COMMUNITY_MODERATION_ENABLED: booleanFlag(true),
});

export type Environment = 'development' | 'test' | 'production';

export interface AppConfig {
  port: number;
  env: Environment;
  isProduction: boolean;
  logLevel: string;
  corsOrigins: string[];
  databasePath: string;
  jwtSecret: string;
  /** True when no JWT_SECRET was configured and an ephemeral one was generated (dev/test only). */
  jwtSecretIsEphemeral: boolean;
  adminToken: string | null;
  demoMode: boolean;
  /** Seed the demo accounts at startup (demo hosts whose disk resets). Only true when demoMode is. */
  demoAutoSeed: boolean;
  /** Reverse-proxy hops to trust in production (for the client IP used by rate limits). */
  trustProxy: number;
  /** Header set by the edge proxy with the visitor's IP (e.g. cf-connecting-ip). Overrides trust-proxy for rate limits. */
  clientIpHeader: string | null;
  communityModerationEnabled: boolean;
  geoapify: { apiKey: string | null };
  /** apiHosts: primary then backup, per Nexconn's documented data-centre base URLs. */
  nexconn: { appKey: string | null; appSecret: string | null; area: 'sg' | 'na'; apiHosts: string[] };
  otp: { provider: (typeof SUPPORTED_OTP_PROVIDERS)[number]; apiKey: string | null };
  push: {
    provider: (typeof SUPPORTED_PUSH_PROVIDERS)[number];
    apiKey: string | null;
    /** Set when provider is webpush. The private key never leaves the server. */
    vapid: { publicKey: string; privateKey: string; subject: string } | null;
  };
  sms: { provider: (typeof SUPPORTED_SMS_PROVIDERS)[number] };
}

export class ConfigError extends Error {
  constructor(public readonly problems: string[]) {
    super(
      `Invalid server configuration:\n${problems.map((p) => `  - ${p}`).join('\n')}\n` +
        'See .env.example for every supported variable.',
    );
    this.name = 'ConfigError';
  }
}

const GENERATE_HINT =
  'generate one with: node -e "console.log(require(\'crypto\').randomBytes(48).toString(\'base64url\'))"';

/**
 * Parses and validates environment variables. Pure: takes the env object so it is testable.
 * Throws ConfigError listing every problem at once with a suggested fix.
 */
export function loadConfig(env: Record<string, string | undefined>): AppConfig {
  const parsed = rawEnvSchema.safeParse(env);
  if (!parsed.success) {
    throw new ConfigError(
      parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`),
    );
  }
  const e = parsed.data;
  const problems: string[] = [];
  const isProduction = e.NODE_ENV === 'production';

  // Secrets
  const checkSecret = (name: 'JWT_SECRET' | 'ADMIN_TOKEN', value: string | undefined) => {
    if (value === undefined) {
      if (isProduction) problems.push(`${name} is required in production; ${GENERATE_HINT}`);
      return;
    }
    if (value.length < MIN_SECRET_LENGTH) {
      problems.push(`${name} must be at least ${MIN_SECRET_LENGTH} characters; ${GENERATE_HINT}`);
    }
  };
  checkSecret('JWT_SECRET', e.JWT_SECRET);
  checkSecret('ADMIN_TOKEN', e.ADMIN_TOKEN);

  // CORS
  const corsOrigins: string[] = [];
  for (const raw of (e.CORS_ORIGINS ?? '').split(',').map((s) => s.trim()).filter(Boolean)) {
    let origin: string | null = null;
    try {
      origin = new URL(raw).origin;
    } catch {
      origin = null;
    }
    if (origin && origin === raw.replace(/\/$/, '')) corsOrigins.push(origin);
    else problems.push(`CORS_ORIGINS entry "${raw}" must be an origin such as https://app.example.in (no path)`);
  }

  // Nexconn: key and secret go together.
  if (Boolean(e.NEXCONN_APP_KEY) !== Boolean(e.NEXCONN_APP_SECRET)) {
    problems.push('NEXCONN_APP_KEY and NEXCONN_APP_SECRET must both be set, or both left empty');
  }

  // OTP
  const otpProvider = e.OTP_PROVIDER ?? 'mock';
  if (!(SUPPORTED_OTP_PROVIDERS as readonly string[]).includes(otpProvider)) {
    problems.push(
      `OTP_PROVIDER "${otpProvider}" is not supported; supported: ${SUPPORTED_OTP_PROVIDERS.join(', ')}`,
    );
  } else if (otpProvider === 'mock' && isProduction && !e.DEMO_MODE) {
    problems.push(
      'OTP_PROVIDER=mock cannot be used in production unless DEMO_MODE=true; configure a real OTP provider',
    );
  }

  // Push
  const pushProvider = e.PUSH_PROVIDER ?? 'none';
  if (!(SUPPORTED_PUSH_PROVIDERS as readonly string[]).includes(pushProvider)) {
    problems.push(
      `PUSH_PROVIDER "${pushProvider}" is not supported; supported: ${SUPPORTED_PUSH_PROVIDERS.join(', ')}`,
    );
  }

  if (pushProvider === 'webpush' && (!e.VAPID_PUBLIC_KEY || !e.VAPID_PRIVATE_KEY)) {
    problems.push('PUSH_PROVIDER=webpush needs VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY; generate them with: npx web-push generate-vapid-keys');
  }

  // SMS (SOS alerts to emergency contacts)
  const smsProvider = e.SMS_PROVIDER ?? 'none';
  if (!(SUPPORTED_SMS_PROVIDERS as readonly string[]).includes(smsProvider)) {
    problems.push(`SMS_PROVIDER "${smsProvider}" is not supported; supported: ${SUPPORTED_SMS_PROVIDERS.join(', ')}`);
  } else if (smsProvider === 'mock' && isProduction && !e.DEMO_MODE) {
    problems.push('SMS_PROVIDER=mock cannot be used in production unless DEMO_MODE=true: it sends no real messages');
  }

  if (problems.length > 0) throw new ConfigError(problems);

  return {
    port: e.PORT,
    env: e.NODE_ENV,
    isProduction,
    logLevel: e.LOG_LEVEL ?? (e.NODE_ENV === 'test' ? 'silent' : 'info'),
    corsOrigins,
    databasePath:
      e.DATABASE_PATH === ':memory:'
        ? ':memory:'
        : resolveFromRoot(e.DATABASE_PATH ?? './data/mahilasathi.db'),
    jwtSecret: e.JWT_SECRET ?? crypto.randomBytes(48).toString('base64url'),
    jwtSecretIsEphemeral: e.JWT_SECRET === undefined,
    adminToken: e.ADMIN_TOKEN ?? null,
    demoMode: e.DEMO_MODE,
    demoAutoSeed: e.DEMO_MODE && e.DEMO_AUTOSEED,
    trustProxy: e.TRUST_PROXY,
    clientIpHeader: e.CLIENT_IP_HEADER ?? null,
    communityModerationEnabled: e.COMMUNITY_MODERATION_ENABLED,
    geoapify: { apiKey: e.GEOAPIFY_API_KEY ?? null },
    nexconn: {
      appKey: e.NEXCONN_APP_KEY ?? null,
      appSecret: e.NEXCONN_APP_SECRET ?? null,
      area: e.NEXCONN_AREA,
      apiHosts: e.NEXCONN_API_HOST ? [e.NEXCONN_API_HOST] : [...NEXCONN_HOSTS[e.NEXCONN_AREA]],
    },
    otp: { provider: otpProvider as AppConfig['otp']['provider'], apiKey: e.OTP_PROVIDER_API_KEY ?? null },
    push: {
      provider: pushProvider as AppConfig['push']['provider'],
      apiKey: e.PUSH_PROVIDER_API_KEY ?? null,
      vapid:
        pushProvider === 'webpush' && e.VAPID_PUBLIC_KEY && e.VAPID_PRIVATE_KEY
          ? { publicKey: e.VAPID_PUBLIC_KEY, privateKey: e.VAPID_PRIVATE_KEY, subject: e.VAPID_SUBJECT ?? 'mailto:admin@mahilasathi.invalid' }
          : null,
    },
    sms: { provider: smsProvider as AppConfig['sms']['provider'] },
  };
}
