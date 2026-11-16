import type React from 'react';
import { createBrowserRouter } from 'react-router-dom';
import { AppShell } from '@/components/layout/AppShell';
import { RouteError } from '@/components/layout/RouteError';
import { RedirectIfSignedIn, RequireSession } from '@/features/auth/RequireSession';
import { SignInPage } from '@/pages/auth/SignInPage';
import { WelcomePage } from '@/pages/auth/WelcomePage';
import { HomePage } from '@/pages/HomePage';
import { NotFoundPage } from '@/pages/NotFoundPage';
import { SosAlertPage } from '@/pages/sos/SosAlertPage';
import { SosPage } from '@/pages/sos/SosPage';

/**
 * Most screens load on first visit (route-level code splitting). Home, sign-in and both SOS screens are
 * deliberately in the main bundle: in an emergency on a weak connection, SOS must never wait for a download.
 */
const page = <M,>(load: () => Promise<M>, pick: (m: M) => React.ComponentType) => async () => ({ Component: pick(await load()) });

export const router = createBrowserRouter([
  {
    element: <RedirectIfSignedIn />,
    errorElement: <RouteError />,
    children: [
      { path: 'welcome', element: <WelcomePage /> },
      { path: 'sign-in', element: <SignInPage /> },
    ],
  },
  {
    element: <RequireSession onboarding="incomplete" />,
    errorElement: <RouteError />,
    children: [{ path: 'onboarding', lazy: page(() => import('@/pages/onboarding/OnboardingPage'), (m) => m.OnboardingPage) }],
  },
  {
    element: <AppShell />,
    errorElement: <RouteError />,
    children: [
      { path: 'design-system', lazy: page(() => import('@/pages/DesignSystemPage'), (m) => m.DesignSystemPage) },
      // Moderators sign in with the server's admin token, not a user account.
      { path: 'moderation', lazy: page(() => import('@/pages/ModerationPage'), (m) => m.ModerationPage) },
      {
        element: <RequireSession onboarding="complete" />,
        children: [
          { index: true, element: <HomePage /> },
          { path: 'plan', lazy: page(() => import('@/pages/PlanPage'), (m) => m.PlanPage) },
          {
            lazy: page(() => import('@/features/community/chat/ChatLayout'), (m) => m.ChatLayout),
            children: [
              { path: 'community', lazy: page(() => import('@/pages/community/CommunityPage'), (m) => m.CommunityPage) },
              { path: 'community/:channelId', lazy: page(() => import('@/pages/community/ChannelPage'), (m) => m.ChannelPage) },
              { path: 'circle', lazy: page(() => import('@/pages/community/CirclePage'), (m) => m.CirclePage) },
            ],
          },
          { path: 'community/reports', lazy: page(() => import('@/pages/community/AreaReportsPage'), (m) => m.AreaReportsPage) },
          { path: 'journeys', lazy: page(() => import('@/pages/journeys/JourneysPage'), (m) => m.JourneysPage) },
          { path: 'journeys/shared/:shareId', lazy: page(() => import('@/pages/journeys/SharedJourneyPage'), (m) => m.SharedJourneyPage) },
          { path: 'journeys/:tripId', lazy: page(() => import('@/pages/journeys/JourneyDetailPage'), (m) => m.JourneyDetailPage) },
          { path: 'sos', element: <SosPage /> },
          { path: 'sos/alerts/:sosId', element: <SosAlertPage /> },
          { path: 'profile', lazy: page(() => import('@/pages/ProfilePage'), (m) => m.ProfilePage) },
        ],
      },
      { path: '*', element: <NotFoundPage /> },
    ],
  },
]);
