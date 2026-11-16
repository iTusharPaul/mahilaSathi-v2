import { BRAND, EMERGENCY_NUMBERS } from '@mahilasathi/shared';
import { EyeOff, Route, ShieldCheck, Users } from 'lucide-react';
import { Link } from 'react-router-dom';
import { BrandMark } from '@/components/layout/BrandMark';

const points = [
  { icon: Route, title: 'Compare routes at night', body: 'See how active each route is likely to be, with the reasons and the gaps in the data.' },
  { icon: Users, title: 'Stay accompanied', body: 'Share journeys with people you trust, and connect with other women only when you both agree.' },
  { icon: EyeOff, title: 'Private by default', body: 'Use a pseudonym. Your phone number and exact location are never shown to the community.' },
];

export function WelcomePage() {
  return (
    <div className="pt-safe mx-auto flex min-h-dvh max-w-app flex-col px-5 pb-8">
      <div className="flex flex-1 flex-col justify-center py-10">
        <BrandMark className="h-14 w-14" />
        <h1 className="mt-6 text-[2rem] font-semibold leading-tight">
          mahila<span className="text-primary">Sathi</span>
        </h1>
        <p className="mt-1 text-lg font-medium text-fg-muted">{BRAND.tagline}</p>

        <ul className="mt-8 space-y-5">
          {points.map(({ icon: Icon, title, body }) => (
            <li key={title} className="flex gap-3.5">
              <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-primary-soft text-primary">
                <Icon className="h-5 w-5" aria-hidden />
              </span>
              <div>
                <p className="font-medium">{title}</p>
                <p className="mt-0.5 text-sm text-fg-muted">{body}</p>
              </div>
            </li>
          ))}
        </ul>
      </div>

      <div className="space-y-3">
        <Link
          to="/sign-in"
          className="flex h-14 w-full items-center justify-center rounded-2xl bg-primary text-base font-medium text-primary-fg shadow-sm transition-colors hover:bg-primary/90"
        >
          Get started
        </Link>
        <p className="flex items-start gap-2 text-xs leading-relaxed text-fg-muted">
          <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
          mahilaSathi gives you context, not guarantees, and is not an emergency service. In an emergency, call {EMERGENCY_NUMBERS.national}.
        </p>
      </div>
    </div>
  );
}
