import crypto from 'node:crypto';
import { cellToLatLng, gridDisk, latLngToCell } from 'h3-js';
import {
  SENSITIVE_REPORT_CATEGORIES,
  type CommunityReportView,
  type LngLat,
  type PulseCell,
} from '@mahilasathi/shared';
import type { AuditRepository } from '../../repositories/auditRepository.js';
import type { CommunityReportRow, PulseRepository } from '../../repositories/pulseRepository.js';
import type { SafetyRepository } from '../../repositories/safetyRepository.js';
import type { UserRow } from '../../repositories/userRepository.js';
import { AppError, notFound } from '../../utils/errors.js';
import type { Clock } from '../../utils/crypto.js';
import type { GeoRegistry } from '../geography/geoRegistry.js';
import { CORRIDOR_RESOLUTION, corridorCells } from '../journeys/corridor.js';
import { PULSE, aggregate, contributorBucket, pulseLevel, type SignalKind } from './pulseMath.js';

const DAY = 86_400_000;
export const REPORT_LIMITS = { perDay: 10, duplicateWindowMs: DAY, infraTtlDays: 14, incidentTtlDays: 30 } as const;
/** Base weights before trust: an unverified infrastructure report counts half a verified one. */
const WEIGHTS = { journey: 0.3, feedback: 0.5, infraUnverified: 0.5, infraVerified: 1, incidentVerified: 1.5 } as const;

const LABEL: Record<CommunityReportRow['status'], CommunityReportView['label'] | null> = {
  submitted: 'Community reported',
  under_review: 'Under review',
  verified: 'Verified information',
  rejected: null,
  expired: null,
};

