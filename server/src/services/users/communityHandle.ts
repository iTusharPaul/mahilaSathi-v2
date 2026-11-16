import crypto from 'node:crypto';

/** Nature words for pseudonymous community handles such as "Gulmohar-31". */
const WORDS = [
  'Lotus', 'Jasmine', 'Neem', 'Pearl', 'Tulsi', 'Champa', 'Gulmohar', 'Amaltas', 'Mogra', 'Rajnigandha',
  'Kadamb', 'Ashoka', 'Peepal', 'Banyan', 'Marigold', 'Hibiscus', 'Orchid', 'Lily', 'Iris', 'Magnolia',
  'Juhi', 'Kesar', 'Chameli', 'Palash', 'Mehndi', 'Sandal', 'Moonbeam', 'Firefly', 'Sparrow', 'Myna',
  'Koel', 'Bulbul', 'Kingfisher', 'Heron', 'Robin', 'Saffron', 'Indigo', 'Coral', 'Amber', 'Jade',
];

/** Fictional demo identities are reserved so real users never receive them. */
export const RESERVED_HANDLES = new Set(['Lotus-42', 'Jasmine-17', 'Neem-08', 'Pearl-23']);

export function generateCommunityHandle(isTaken: (handle: string) => boolean): string {
  for (let attempt = 0; attempt < 50; attempt++) {
    const word = WORDS[crypto.randomInt(0, WORDS.length)]!;
    const digits = attempt < 30 ? 2 : 4;
    const handle = `${word}-${crypto.randomInt(0, 10 ** digits).toString().padStart(digits, '0')}`;
    if (!RESERVED_HANDLES.has(handle) && !isTaken(handle)) return handle;
  }
  throw new Error('Could not allocate a unique community handle');
}
