import type { SosDelivery } from '@mahilasathi/shared';
import type { BadgeTone } from '@/components/ui';

export const CHANNEL_LABEL: Record<SosDelivery['channel'], string> = { in_app: 'In the app', circle_chat: 'Circle chat', sms: 'SMS' };
export const RESPONSE_LABEL = { seen: 'Has seen it', calling: 'Calling you', on_my_way: 'On the way' } as const;
const PURPOSE_LABEL: Record<SosDelivery['purpose'], string> = { alert: 'Alert', escalation: 'Reminder', update: 'Response notice', ended: '“SOS ended” notice' };

const clock = (iso: string) => new Intl.DateTimeFormat('en-IN', { hour: 'numeric', minute: '2-digit', timeZone: 'Asia/Kolkata' }).format(Date.parse(iso));

/**
 * Plain wording for a delivery's state. It never says "delivered" unless the channel confirmed it:
 * handed to a provider is "sent, not confirmed"; the development SMS adapter says nothing real was sent.
 */
export function describeDelivery(d: SosDelivery): { text: string; tone: BadgeTone; label: string } {
  const label = `${CHANNEL_LABEL[d.channel]}${d.purpose === 'alert' ? '' : ` · ${PURPOSE_LABEL[d.purpose]}`}`;
  switch (d.status) {
    case 'pending':
      return d.attempts > 0
        ? { label, tone: 'warning', text: `Retrying (try ${d.attempts + 1} of ${d.maxAttempts}${d.nextAttemptAt ? ` at ${clock(d.nextAttemptAt)}` : ''}): ${d.lastError ?? 'temporary problem'}` }
        : { label, tone: 'neutral', text: 'Sending…' };
    case 'sending':
      return { label, tone: 'neutral', text: 'Sending…' };
    case 'accepted':
      if (d.channel === 'in_app') return { label, tone: 'primary', text: 'Waiting in their app, not opened yet' };
      if (d.channel === 'sms' && d.devAdapter) return { label, tone: 'warning', text: 'Development SMS adapter: recorded only, no real SMS was sent' };
      return { label, tone: 'primary', text: d.channel === 'sms' ? 'Accepted by the SMS provider; delivery not confirmed' : 'Posted to the circle chat; delivery not confirmed' };
    case 'delivered':
      return { label, tone: 'success', text: `Seen in their app${d.confirmedAt ? ` at ${clock(d.confirmedAt)}` : ''}` };
    case 'failed':
      return { label, tone: 'danger', text: `Not delivered: ${d.lastError ?? 'failed'}` };
    case 'unavailable':
      return { label, tone: 'danger', text: `Not sent: ${d.lastError ?? 'this channel is not set up'}` };
    case 'skipped':
      return { label, tone: 'neutral', text: `Not needed: ${d.lastError ?? 'no longer required'}` };
  }
}

export const sinceClock = clock;
