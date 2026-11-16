import { BRAND, EMERGENCY_NUMBERS, SAFETY_DISCLAIMER, coverageSchema } from '@mahilasathi/shared';
import { useQuery } from '@tanstack/react-query';
import { ChevronRight, MapPin, Phone, Route, ShieldAlert, Users } from 'lucide-react';
import { Link } from 'react-router-dom';
import { Badge, Card, CardHeader, Notice } from '@/components/ui';
import { useMe } from '@/features/auth/useSession';
import { CoverageBadge } from '@/features/neighbourhoods/CoverageBadge';
import { useEmergencyContacts } from '@/features/profile/EmergencyContactsEditor';
import { apiRequest } from '@/services/apiClient';
import { z } from 'zod';

function greeting(date = new Date()): string {
  const h = date.getHours();
  if (h < 5) return 'Up late';
  if (h < 12) return 'Good morning';
  if (h < 17) return 'Good afternoon';
  return 'Good evening';
}

export function HomePage() {
  const me = useMe();
  const contacts = useEmergencyContacts();
  const area = me.data?.homeArea;
  const coverage = useQuery({
    queryKey: ['geo', 'coverage', area?.neighbourhood?.id ?? area?.district.id],
    queryFn: () =>
      apiRequest(
        `/geo/coverage?${new URLSearchParams(
          area!.neighbourhood ? { areaType: 'neighbourhood', areaId: area!.neighbourhood.id } : { areaType: 'district', areaId: area!.district.id },
        )}`,
        { schema: z.object({ coverage: coverageSchema }) },
      ),
    enabled: Boolean(area),
    // A first view starts a background assessment on the server; pick up the result for about a minute.
    refetchInterval: (q) => (q.state.data?.coverage.level === 'unknown' && q.state.dataUpdateCount < 7 ? 10_000 : false),
  });

  return (
    <div className="space-y-5">
      <section className="relative overflow-hidden rounded-3xl bg-primary p-6 text-primary-fg shadow-raised">
        <div aria-hidden className="absolute -right-10 -top-10 h-40 w-40 rounded-full bg-accent/30 blur-2xl" />
        <p className="text-sm font-medium opacity-80">{greeting()},</p>
        <h1 className="mt-0.5 text-[1.65rem] font-semibold leading-tight">{me.data?.displayName ?? 'there'}</h1>
        <p className="mt-2 max-w-sm text-sm leading-relaxed opacity-85">{BRAND.tagline}</p>
      </section>

      <Link to="/sos" className="flex items-center gap-3 rounded-2xl border-2 border-danger/50 bg-danger-soft/60 p-4 hover:bg-danger-soft">
        <span className="flex h-11 w-11 items-center justify-center rounded-xl bg-danger text-danger-fg"><ShieldAlert className="h-6 w-6" aria-hidden /></span>
        <span className="min-w-0 flex-1">
          <span className="block font-semibold">SOS</span>
          <span className="block text-sm text-fg-muted">Alert your Guardian Circle and emergency contacts</span>
        </span>
        <ChevronRight className="h-4 w-4 text-fg-muted" aria-hidden />
      </Link>

      <Card>
        <CardHeader
          icon={<MapPin className="h-5 w-5" aria-hidden />}
          title={area ? (area.neighbourhood?.name ?? `${area.district.name} district`) : 'Home area not set'}
          description={area ? [area.neighbourhood ? (area.city?.name ?? area.district.name) : null, area.state.name].filter(Boolean).join(', ') : 'Set it to join your neighbourhood community.'}
          action={
            <Link to="/profile" className="rounded-lg px-2 py-1 text-sm font-medium text-primary hover:bg-primary-soft">
              {area ? 'Change' : 'Set'}
            </Link>
          }
        />
        {area && coverage.data ? (
          <div className="flex flex-wrap items-center gap-2">
            <CoverageBadge coverage={coverage.data.coverage} />
            <span className="text-xs text-fg-muted">{coverage.data.coverage.summary}</span>
          </div>
        ) : null}
      </Card>

      <Link to="/plan" className="block">
        <Card className="flex items-center gap-3 transition-colors hover:bg-surface-muted/60">
          <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-primary-soft text-primary">
            <Route className="h-5 w-5" aria-hidden />
          </span>
          <div className="min-w-0 flex-1">
            <p className="flex flex-wrap items-center gap-x-2 gap-y-1 font-medium">
              Plan a journey
            </p>
            <p className="mt-0.5 text-sm text-fg-muted">Compare routes by Night Activity Score</p>
          </div>
          <ChevronRight className="h-4 w-4 shrink-0 text-fg-muted" aria-hidden />
        </Card>
      </Link>

      {contacts.data && contacts.data.contacts.length === 0 ? (
        <Notice tone="warning" title="No emergency contacts">
          <Link to="/profile" className="font-medium text-fg underline underline-offset-2">Add someone you trust</Link> so they can be reached if you raise an SOS.
        </Notice>
      ) : contacts.data ? (
        <Card className="flex items-center gap-3">
          <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-success-soft text-success">
            <Users className="h-5 w-5" aria-hidden />
          </span>
          <p className="flex-1 text-sm">
            <strong>{contacts.data.contacts.length}</strong> emergency {contacts.data.contacts.length === 1 ? 'contact' : 'contacts'} saved
          </p>
          <Link to="/profile" className="text-sm font-medium text-primary">Manage</Link>
        </Card>
      ) : null}

      <Card className="flex items-center gap-3">
        <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-accent-soft text-fg">
          <Phone className="h-5 w-5" aria-hidden />
        </span>
        <div className="min-w-0 flex-1 text-sm">
          <p className="font-medium">Emergency numbers (India)</p>
          <p className="text-fg-muted">
            All emergencies {EMERGENCY_NUMBERS.national} · Women helpline {EMERGENCY_NUMBERS.women_helpline_national}
          </p>
        </div>
        <a href={`tel:${EMERGENCY_NUMBERS.national}`} className="rounded-xl bg-surface-muted px-3 py-2 text-sm font-semibold text-fg hover:bg-border">
          Call {EMERGENCY_NUMBERS.national}
        </a>
      </Card>

      <p className="px-1 text-xs leading-relaxed text-fg-muted">{SAFETY_DISCLAIMER}</p>
    </div>
  );
}
