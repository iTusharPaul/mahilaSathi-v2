import { z } from 'zod';
import { normalizeIndianMobile } from '../phone.js';

export const OTP_LENGTH = 6;

export const indianMobileSchema = z
  .string()
  .trim()
  .min(10, 'Enter a 10-digit mobile number')
  .max(20)
  .transform((v, ctx) => {
    const e164 = normalizeIndianMobile(v);
    if (!e164) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Enter a valid Indian mobile number' });
      return z.NEVER;
    }
    return e164;
  });

export const sendOtpRequestSchema = z.object({ phone: indianMobileSchema });
export type SendOtpRequest = z.input<typeof sendOtpRequestSchema>;

export const sendOtpResponseSchema = z.object({
  otpSessionId: z.string().uuid(),
  maskedPhone: z.string(),
  expiresAt: z.string().datetime(),
  resendAvailableAt: z.string().datetime(),
  /** Relative timings, so clients do not depend on their clock matching the server's. */
  expiresInSeconds: z.number().int().positive(),
  resendAfterSeconds: z.number().int().nonnegative(),
  delivery: z.object({
    provider: z.string(),
    /** `dev-adapter` means no SMS was sent. */
    mode: z.enum(['live', 'dev-adapter']),
    /** Present only with the development OTP adapter, so the code can be entered without SMS. */
    devCode: z.string().length(OTP_LENGTH).optional(),
  }),
});
export type SendOtpResponse = z.infer<typeof sendOtpResponseSchema>;

export const verifyOtpRequestSchema = z.object({
  otpSessionId: z.string().uuid(),
  code: z.string().trim().regex(new RegExp(`^\\d{${OTP_LENGTH}}$`), `Enter the ${OTP_LENGTH}-digit code`),
});
export type VerifyOtpRequest = z.infer<typeof verifyOtpRequestSchema>;

/** The ID token (JWT) Google Identity Services hands the page after the user picks an account. */
export const googleSignInRequestSchema = z.object({
  credential: z.string().min(20).max(4096).regex(/^[\w-]+\.[\w-]+\.[\w-]+$/, 'Not a Google sign-in token'),
});
export type GoogleSignInRequest = z.infer<typeof googleSignInRequestSchema>;