export function createPulseService(deps: { repo: PulseRepository; safety: SafetyRepository; registry: GeoRegistry; audit: AuditRepository; clock: Clock }) {
  const { repo, safety, registry, audit, clock } = deps;
  const now = () => clock().getTime();
  const iso = (ms = now()) => new Date(ms).toISOString();

  /**
   * Trust weighting: new accounts count half; people with two or more rejected reports count a quarter;
   * suspended accounts contribute nothing.
   */
  function trust(user: UserRow): number {
    // Fictional demo accounts never contribute to community intelligence.
    if (user.is_demo === 1) return 0;
    const suspended = safety.suspendedUntil(user.id);
    if (suspended && Date.parse(suspended) > now()) return 0;
    if (repo.rejectedCount(user.id) >= 2) return 0.25;
    if (now() - Date.parse(user.created_at) < 7 * DAY) return 0.5;
    return 1;
  }

  function recompute(cells: Iterable<string>): void {
    const at = now();
    for (const cell of new Set(cells)) repo.upsertAggregate(cell, aggregate(repo.signalsForCell(cell, iso(at)), at), iso(at));
  }

  function addSignals(user: UserRow, cells: string[], kind: SignalKind, polarity: 1 | -1, baseWeight: number, sourceId: string): void {
    const t = trust(user);
    if (t === 0 || cells.length === 0) return;
    const created = iso();
    const expires = iso(now() + PULSE.ttlDays[kind] * DAY);
    repo.insertSignals([...new Set(cells)].map((cell) => ({ cell, kind, polarity, weight: baseWeight * t, contributorId: user.id, sourceId, createdAt: created, expiresAt: expires })));
    recompute(cells);
  }

  const areaName = (cell: string) => {
    const [lat, lng] = cellToLatLng(cell);
    const r = registry.resolve(lat, lng);
    return r.neighbourhood?.name ?? r.district?.name ?? null;
  };

  function toView(r: CommunityReportRow, viewerId: string): CommunityReportView | null {
    const sensitive = SENSITIVE_REPORT_CATEGORIES.includes(r.category);
    const mine = r.user_id === viewerId;
    // Allegations about people are never shown to others unless verified by a moderator.
    if (sensitive && r.status !== 'verified' && !mine) return null;
    const label = LABEL[r.status];
    if (!label) return null;
    return {
      id: r.id,
      category: r.category as CommunityReportView['category'],
      label,
      description: !sensitive || r.status === 'verified' || mine ? r.description : null,
      areaName: r.area_name,
      occurredAt: r.occurred_at,
      expiresAt: r.expires_at,
      mine,
      demo: r.is_demo === 1,
    };
  }

  return {
    trust,
    recompute,

    /** Completed journey: a light positive signal on the privacy-trimmed corridor. */
    journeyCompleted(user: UserRow, tripId: string, corridor: string[], feedback?: 'comfortable' | 'uneasy'): void {
      addSignals(user, corridor, 'journey_completed', 1, WEIGHTS.journey, tripId);
      if (feedback) addSignals(user, corridor, 'route_feedback', feedback === 'comfortable' ? 1 : -1, WEIGHTS.feedback, `${tripId}:feedback`);
    },

    /** Pulse value per cell for route scoring: only cells with enough distinct contributors. */
    routeCells(geometry: LngLat[]): { cells: string[]; sufficient: Map<string, number>; updatedAt: string | null } {
      const cells = corridorCells(geometry, 0, 150);
      const usable = repo.aggregates(cells).filter((a) => a.contributors >= PULSE.minContributors);
      const sufficient = new Map(usable.map((a) => [a.cell, a.value]));
      const updatedAt = usable.map((a) => a.updated_at).sort().at(-1) ?? null;
      return { cells, sufficient, updatedAt };
    },

    /** Aggregated pulse around a point (centre cell and its neighbours). No individual data. */
    around(lat: number, lng: number): PulseCell[] {
      const cells = gridDisk(latLngToCell(lat, lng, CORRIDOR_RESOLUTION), 1);
      const found = new Map(repo.aggregates(cells).map((a) => [a.cell, a]));
      return cells.map((cell) => {
        const a = found.get(cell);
        if (!a) return { cell, level: 'insufficient', value: 0.5, contributors: 'fewer than 3', updatedAt: iso() };
        const level = pulseLevel(a);
        return { cell, level, value: level === 'insufficient' ? 0.5 : Math.round(a.value * 100) / 100, contributors: contributorBucket(a.contributors), updatedAt: a.updated_at };
      });
    },

    // ─── Incident reports ─────────────────────────────────────────────────────

    createReport(user: UserRow, input: { category: string; description: string; lat: number; lng: number; occurredAt?: string | undefined }): CommunityReportView {
      const r = registry.resolve(input.lat, input.lng);
      if (!r.inNcr) throw new AppError('VALIDATION_FAILED', 'Reports can only be made for places within NCR.');
      if (repo.countRecentByUser(user.id, iso(now() - DAY)) >= REPORT_LIMITS.perDay) {
        throw new AppError('RATE_LIMITED', `You can submit up to ${REPORT_LIMITS.perDay} reports a day.`);
      }
      const cell = latLngToCell(input.lat, input.lng, CORRIDOR_RESOLUTION);
      if (repo.duplicateExists(user.id, cell, input.category, iso(now() - REPORT_LIMITS.duplicateWindowMs))) {
        throw new AppError('CONFLICT', 'You already reported this kind of issue here in the last 24 hours.');
      }
      const occurred = input.occurredAt ? Date.parse(input.occurredAt) : now();
      if (occurred > now() + 5 * 60_000 || occurred < now() - 7 * DAY) throw new AppError('VALIDATION_FAILED', 'The time must be within the last 7 days.');
      const sensitive = SENSITIVE_REPORT_CATEGORIES.includes(input.category);
      const row: Omit<CommunityReportRow, 'review_note' | 'reviewed_at'> = {
        id: crypto.randomUUID(),
        user_id: user.id,
        category: input.category,
        description: input.description,
        cell,
        // ~100 m precision: enough to place the issue, not enough to pinpoint the reporter.
        approx_lat: Math.round(input.lat * 1000) / 1000,
        approx_lng: Math.round(input.lng * 1000) / 1000,
        area_name: r.neighbourhood?.name ?? r.district?.name ?? null,
        occurred_at: iso(occurred),
        status: sensitive ? 'under_review' : 'submitted',
        created_at: iso(),
        expires_at: iso(now() + (sensitive ? REPORT_LIMITS.incidentTtlDays : REPORT_LIMITS.infraTtlDays) * DAY),
        is_demo: user.is_demo === 1 ? 1 : 0,
      };
      repo.insertReport(row);
      // Unverified allegations never affect the Pulse; infrastructure reports count at half weight until verified.
      if (!sensitive) addSignals(user, [cell], 'infra_report', -1, WEIGHTS.infraUnverified, row.id);
      audit.record({ actorType: 'user', actorId: user.id, action: 'community.report_submitted', targetType: 'community_report', targetId: row.id, metadata: { category: row.category } });
      return toView({ ...row, review_note: null, reviewed_at: null }, user.id)!;
    },

    reportsNear(user: UserRow, lat: number, lng: number): CommunityReportView[] {
      const cells = gridDisk(latLngToCell(lat, lng, CORRIDOR_RESOLUTION), 2);
      return repo.reportsInCells(cells, iso()).map((r) => toView(r, user.id)).filter((v): v is CommunityReportView => v !== null);
    },

    myReports(user: UserRow): (CommunityReportView & { status: CommunityReportRow['status'] })[] {
      return repo.reportsByUser(user.id).map((r) => ({ ...(toView(r, user.id) ?? { id: r.id, category: r.category as CommunityReportView['category'], label: 'Community reported' as const, description: r.description, areaName: r.area_name, occurredAt: r.occurred_at, expiresAt: r.expires_at, mine: true, demo: r.is_demo === 1 }), status: r.status }));
    },

    // ─── Moderation ───────────────────────────────────────────────────────────

    reviewQueue: () => repo.reviewQueue().map((r) => ({ id: r.id, category: r.category, description: r.description, areaName: r.area_name, status: r.status, occurredAt: r.occurred_at, createdAt: r.created_at, demo: r.is_demo === 1 })),

    review(reportId: string, decision: 'verify' | 'reject', note: string): { status: string } {
      const r = repo.report(reportId);
      if (!r) throw notFound('Report');
      if (!['submitted', 'under_review'].includes(r.status)) throw new AppError('CONFLICT', 'This report has already been reviewed.');
      const touched = repo.deleteSignalsForSource(r.id);
      if (decision === 'reject') {
        repo.setReportStatus(r.id, 'rejected', note, iso());
      } else {
        const sensitive = SENSITIVE_REPORT_CATEGORIES.includes(r.category);
        repo.setReportStatus(r.id, 'verified', note, iso(), iso(now() + (sensitive ? REPORT_LIMITS.incidentTtlDays : REPORT_LIMITS.infraTtlDays) * DAY));
        const created = iso();
        const kind: SignalKind = sensitive ? 'incident_verified' : 'infra_report';
        if (r.is_demo === 1) {
          recompute(touched);
          audit.record({ actorType: 'admin', action: 'community.report_verified', targetType: 'community_report', targetId: r.id, metadata: { demo: true } });
          return { status: 'verified' };
        }
        // Verified signals carry full weight regardless of the reporter's trust: a moderator vouched for them.
        repo.insertSignals([{ cell: r.cell, kind, polarity: -1, weight: sensitive ? WEIGHTS.incidentVerified : WEIGHTS.infraVerified, contributorId: r.user_id, sourceId: r.id, createdAt: created, expiresAt: iso(now() + PULSE.ttlDays[kind] * DAY) }]);
        touched.push(r.cell);
      }
      recompute(touched);
      audit.record({ actorType: 'admin', action: `community.report_${decision === 'verify' ? 'verified' : 'rejected'}`, targetType: 'community_report', targetId: r.id });
      return { status: decision === 'verify' ? 'verified' : 'rejected' };
    },

    /** Hourly: expire reports, drop expired signals, and re-apply time decay to every aggregate. */
    maintain(): { expiredReports: number; purgedSignals: number } {
      const expiredReports = repo.expireReports(iso());
      const purgedSignals = repo.purgeSignals(iso());
      recompute([...repo.cellsWithSignals(), ...repo.aggregateCells()]);
      return { expiredReports, purgedSignals };
    },

    forgetUser(userId: string): void {
      const cells = repo.deleteSignalsForContributor(userId);
      repo.deleteReportsByUser(userId);
      recompute(cells);
    },

    areaName,
  };
}

export type PulseService = ReturnType<typeof createPulseService>;
