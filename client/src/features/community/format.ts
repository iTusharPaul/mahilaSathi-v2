const IST = 'Asia/Kolkata';

export function formatTime(ms: number): string {
  return new Intl.DateTimeFormat('en-IN', { hour: 'numeric', minute: '2-digit', timeZone: IST }).format(ms);
}

export function formatDayTime(ms: number): string {
  const d = new Date(ms);
  const today = new Date();
  const sameDay = d.toLocaleDateString('en-IN', { timeZone: IST }) === today.toLocaleDateString('en-IN', { timeZone: IST });
  return sameDay
    ? formatTime(ms)
    : new Intl.DateTimeFormat('en-IN', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', timeZone: IST }).format(ms);
}

export function formatWindow(startIso: string, endIso: string): string {
  return `${formatDayTime(Date.parse(startIso))} – ${formatTime(Date.parse(endIso))}`;
}

export const INFRA_LABELS: Record<string, string> = {
  poor_lighting: 'Poorly lit stretch',
  broken_streetlight: 'Broken streetlight',
  closed_establishment: 'Establishment closed',
  road_obstruction: 'Road obstruction',
  transport_issue: 'Transport issue',
  other: 'Other update',
};

export const REPORT_LABELS: Record<string, string> = {
  harassment: 'Harassment',
  threat: 'Threat or intimidation',
  spam: 'Spam',
  sharing_personal_info: 'Sharing personal information',
  inappropriate: 'Inappropriate content',
  impersonation: 'Impersonation',
  other: 'Something else',
};
