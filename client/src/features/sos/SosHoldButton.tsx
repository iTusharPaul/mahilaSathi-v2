import { useEffect, useRef, useState } from 'react';
import { cn } from '@/components/ui';

const HOLD_MS = 1500;

/**
 * Press and hold to raise an SOS: quick on purpose, hard to trigger by accident. Works with touch, mouse
 * and keyboard (hold Space or Enter). Screen-reader users can use the separate "confirm" path instead.
 */
export function SosHoldButton({ onActivate, disabled }: { onActivate: () => void; disabled?: boolean }) {
  const [progress, setProgress] = useState(0);
  const started = useRef<number | null>(null);
  const frame = useRef<number | null>(null);
  const fired = useRef(false);
  // Activation is decided by a timer; animation frames only draw the ring. Frames can pause or be
  // throttled (background tab, low-power mode), and an SOS must not depend on them.
  const deadline = useRef<ReturnType<typeof setTimeout> | null>(null);

  const stop = () => {
    started.current = null;
    if (deadline.current !== null) clearTimeout(deadline.current);
    deadline.current = null;
    if (frame.current !== null) cancelAnimationFrame(frame.current);
    frame.current = null;
    if (!fired.current) setProgress(0);
  };
  const tick = () => {
    if (started.current === null) return;
    setProgress(Math.min(1, (performance.now() - started.current) / HOLD_MS));
    frame.current = requestAnimationFrame(tick);
  };
  const start = () => {
    if (disabled || started.current !== null) return;
    fired.current = false;
    started.current = performance.now();
    frame.current = requestAnimationFrame(tick);
    deadline.current = setTimeout(() => {
      fired.current = true;
      setProgress(1);
      stop();
      if ('vibrate' in navigator) navigator.vibrate?.(200);
      onActivate();
    }, HOLD_MS);
  };
  useEffect(() => {
    return () => {
      if (frame.current !== null) cancelAnimationFrame(frame.current);
      if (deadline.current !== null) clearTimeout(deadline.current);
    };
  }, []);

  const deg = Math.round(progress * 360);
  return (
    <button
      type="button"
      disabled={disabled}
      onPointerDown={(e) => {
        e.currentTarget.setPointerCapture(e.pointerId);
        start();
      }}
      onPointerUp={stop}
      onPointerCancel={stop}
      onPointerLeave={stop}
      onKeyDown={(e) => {
        if ((e.key === ' ' || e.key === 'Enter') && !e.repeat) {
          e.preventDefault();
          start();
        }
      }}
      onKeyUp={(e) => {
        if (e.key === ' ' || e.key === 'Enter') stop();
      }}
      onContextMenu={(e) => e.preventDefault()}
      aria-label="Hold for 1.5 seconds to send an SOS"
      className={cn('relative mx-auto flex h-48 w-48 select-none items-center justify-center rounded-full p-2 transition-transform active:scale-[0.98] disabled:opacity-50', 'touch-none')}
      style={{ background: `conic-gradient(rgb(var(--color-danger)) ${deg}deg, rgb(var(--color-danger) / 0.18) ${deg}deg)` }}
    >
      <span className="flex h-full w-full flex-col items-center justify-center rounded-full bg-danger text-danger-fg shadow-raised">
        <span className="text-4xl font-bold tracking-wide">SOS</span>
        <span className="mt-1 text-sm opacity-90">{progress > 0 && progress < 1 ? 'Keep holding…' : 'Hold to send'}</span>
      </span>
    </button>
  );
}
