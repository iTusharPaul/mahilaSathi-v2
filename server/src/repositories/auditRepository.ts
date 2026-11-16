import crypto from 'node:crypto';
import type { Db } from '../db/connection.js';

export type AuditActorType = 'user' | 'system' | 'admin' | 'moderator';

export interface AuditEventInput {
  actorType: AuditActorType;
  actorId?: string | null;
  action: string;
  targetType?: string | null;
  targetId?: string | null;
  requestId?: string | null;
  /** Identifiers and coarse context only: never coordinates, phone numbers or message text. */
  metadata?: Record<string, unknown>;
}

export interface AuditEventRow {
  id: string;
  occurred_at: string;
  actor_type: AuditActorType;
  actor_id: string | null;
  action: string;
  target_type: string | null;
  target_id: string | null;
  request_id: string | null;
  metadata_json: string;
}

export function createAuditRepository(db: Db) {
  const insert = db.prepare(`
    INSERT INTO audit_events (id, actor_type, actor_id, action, target_type, target_id, request_id, metadata_json)
    VALUES (@id, @actorType, @actorId, @action, @targetType, @targetId, @requestId, @metadataJson)
  `);
  const byTarget = db.prepare(
    'SELECT * FROM audit_events WHERE target_type = ? AND target_id = ? ORDER BY occurred_at, rowid',
  );

  return {
    record(event: AuditEventInput): string {
      const id = crypto.randomUUID();
      insert.run({
        id,
        actorType: event.actorType,
        actorId: event.actorId ?? null,
        action: event.action,
        targetType: event.targetType ?? null,
        targetId: event.targetId ?? null,
        requestId: event.requestId ?? null,
        metadataJson: JSON.stringify(event.metadata ?? {}),
      });
      return id;
    },

    listForTarget(targetType: string, targetId: string): AuditEventRow[] {
      return byTarget.all(targetType, targetId) as AuditEventRow[];
    },

    /** Newest first. `actionPrefix` matches e.g. "sos." for every SOS action. Parameterised throughout. */
    search(f: { actionPrefix?: string | undefined; actorId?: string | undefined; targetType?: string | undefined; targetId?: string | undefined; before?: string | undefined; limit: number }): AuditEventRow[] {
      const where: string[] = [];
      const args: unknown[] = [];
      if (f.actionPrefix) {
        // Escape LIKE wildcards so the prefix is matched literally.
        where.push("action LIKE ? ESCAPE '\\'");
        args.push(`${f.actionPrefix.replace(/[\\%_]/g, (c) => `\\${c}`)}%`);
      }
      if (f.actorId) {
        where.push('actor_id = ?');
        args.push(f.actorId);
      }
      if (f.targetType) {
        where.push('target_type = ?');
        args.push(f.targetType);
      }
      if (f.targetId) {
        where.push('target_id = ?');
        args.push(f.targetId);
      }
      if (f.before) {
        where.push('occurred_at < ?');
        args.push(f.before);
      }
      const sql = `SELECT * FROM audit_events ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY occurred_at DESC, rowid DESC LIMIT ?`;
      return db.prepare(sql).all(...args, f.limit) as AuditEventRow[];
    },
  };
}

export type AuditRepository = ReturnType<typeof createAuditRepository>;
