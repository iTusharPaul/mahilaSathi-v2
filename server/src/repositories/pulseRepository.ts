import crypto from 'node:crypto';
import type { Db } from '../db/connection.js';
import type { CellAggregate, Signal, SignalKind } from '../services/pulse/pulseMath.js';

export interface CommunityReportRow {
  id: string;
  user_id: string;
  category: string;
  description: string;
  cell: string;
  approx_lat: number;
  approx_lng: number;
  area_name: string | null;
  occurred_at: string;
  status: 'submitted' | 'under_review' | 'verified' | 'rejected' | 'expired';
  review_note: string | null;
  reviewed_at: string | null;
  created_at: string;
  expires_at: string;
  is_demo: number;
}

export function createPulseRepository(db: Db) {
  return {
    insertSignals(rows: { cell: string; kind: SignalKind; polarity: 1 | -1; weight: number; contributorId: string; sourceId: string; createdAt: string; expiresAt: string }[]): void {
      const stmt = db.prepare(
        `INSERT INTO community_pulse_signals (id, cell, kind, polarity, weight, contributor_id, source_id, created_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      db.transaction(() => {
        for (const r of rows) stmt.run(crypto.randomUUID(), r.cell, r.kind, r.polarity, r.weight, r.contributorId, r.sourceId, r.createdAt, r.expiresAt);
      })();
    },
    deleteSignalsForSource(sourceId: string): string[] {
      const cells = (db.prepare('SELECT DISTINCT cell FROM community_pulse_signals WHERE source_id = ?').all(sourceId) as { cell: string }[]).map((r) => r.cell);
      db.prepare('DELETE FROM community_pulse_signals WHERE source_id = ?').run(sourceId);
      return cells;
    },
    deleteSignalsForContributor(userId: string): string[] {
      const cells = (db.prepare('SELECT DISTINCT cell FROM community_pulse_signals WHERE contributor_id = ?').all(userId) as { cell: string }[]).map((r) => r.cell);
      db.prepare('DELETE FROM community_pulse_signals WHERE contributor_id = ?').run(userId);
      return cells;
    },
    signalsForCell(cell: string, now: string): Signal[] {
      return (
        db
          .prepare('SELECT kind, polarity, weight, contributor_id, created_at, expires_at FROM community_pulse_signals WHERE cell = ? AND expires_at > ?')
          .all(cell, now) as { kind: SignalKind; polarity: 1 | -1; weight: number; contributor_id: string; created_at: string; expires_at: string }[]
      ).map((r) => ({ kind: r.kind, polarity: r.polarity, weight: r.weight, contributorId: r.contributor_id, createdAt: r.created_at, expiresAt: r.expires_at }));
    },
    aggregateCells: () => (db.prepare('SELECT cell FROM community_aggregates').all() as { cell: string }[]).map((r) => r.cell),
    cellsWithSignals: () => (db.prepare('SELECT DISTINCT cell FROM community_pulse_signals').all() as { cell: string }[]).map((r) => r.cell),
    purgeSignals: (now: string) => db.prepare('DELETE FROM community_pulse_signals WHERE expires_at <= ?').run(now).changes,

    upsertAggregate(cell: string, a: CellAggregate, now: string): void {
      if (a.contributors === 0) {
        db.prepare('DELETE FROM community_aggregates WHERE cell = ?').run(cell);
        return;
      }
      db.prepare(
        `INSERT INTO community_aggregates (cell, positive, negative, contributors, value, updated_at) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (cell) DO UPDATE SET positive = excluded.positive, negative = excluded.negative, contributors = excluded.contributors,
           value = excluded.value, updated_at = excluded.updated_at`,
      ).run(cell, a.positive, a.negative, a.contributors, a.value, now);
    },
    aggregates(cells: string[]): { cell: string; contributors: number; value: number; updated_at: string }[] {
      if (cells.length === 0) return [];
      return db
        .prepare('SELECT cell, contributors, value, updated_at FROM community_aggregates WHERE cell IN (SELECT value FROM json_each(?))')
        .all(JSON.stringify(cells)) as { cell: string; contributors: number; value: number; updated_at: string }[];
    },

    // ─── Reports ──────────────────────────────────────────────────────────────
    insertReport(r: Omit<CommunityReportRow, 'review_note' | 'reviewed_at'>): void {
      db.prepare(
        `INSERT INTO community_reports (id, user_id, category, description, cell, approx_lat, approx_lng, area_name, occurred_at, status, created_at, expires_at, is_demo)
         VALUES (@id, @user_id, @category, @description, @cell, @approx_lat, @approx_lng, @area_name, @occurred_at, @status, @created_at, @expires_at, @is_demo)`,
      ).run(r);
    },
    report: (id: string) => db.prepare('SELECT * FROM community_reports WHERE id = ?').get(id) as CommunityReportRow | undefined,
    countRecentByUser: (userId: string, since: string) =>
      (db.prepare('SELECT COUNT(*) AS n FROM community_reports WHERE user_id = ? AND created_at >= ?').get(userId, since) as { n: number }).n,
    duplicateExists: (userId: string, cell: string, category: string, since: string) =>
      db.prepare('SELECT 1 FROM community_reports WHERE user_id = ? AND cell = ? AND category = ? AND created_at >= ?').get(userId, cell, category, since) !== undefined,
    rejectedCount: (userId: string) =>
      (db.prepare("SELECT COUNT(*) AS n FROM community_reports WHERE user_id = ? AND status = 'rejected'").get(userId) as { n: number }).n,
    reportsInCells(cells: string[], now: string): CommunityReportRow[] {
      return db
        .prepare(
          `SELECT * FROM community_reports WHERE cell IN (SELECT value FROM json_each(?))
           AND status IN ('submitted', 'under_review', 'verified') AND expires_at > ? ORDER BY occurred_at DESC LIMIT 100`,
        )
        .all(JSON.stringify(cells), now) as CommunityReportRow[];
    },
    reportsByUser: (userId: string) =>
      db.prepare('SELECT * FROM community_reports WHERE user_id = ? ORDER BY created_at DESC LIMIT 50').all(userId) as CommunityReportRow[],
    reviewQueue: () =>
      db.prepare("SELECT * FROM community_reports WHERE status IN ('submitted', 'under_review') ORDER BY status DESC, created_at LIMIT 200").all() as CommunityReportRow[],
    setReportStatus(id: string, status: CommunityReportRow['status'], note: string | null, now: string, expiresAt?: string): void {
      db.prepare('UPDATE community_reports SET status = ?, review_note = ?, reviewed_at = ?, expires_at = COALESCE(?, expires_at) WHERE id = ?').run(status, note, now, expiresAt ?? null, id);
    },
    expireReports: (now: string) =>
      db.prepare("UPDATE community_reports SET status = 'expired' WHERE status IN ('submitted', 'under_review', 'verified') AND expires_at <= ?").run(now).changes,
    deleteReportsByUser: (userId: string) => db.prepare('DELETE FROM community_reports WHERE user_id = ?').run(userId).changes,
  };
}

export type PulseRepository = ReturnType<typeof createPulseRepository>;
