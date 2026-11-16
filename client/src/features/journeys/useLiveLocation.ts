import { useEffect, useRef, useState } from 'react';
import { journeysApi } from '@/services/journeysApi';

const SEND_EVERY_MS = 30_000;

/**
 * While `enabled`, watches the device position and sends it at most every 30 seconds. Nothing is sent
 * when disabled, and the watch stops as soon as the journey ends or the toggle is turned off.
 * Positions are never logged or kept in the browser beyond the latest send time.
 */
export function useLiveLocation(tripId: string, enabled: boolean) {
  const [lastSentAt, setLastSentAt] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const lastSent = useRef(0);

  useEffect(() => {
    if (!enabled) {
      setError(null);
      return;
    }
    if (!('geolocation' in navigator)) {
      setError('This browser cannot share location.');
      return;
    }
    let cancelled = false;
    const id = navigator.geolocation.watchPosition(
      (pos) => {
        if (cancelled || Date.now() - lastSent.current < SEND_EVERY_MS) return;
        lastSent.current = Date.now();
        journeysApi
          .postLocation(tripId, { lat: pos.coords.latitude, lng: pos.coords.longitude, accuracyM: Math.min(10_000, Math.round(pos.coords.accuracy)) })
          .then(() => {
            if (cancelled) return;
            setLastSentAt(Date.now());
            setError(null);
          })
          .catch((err: Error) => {
            if (!cancelled) setError(err.message);
          });
      },
      (err) => {
        if (!cancelled) setError(err.code === 1 ? 'Location permission was denied, so nothing is being shared.' : 'Your location is unavailable right now.');
      },
      { enableHighAccuracy: true, maximumAge: 15_000, timeout: 30_000 },
    );
    return () => {
      cancelled = true;
      navigator.geolocation.clearWatch(id);
    };
  }, [tripId, enabled]);

  return { lastSentAt, error };
}
