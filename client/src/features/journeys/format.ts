import type { ShareLevel, TripStatus } from '@mahilasathi/shared';
import type { BadgeTone } from '@/components/ui';

export const STATUS_META: Record<TripStatus, { label: string; tone: BadgeTone }> = {
  CREATED: { label: 'Not started', tone: 'neutral' },
  ACTIVE: { label: 'On the way', tone: 'primary' },
  DELAYED: { label: 'Running late', tone: 'warning' },
  ESCALATED: { label: 'Circle alerted', tone: 'danger' },
  ARRIVED: { label: 'Arrived', tone: 'success' },
  CANCELLED: { label: 'Cancelled', tone: 'neutral' },
};

export const SHARE_LEVEL_META: Record<ShareLevel, { label: string; description: string }> = {
  status: { label: 'Status only', description: 'Started, checked in, running late, arrived. No location.' },
  approximate: { label: 'Approximate', description: 'Status plus the area you are in and progress, if you turn on live location.' },
  precise: { label: 'Precise', description: 'Status, your route and your exact live position, if you turn on live location.' },
};

const IST = 'Asia/Kolkata';
export const clock = (iso: string | null) =>
  iso ? new Intl.DateTimeFormat('en-IN', { hour: 'numeric', minute: '2-digit', timeZone: IST }).format(Date.parse(iso)) : '—';
export const dayClock = (iso: string) =>
  new Intl.DateTimeFormat('en-IN', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', timeZone: IST }).format(Date.parse(iso));

export function minutesFromNow(iso: string | null, now = Date.now()): number | null {
  return iso ? Math.round((Date.parse(iso) - now) / 60_000) : null;
}

export const UNDERWAY: TripStatus[] = ['ACTIVE', 'DELAYED', 'ESCALATED'];
