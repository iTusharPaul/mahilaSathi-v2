import crypto from 'node:crypto';

export type Clock = () => Date;
export const systemClock: Clock = () => new Date();

export const sha256Hex = (value: string) => crypto.createHash('sha256').update(value).digest('hex');
export const hmacHex = (secret: string, value: string) => crypto.createHmac('sha256', secret).update(value).digest('hex');
export const randomToken = (bytes = 32) => crypto.randomBytes(bytes).toString('base64url');

/** Constant-time comparison of two hex digests. */
export function safeEqualHex(a: string, b: string): boolean {
  const ba = Buffer.from(a, 'hex');
  const bb = Buffer.from(b, 'hex');
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
}

/** Uniformly random numeric code, zero-padded. */
export const randomNumericCode = (length: number) =>
  crypto.randomInt(0, 10 ** length).toString().padStart(length, '0');
