import pino, { type Logger } from 'pino';
import type { AppConfig } from '../config/index.js';

/**
 * Fields that must never reach log output in clear text. Location and phone numbers are
 * personal data; tokens and cookies are credentials.
 */
export const REDACT_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["x-admin-token"]',
  'res.headers["set-cookie"]',
  '*.phone',
  '*.phoneNumber',
  '*.otp',
  '*.token',
  '*.accessToken',
  '*.secret',
  '*.password',
  '*.lat',
  '*.lng',
  '*.lon',
  '*.latitude',
  '*.longitude',
  '*.coordinates',
];

export function createLogger(config: Pick<AppConfig, 'logLevel' | 'env'>): Logger {
  return pino({
    level: config.logLevel,
    base: { service: 'mahilasathi' },
    redact: { paths: REDACT_PATHS, censor: '[redacted]' },
    ...(config.env === 'development'
      ? { transport: { target: 'pino-pretty', options: { colorize: true, translateTime: 'HH:MM:ss' } } }
      : {}),
  });
}
