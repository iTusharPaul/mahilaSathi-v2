import { COMMUNITY_REPORT_CATEGORIES, SENSITIVE_REPORT_CATEGORIES, type CommunityReportView, type PulseCell } from '@mahilasathi/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Activity, ArrowLeft, Flag, ShieldCheck } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { PageHeader } from '@/components/layout/PageHeader';
import { Badge, Button, Card, CardHeader, ErrorState, Notice, Skeleton, type BadgeTone } from '@/components/ui';
import { dayClock } from '@/features/journeys/format';
import { LocationInput, type PickedPoint } from '@/features/routing/LocationInput';
import { journeysApi } from '@/services/journeysApi';

type Category = (typeof COMMUNITY_REPORT_CATEGORIES)[number];

export const REPORT_CATEGORY_LABELS: Record<Category, string> = {
  poor_lighting: 'Poorly lit stretch',
  broken_streetlight: 'Broken streetlight',
  harassment: 'Harassment',
  suspicious_activity: 'Suspicious activity',
  road_obstruction: 'Road obstruction',
  closed_establishment: 'Usually-open place closed',
  transport_issue: 'Transport issue',
  other: 'Other',
};

const LABEL_TONE: Record<CommunityReportView['label'], BadgeTone> = {
  'Community reported': 'warning',
  'Under review': 'neutral',
  'Verified information': 'success',
};

const LEVEL: Record<PulseCell['level'], { text: string; tone: BadgeTone }> = {
  positive: { text: 'Mostly positive', tone: 'success' },
  neutral: { text: 'Mixed', tone: 'neutral' },
  cautionary: { text: 'Some concerns', tone: 'warning' },
  insufficient: { text: 'Not enough community data yet', tone: 'neutral' },
};

export function AreaReportsPage() {
  const [place, setPlace] = useState<PickedPoint | null>(null);

  return (
    <div className="space-y-5">
      <Link to="/community" className="inline-flex items-center gap-1 text-sm font-medium text-primary"><ArrowLeft className="h-4 w-4" aria-hidden />Community</Link>
      <PageHeader title="Area pulse & reports" description="What the community has noticed around a place, aggregated so no one can be identified." />
      <Card>
        <LocationInput label="Place" value={place} onChange={setPlace} allowCurrentLocation />
      </Card>
      {place ? <AreaDetail place={place} /> : <p className="text-sm text-fg-muted">Choose a place, or use your current location, to see its Community Pulse and recent reports.</p>}
      <MyReports />
    </div>
  );
}

function AreaDetail({ place }: { place: PickedPoint }) {
  const pulse = useQuery({ queryKey: ['pulse', place.lat, place.lng], queryFn: () => journeysApi.pulse(place.lat, place.lng) });
  const reports = useQuery({ queryKey: ['reports', place.lat, place.lng], queryFn: () => journeysApi.reportsNear(place.lat, place.lng) });
  const centre = pulse.data?.cells[0];
  const counted = (pulse.data?.cells ?? []).filter((c) => c.level !== 'insufficient');

  return (
    <>
      <Card>
        <CardHeader icon={<Activity className="h-5 w-5" aria-hidden />} title="Community Pulse" description="From completed journeys, route feedback and reports in the last few weeks. Older signals count less." />
        {pulse.isPending ? <Skeleton className="h-10 w-full" /> : null}
        {pulse.isError ? <ErrorState message={pulse.error.message} onRetry={() => void pulse.refetch()} /> : null}
        {centre ? (
          <div className="space-y-1.5 text-sm">
            <p>Right here: <Badge tone={LEVEL[centre.level].tone}>{LEVEL[centre.level].text}</Badge></p>
            <p className="text-fg-muted">
              {centre.level === 'insufficient' ? 'An area needs at least 3 different contributors before it is shown.' : `Based on ${centre.contributors} people.`}
              {' '}Nearby: {counted.length} of {pulse.data!.cells.length} surrounding areas have enough data.
            </p>
          </div>
        ) : null}
      </Card>

      <Card>
        <CardHeader icon={<Flag className="h-5 w-5" aria-hidden />} title="Recent reports nearby" description="Infrastructure reports expire after 14 days, reports about people after 30. Reports about people are hidden until a moderator verifies them." />
        {reports.isPending ? <Skeleton className="h-16 w-full" /> : null}
        {reports.isError ? <ErrorState message={reports.error.message} onRetry={() => void reports.refetch()} /> : null}
        {reports.data?.reports.length === 0 ? <p className="text-sm text-fg-muted">No current reports around here.</p> : null}
        <ul className="space-y-2">{reports.data?.reports.map((r) => <ReportRow key={r.id} r={r} />)}</ul>
      </Card>

      <ReportForm place={place} />
    </>
  );
}

