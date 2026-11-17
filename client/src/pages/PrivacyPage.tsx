import { EMERGENCY_NUMBERS } from '@mahilasathi/shared';
import { ArrowLeft } from 'lucide-react';
import type { ReactNode } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Notice } from '@/components/ui';
import { usePublicConfig } from '@/hooks/useSystem';

const UPDATED = '18 November 2026';

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="space-y-2">
      <h2 className="text-base font-semibold">{title}</h2>
      <div className="space-y-2 text-sm leading-relaxed text-fg-muted [&_li]:ml-4 [&_li]:list-disc [&_strong]:text-fg">{children}</div>
    </section>
  );
}

/**
 * Plain-language privacy notice, readable before signing in. It must match what the server actually stores
 * (docs/data-classification.md); change both together.
 */
export function PrivacyPage() {
  const navigate = useNavigate();
  const config = usePublicConfig();
  const smsSimulated = config.data?.providers.sms.mode !== 'live';

  return (
    <div className="pt-safe mx-auto min-h-dvh max-w-app px-5 pb-12">
      <div className="flex h-14 items-center">
        <button
          type="button"
          onClick={() => (window.history.length > 1 ? navigate(-1) : navigate('/'))}
          className="-ml-2 flex h-10 items-center gap-1 rounded-xl px-2 text-sm text-fg-muted hover:text-fg"
        >
          <ArrowLeft className="h-4 w-4" aria-hidden /> Back
        </button>
      </div>

      <article className="mt-4 space-y-6">
        <header>
          <h1 className="text-2xl font-semibold">Privacy notice</h1>
          <p className="mt-1 text-sm text-fg-muted">Last updated {UPDATED}. This is how mahilaSathi handles your data, in plain words.</p>
        </header>

        <Notice tone="warning" title="mahilaSathi is not an emergency service">
          In an emergency, call {EMERGENCY_NUMBERS.national}.{' '}
          {smsSimulated
            ? 'On this server emergency SMS is simulated: no text message reaches a real phone. Guardians who use the app do get in-app and push alerts.'
            : 'Alerts depend on phone networks and other people’s devices, so they can be late or fail.'}
        </Notice>

        <Section title="What we collect and why">
          <ul className="space-y-1.5">
            <li><strong>To sign you in:</strong> your Google account id and verified email address (or, for phone sign-in, your mobile number). Your email and number are never shown to other members; you see them masked.</li>
            <li><strong>Your profile:</strong> an optional display name, a pseudonym for the community, and your home area as an area name, never an address.</li>
            <li><strong>Route comparisons:</strong> the start, destination and time you enter, to score routes. Deleted after 24 hours.</li>
            <li><strong>Journeys:</strong> where you are going and check-ins. Exact start and end points are cleared 30 days after the journey ends. Your live location is recorded only while you have location sharing on.</li>
            <li><strong>SOS:</strong> the alert, who was alerted, and your location only if your SOS settings allow it.</li>
            <li><strong>Emergency contacts:</strong> names and numbers you add, so they can be alerted. Only you can see them.</li>
            <li><strong>Community:</strong> channel messages, area reports and reports about people, shown under your pseudonym.</li>
            <li><strong>Security:</strong> a record of sign-ins and important actions, without locations, phone numbers or message text.</li>
          </ul>
          <p>We do not sell your data, show ads, or use it to profile you.</p>
        </Section>

        <Section title="Who can see it">
          <ul className="space-y-1.5">
            <li><strong>Other members</strong> see your pseudonym and what you post in the community, never your email, number or exact location.</li>
            <li><strong>Your guardians</strong> (people you add to your Guardian Circle) see journeys you share with them, at the level of detail you pick, and your SOS alerts.</li>
            <li><strong>Moderators</strong> see reports and the audit record to keep the community safe.</li>
          </ul>
        </Section>

        <Section title="Services that process data for us">
          <ul className="space-y-1.5">
            <li><strong>Google</strong> confirms who you are when you continue with Google.</li>
            <li><strong>Geoapify</strong> receives the route points you compare, to calculate routes and draw the map.</li>
            <li><strong>Nexconn</strong> carries community chat messages.</li>
            <li><strong>Your browser’s push service</strong> (Google, Apple, Microsoft or Mozilla) delivers notifications, if you turn them on.</li>
            <li><strong>Render and Cloudflare</strong> host and protect the app. Servers are in Singapore.</li>
          </ul>
        </Section>

        <Section title="Your choices and rights">
          <ul className="space-y-1.5">
            <li>Turn location sharing off at any time; your stored live points are deleted straight away.</li>
            <li>Download a copy of your data, or delete your account, from <Link to="/profile" className="text-primary hover:underline">Profile</Link>. Deleting removes your sign-in details, name, home area, emergency contacts, journeys and SOS history. Your pseudonym and the security record are kept, without contact details, so past moderation decisions still make sense.</li>
            <li>You consent by signing in, and you can withdraw that consent by deleting your account. This follows India’s Digital Personal Data Protection Act, 2023.</li>
          </ul>
        </Section>

        <Section title="Questions or complaints">
          <p>
            mahilaSathi is an early test by a small team. Contact us through the{' '}
            <a href="https://github.com/iTusharPaul/mahilaSathi-v2/issues" target="_blank" rel="noreferrer" className="text-primary hover:underline">project’s issue page</a>.
            Don’t post personal details there; ask us for a private way to reach you.
          </p>
        </Section>
      </article>
    </div>
  );
}
