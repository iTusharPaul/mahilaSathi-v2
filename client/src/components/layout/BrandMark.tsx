/** The mahilaSathi mark: an arch (shelter, a path home) over a warm point (a person). */
export function BrandMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 64 64" className={className} aria-hidden="true">
      <rect width="64" height="64" rx="16" fill="#40234F" />
      <path d="M20 42c0-9 5-17 12-21 7 4 12 12 12 21" fill="none" stroke="#E9DDF2" strokeWidth="4" strokeLinecap="round" />
      <circle cx="32" cy="44" r="5" fill="#E77C72" />
    </svg>
  );
}
