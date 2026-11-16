import { Compass, Home, Map, User, Users } from 'lucide-react';
import { NavLink } from 'react-router-dom';
import { cn } from '@/components/ui';

const items = [
  { to: '/', label: 'Home', icon: Home, end: true },
  { to: '/plan', label: 'Plan', icon: Map },
  { to: '/community', label: 'Community', icon: Users },
  { to: '/journeys', label: 'Journeys', icon: Compass },
  { to: '/profile', label: 'Profile', icon: User },
] as const;

export function BottomNav() {
  return (
    <nav
      aria-label="Main"
      className="pb-safe fixed inset-x-0 bottom-0 z-30 border-t border-border/70 bg-surface/95 backdrop-blur supports-[backdrop-filter]:bg-surface/85"
    >
      <ul className="mx-auto grid max-w-app grid-cols-5">
        {items.map(({ to, label, icon: Icon, ...rest }) => (
          <li key={to}>
            <NavLink
              to={to}
              end={'end' in rest ? rest.end : false}
              className={({ isActive }) =>
                cn(
                  'flex h-16 flex-col items-center justify-center gap-1 text-[0.7rem] font-medium transition-colors',
                  isActive ? 'text-primary' : 'text-fg-muted hover:text-fg',
                )
              }
            >
              {({ isActive }) => (
                <>
                  <span
                    className={cn(
                      'flex h-7 w-12 items-center justify-center rounded-full transition-colors',
                      isActive && 'bg-primary-soft',
                    )}
                  >
                    <Icon className="h-5 w-5" aria-hidden strokeWidth={isActive ? 2.25 : 1.75} />
                  </span>
                  {label}
                </>
              )}
            </NavLink>
          </li>
        ))}
      </ul>
    </nav>
  );
}
