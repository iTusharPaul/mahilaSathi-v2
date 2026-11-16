import type { AppConfig } from '../../config/index.js';

export interface OtpDelivery {
  /** Only the development adapter returns the code, so it can be shown in the UI instead of an SMS. */
  devCode?: string;
}

export interface OtpProvider {
  readonly name: string;
  readonly mode: 'live' | 'dev-adapter';
  send(phoneE164: string, code: string): Promise<OtpDelivery>;
}

/**
 * Development OTP adapter: sends nothing and hands the code back to the client, where the UI labels
 * it as a development code. Config validation forbids it in production unless DEMO_MODE=true.
 */
export const devOtpProvider: OtpProvider = {
  name: 'mock',
  mode: 'dev-adapter',
  async send(_phone, code) {
    return { devCode: code };
  },
};

export function createOtpProvider(config: AppConfig): OtpProvider {
  switch (config.otp.provider) {
    case 'mock':
      return devOtpProvider;
  }
}