function ReportRow({ r }: { r: CommunityReportView & { status?: string } }) {
  return (
    <li className="rounded-xl bg-surface-muted/60 p-3 text-sm">
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="font-medium">{REPORT_CATEGORY_LABELS[r.category]}</span>
        <Badge tone={LABEL_TONE[r.label]}>{r.label}</Badge>
        {r.mine ? <Badge>Yours</Badge> : null}
        {r.demo ? <Badge tone="warning">Demo report</Badge> : null}
      </div>
      {r.description ? <p className="mt-1">{r.description}</p> : null}
      <p className="mt-1 text-xs text-fg-muted">{r.areaName ?? 'Nearby'} · {dayClock(r.occurredAt)}{r.status && r.status !== 'submitted' ? ` · ${r.status.replace('_', ' ')}` : ''}</p>
    </li>
  );
}

function ReportForm({ place }: { place: PickedPoint }) {
  const qc = useQueryClient();
  const [category, setCategory] = useState<Category>('poor_lighting');
  const [description, setDescription] = useState('');
  const submit = useMutation({
    mutationFn: () => journeysApi.report({ category, description: description.trim(), lat: place.lat, lng: place.lng }),
    onSuccess: () => {
      setDescription('');
      void qc.invalidateQueries({ queryKey: ['reports'] });
      void qc.invalidateQueries({ queryKey: ['pulse'] });
    },
  });
  const sensitive = SENSITIVE_REPORT_CATEGORIES.includes(category);
  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    submit.mutate();
  };

  return (
    <Card>
      <CardHeader icon={<ShieldCheck className="h-5 w-5" aria-hidden />} title="Report an issue here" description={`Near ${place.label}. Your name is never shown with a report.`} />
      <form onSubmit={onSubmit} className="space-y-3">
        <label className="block text-sm">
          <span className="mb-1.5 block font-medium">What did you notice?</span>
          <select className="h-11 w-full rounded-xl border border-border bg-surface px-3" value={category} onChange={(e) => setCategory(e.target.value as Category)}>
            {COMMUNITY_REPORT_CATEGORIES.map((c) => <option key={c} value={c}>{REPORT_CATEGORY_LABELS[c]}</option>)}
          </select>
        </label>
        <label className="block text-sm">
          <span className="mb-1.5 block font-medium">Details</span>
          <textarea className="min-h-[88px] w-full rounded-xl border border-border bg-surface p-3" maxLength={500} value={description} onChange={(e) => setDescription(e.target.value)} placeholder="e.g. Three streetlights out on the lane behind the market" required minLength={10} />
        </label>
        {sensitive ? (
          <Notice title="Reviewed before anyone sees it">Reports about people are checked by a moderator and only shown, without your name, if verified. Don’t include names, photos or phone numbers. If you are in danger now, call 112.</Notice>
        ) : (
          <p className="text-xs text-fg-muted">Shown to others as “Community reported” (not verified). The place is rounded to about 100 m.</p>
        )}
        <Button type="submit" fullWidth loading={submit.isPending} disabled={description.trim().length < 10}>Submit report</Button>
        {submit.isError ? <p role="alert" className="text-sm text-danger">{submit.error.message}</p> : null}
        {submit.isSuccess ? <p role="status" className="text-sm text-success">Thanks. Your report was submitted{sensitive ? ' for review' : ''}.</p> : null}
      </form>
    </Card>
  );
}

function MyReports() {
  const mine = useQuery({ queryKey: ['reports', 'mine'], queryFn: journeysApi.myReports });
  if (!mine.data?.reports.length) return null;
  return (
    <Card>
      <CardHeader title="Your reports" description="Only you see this list." />
      <ul className="space-y-2">{mine.data.reports.map((r) => <ReportRow key={r.id} r={r} />)}</ul>
    </Card>
  );
}
