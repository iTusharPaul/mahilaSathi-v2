import crypto from 'node:crypto';
import type { AppConfig } from '../../config/index.js';
import type { Db } from '../../db/connection.js';
import type { Clock } from '../../utils/crypto.js';

/** A failure worth retrying (timeouts, 5xx, rate limits). */
export class SmsTransientError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SmsTransientError';
  }
}
/** A failure that retrying cannot fix (invalid number, rejected content). */
export class SmsPermanentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SmsPermanentError';
  }
}

export interface SmsProvider {
  readonly name: string;
  /** disabled: nothing can be sent. dev-adapter: records locally, sends nothing. live: a real carrier. */
  readonly mode: 'disabled' | 'dev-adapter' | 'live';
  /** Resolves when the provider has ACCEPTED the message. That is not proof of delivery to the handset. */
  send(toE164: string, body: string): Promise<{ providerMessageId: string }>;
}

export const disabledSms: SmsProvider = {
  name: 'none',
  mode: 'disabled',
  async send() {
    throw new SmsPermanentError('SMS is not set up on this server');
  },
};

/** Development adapter: writes to dev_sms_outbox so a demo can show what would be sent. No message leaves the server. */
export function createMockSms(db: Db, clock: Clock): SmsProvider {
  const insert = db.prepare('INSERT INTO dev_sms_outbox (id, to_e164, body, created_at) VALUES (?, ?, ?, ?)');
  return {
    name: 'mock',
    mode: 'dev-adapter',
    async send(toE164, body) {
      const id = crypto.randomUUID();
      insert.run(id, toE164, body, clock().toISOString());
      return { providerMessageId: `dev-${id}` };
    },
  };
}

export function createSmsProvider(config: AppConfig, db: Db, clock: Clock): SmsProvider {
  return config.sms.provider === 'mock' ? createMockSms(db, clock) : disabledSms;
}
