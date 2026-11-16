import type { Coverage } from '@mahilasathi/shared';
import { Badge, type BadgeTone } from '@/components/ui';

const LABELS: Record<Coverage['level'], { label: string; tone: BadgeTone }> = {
  high: { label: 'High data coverage', tone: 'success' },
  medium: { label: 'Medium data coverage', tone: 'primary' },
  low: { label: 'Low data coverage', tone: 'neutral' },
  // Unknown is neutral, never warning-coloured: missing data is not negative information.
  unknown: { label: 'Data coverage not assessed yet', tone: 'neutral' },
};

export function CoverageBadge({ coverage }: { coverage: Coverage }) {
  const { label, tone } = LABELS[coverage.level];
  return (
    <span title={coverage.summary}>
      <Badge tone={tone}>{label}</Badge>
    </span>
  );
}
