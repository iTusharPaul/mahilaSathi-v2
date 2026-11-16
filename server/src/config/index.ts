import path from 'node:path';
import dotenv from 'dotenv';
import { REPO_ROOT } from './paths.js';
import { loadConfig, type AppConfig } from './env.js';

export { loadConfig, ConfigError, type AppConfig } from './env.js';
export * from './paths.js';

/** Reads `.env` from the repository root (if present) and validates the process environment. */
export function loadConfigFromProcess(): AppConfig {
  dotenv.config({ path: path.join(REPO_ROOT, '.env') });
  return loadConfig(process.env);
}
