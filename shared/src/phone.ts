/**
 * Indian mobile numbers only for now: 10 digits starting 6–9, stored as E.164 (+91XXXXXXXXXX).
 * Accepts common input forms: "98765 43210", "+91-98765-43210", "09876543210", "919876543210".
 */
export function normalizeIndianMobile(input: string): string | null {
  let digits = input.replace(/[\s\-().]/g, '');
  if (digits.startsWith('+91')) digits = digits.slice(3);
  else if (digits.startsWith('0091')) digits = digits.slice(4);
  else if (digits.length === 12 && digits.startsWith('91')) digits = digits.slice(2);
  else if (digits.length === 11 && digits.startsWith('0')) digits = digits.slice(1);
  return /^[6-9]\d{9}$/.test(digits) ? `+91${digits}` : null;
}

/** "+919876543210" → "+91 ••••• •3210". For confirmation screens; never for identification. */
export function maskPhone(e164: string): string {
  return `${e164.slice(0, 3)} ••••• •${e164.slice(-4)}`;
}

/** "priya.sharma@gmail.com" → "p•••@gmail.com". Shown only to the account owner. */
export function maskEmail(email: string): string {
  const at = email.lastIndexOf('@');
  if (at < 1) return '•••';
  return `${email[0]}•••${email.slice(at)}`;
}
