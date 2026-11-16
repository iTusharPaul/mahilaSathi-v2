/**
 * Detects personal contact details and precise locations: phone numbers, long digit runs, emails,
 * coordinates and map links. Used by the server's message policy (authoritative) and by the client before
 * sending, so the rule also holds with Nexconn when the pre-messaging webhook isn't reachable (local dev).
 */
const PHONE = /(?:\+?\s?91[\s-]?)?(?<!\d)[6-9]\d{2}[\s-]?\d{3}[\s-]?\d{4}(?!\d)/;
const LONG_DIGITS = /\d[\d\s-]{9,}\d/;
const EMAIL = /[^\s@]+@[^\s@]+\.[a-z]{2,}/i;
const COORDINATES = /-?\d{1,2}\.\d{4,}\s*[,\s]\s*-?\d{1,3}\.\d{4,}/;
const MAP_LINK = /(maps\.google\.|google\.[a-z.]+\/maps|goo\.gl\/maps|maps\.app\.goo\.gl|maps\.apple\.com|openstreetmap\.org\/[#?].*map=|what3words)/i;

export function containsContactInfo(text: string): boolean {
  return PHONE.test(text) || LONG_DIGITS.test(text) || EMAIL.test(text) || COORDINATES.test(text) || MAP_LINK.test(text);
}

export const CONTACT_INFO_MESSAGE =
  'For everyone’s safety, don’t share phone numbers, emails or exact locations in community channels. Share them privately with your Guardian Circle.';
