import { MapPin, Route, Search, ShieldAlert } from 'lucide-react';
import { useState } from 'react';
import { PageHeader } from '@/components/layout/PageHeader';
import { Badge, Button, Card, CardHeader, EmptyState, ErrorState, Notice, Skeleton, Spinner, TextField } from '@/components/ui';

const swatches = [
  ['bg', 'Background'],
  ['surface', 'Surface'],
  ['surface-muted', 'Surface muted'],
  ['primary', 'Primary · plum'],
  ['primary-soft', 'Primary soft · lavender'],
  ['accent', 'Accent · coral'],
  ['success', 'Success'],
  ['warning', 'Warning'],
  ['danger', 'Danger · emergency only'],
] as const;

const swatchClass: Record<(typeof swatches)[number][0], string> = {
  bg: 'bg-bg',
  surface: 'bg-surface',
  'surface-muted': 'bg-surface-muted',
  primary: 'bg-primary',
  'primary-soft': 'bg-primary-soft',
  accent: 'bg-accent',
  success: 'bg-success',
  warning: 'bg-warning',
  danger: 'bg-danger',
};

/** Living reference for the component library. Uses no real data. */
export function DesignSystemPage() {
  const [query, setQuery] = useState('');
  return (
    <div className="space-y-5">
      <PageHeader title="Design system" description="Tokens and components used across mahilaSathi. Toggle the theme in the header." />

      <Card>
        <CardHeader title="Colour tokens" />
        <div className="grid grid-cols-3 gap-3">
          {swatches.map(([key, label]) => (
            <div key={key} className="text-xs">
              <div className={`h-12 rounded-xl border border-border ${swatchClass[key]}`} />
              <p className="mt-1.5 text-fg-muted">{label}</p>
            </div>
          ))}
        </div>
      </Card>

      <Card className="space-y-4">
        <CardHeader title="Buttons" />
        <div className="flex flex-wrap gap-2">
          <Button>Primary</Button>
          <Button variant="secondary">Secondary</Button>
          <Button variant="ghost">Ghost</Button>
          <Button loading>Saving</Button>
          <Button disabled>Disabled</Button>
        </div>
        <Button variant="danger" size="lg" fullWidth icon={<ShieldAlert className="h-5 w-5" aria-hidden />}>
          Danger (reserved for SOS)
        </Button>
      </Card>

      <Card className="space-y-3">
        <CardHeader title="Badges" />
        <div className="flex flex-wrap gap-2">
          <Badge>Neutral</Badge>
          <Badge tone="primary">High confidence</Badge>
          <Badge tone="success">Verified</Badge>
          <Badge tone="warning">Community reported</Badge>
          <Badge tone="accent">Journey room</Badge>
          <Badge tone="danger">SOS active</Badge>
        </div>
      </Card>

      <Card className="space-y-4">
        <CardHeader title="Inputs" />
        <TextField
          label="Destination"
          placeholder="Search a place in NCR"
          leading={<Search className="h-4 w-4" aria-hidden />}
          hint="Example field. It does not search anything."
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <TextField label="Phone number" leading={<span className="text-sm">+91</span>} error="Enter a 10-digit mobile number" inputMode="numeric" />
      </Card>

      <Card className="space-y-4">
        <CardHeader title="Feedback" />
        <Notice title="Information">Neutral explanation, such as a coverage caveat.</Notice>
        <Notice tone="warning" title="Synthetic demo data">Shown wherever data is not live.</Notice>
        <ErrorState message="Example error with a retry action." onRetry={() => undefined} />
        <div className="flex items-center gap-3">
          <Spinner />
          <Skeleton className="h-4 flex-1" />
        </div>
      </Card>

      <Card>
        <EmptyState
          icon={<Route className="h-6 w-6" aria-hidden />}
          title="Empty state"
          description="Used when a list has nothing to show yet."
          action={<Button variant="secondary" icon={<MapPin className="h-4 w-4" aria-hidden />}>Primary action</Button>}
        />
      </Card>
    </div>
  );
}
