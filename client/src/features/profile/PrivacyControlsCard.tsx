import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Download, History, Lock, MapPinOff } from 'lucide-react';
import { useState } from 'react';
import { Button, Card, CardHeader } from '@/components/ui';
import { privacyApi } from '@/services/sosApi';

/** Download my data · stop all location sharing now · clear journey history. */
export function PrivacyControlsCard() {
  const qc = useQueryClient();
  const [confirmClear, setConfirmClear] = useState(false);
  const stop = useMutation({
    mutationFn: privacyApi.stopAllLocationSharing,
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['journeys'] });
      void qc.invalidateQueries({ queryKey: ['sos'] });
    },
  });
  const clear = useMutation({
    mutationFn: privacyApi.clearJourneyHistory,
    onSuccess: () => {
      setConfirmClear(false);
      void qc.invalidateQueries({ queryKey: ['journeys'] });
    },
  });
  const exportData = useMutation({
    mutationFn: privacyApi.exportData,
    onSuccess: (data) => {
      // Built in memory and saved by the browser; nothing is uploaded anywhere.
      const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
      const a = document.createElement('a');
      a.href = url;
      a.download = 'mahilasathi-my-data.json';
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    },
  });

  return (
    <Card>
      <CardHeader icon={<Lock className="h-5 w-5" aria-hidden />} title="Privacy controls" />
      <div className="space-y-4 text-sm">
        <div>
          <Button variant="secondary" icon={<MapPinOff className="h-4 w-4" aria-hidden />} loading={stop.isPending} onClick={() => stop.mutate()}>Stop sharing my location everywhere</Button>
          <p className="mt-1 text-xs text-fg-muted">Turns off live location on any journey and on an active SOS, and deletes the stored points. Alerts and statuses keep working.</p>
          {stop.data ? <p role="status" className="mt-1 text-success">Stopped on {stop.data.journeys} {stop.data.journeys === 1 ? 'journey' : 'journeys'}{stop.data.sos ? ' and your SOS' : ''}.</p> : null}
          {stop.isError ? <p role="alert" className="mt-1 text-danger">{stop.error.message}</p> : null}
        </div>
        <div>
          <Button variant="secondary" icon={<Download className="h-4 w-4" aria-hidden />} loading={exportData.isPending} onClick={() => exportData.mutate()}>Download my data</Button>
          <p className="mt-1 text-xs text-fg-muted">A JSON file with your profile, contacts, journeys, reports and SOS history. It contains precise locations: keep it safe.</p>
          {exportData.isError ? <p role="alert" className="mt-1 text-danger">{exportData.error.message}</p> : null}
        </div>
        <div>
          {confirmClear ? (
            <div className="flex flex-wrap items-center gap-2">
              <span>Delete all finished journeys?</span>
              <Button size="sm" loading={clear.isPending} onClick={() => clear.mutate()}>Delete</Button>
              <Button size="sm" variant="ghost" onClick={() => setConfirmClear(false)}>Cancel</Button>
            </div>
          ) : (
            <Button variant="ghost" icon={<History className="h-4 w-4" aria-hidden />} onClick={() => setConfirmClear(true)}>Clear journey history</Button>
          )}
          <p className="mt-1 text-xs text-fg-muted">Removes finished journeys, their routes and locations, and their contribution to the Community Pulse.</p>
          {clear.data ? <p role="status" className="mt-1 text-success">Deleted {clear.data.deleted} {clear.data.deleted === 1 ? 'journey' : 'journeys'}.</p> : null}
          {clear.isError ? <p role="alert" className="mt-1 text-danger">{clear.error.message}</p> : null}
        </div>
      </div>
    </Card>
  );
}
