import crypto from 'node:crypto';
import type { SosDeliveryStatus, SosSettings, SosStatus } from '@mahilasathi/shared';
import type { Db } from '../db/connection.js';

export interface SosEventRow {
  id: string;
  user_id: string;
  idempotency_key: string;
  trip_id: string | null;
  status: SosStatus;
  outcome: 'safe' | 'false_alarm' | null;
  note: string | null;
  location_detail: SosSettings['locationDetail'];
  contacts_policy: SosSettings['emergencyContacts'];
  escalate_after_minutes: number;
  location_sharing: number;
  lat: number | null;
  lng: number | null;
  accuracy_m: number | null;
  location_recorded_at: string | null;
  location_source: 'device' | 'journey' | null;
  area_name: string | null;
  escalation_stage: number;
  next_escalation_at: string | null;
  activated_at: string;
  ended_at: string | null;
  updated_at: string;
  is_demo: number;
}

export interface SosRecipientRow {
  id: string;
  sos_id: string;
  kind: 'guardian' | 'emergency_contact';
  user_id: string | null;
  contact_id: string | null;
  name: string;
  phone_e164: string | null;
  location_level: SosSettings['locationDetail'];
  created_at: string;
}

export type Channel = 'in_app' | 'circle_chat' | 'sms';
export type Purpose = 'alert' | 'escalation' | 'update' | 'ended';

export interface DeliveryRow {
  id: string;
  sos_id: string;
  recipient_id: string | null;
  channel: Channel;
  purpose: Purpose;
  status: SosDeliveryStatus;
  attempts: number;
  max_attempts: number;
  next_attempt_at: string | null;
  lease_expires_at: string | null;
  last_error: string | null;
  provider_message_id: string | null;
  dev_adapter: number;
  accepted_at: string | null;
  delivered_at: string | null;
  created_at: string;
  updated_at: string;
}

const DEFAULT_SETTINGS: SosSettings = { locationDetail: 'precise', emergencyContacts: 'if_unacknowledged', escalateAfterMinutes: 3, shortcut: 'hold' };

export function createSosRepository(db: Db) {
  const event = (id: string) => db.prepare('SELECT * FROM sos_events WHERE id = ?').get(id) as SosEventRow | undefined;

  return {
    // ─── Settings ─────────────────────────────────────────────────────────────
    settings(userId: string): SosSettings {
      const r = db.prepare('SELECT * FROM sos_settings WHERE user_id = ?').get(userId) as
        | { location_detail: SosSettings['locationDetail']; emergency_contacts: SosSettings['emergencyContacts']; escalate_after_minutes: number; shortcut: SosSettings['shortcut'] }
        | undefined;
      return r ? { locationDetail: r.location_detail, emergencyContacts: r.emergency_contacts, escalateAfterMinutes: r.escalate_after_minutes, shortcut: r.shortcut } : { ...DEFAULT_SETTINGS };
    },
    saveSettings(userId: string, s: SosSettings, now: string): void {
      db.prepare(
        `INSERT INTO sos_settings (user_id, location_detail, emergency_contacts, escalate_after_minutes, shortcut, updated_at) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (user_id) DO UPDATE SET location_detail = excluded.location_detail, emergency_contacts = excluded.emergency_contacts,
           escalate_after_minutes = excluded.escalate_after_minutes, shortcut = excluded.shortcut, updated_at = excluded.updated_at`,
      ).run(userId, s.locationDetail, s.emergencyContacts, s.escalateAfterMinutes, s.shortcut, now);
    },

    // ─── Events ───────────────────────────────────────────────────────────────
    event,
    byIdempotencyKey: (userId: string, key: string) =>
      db.prepare('SELECT * FROM sos_events WHERE user_id = ? AND idempotency_key = ?').get(userId, key) as SosEventRow | undefined,
    activeFor: (userId: string) => db.prepare("SELECT * FROM sos_events WHERE user_id = ? AND status = 'ACTIVE'").get(userId) as SosEventRow | undefined,
    latestFor: (userId: string) => db.prepare('SELECT * FROM sos_events WHERE user_id = ? ORDER BY activated_at DESC LIMIT 1').get(userId) as SosEventRow | undefined,
    historyFor: (userId: string, limit = 20) =>
      db.prepare('SELECT * FROM sos_events WHERE user_id = ? ORDER BY activated_at DESC LIMIT ?').all(userId, limit) as SosEventRow[],

    /** Creates the event, its recipients and initial deliveries atomically. */
    createEvent(e: SosEventRow, recipients: SosRecipientRow[], deliveries: Omit<DeliveryRow, 'id' | 'attempts' | 'lease_expires_at' | 'last_error' | 'provider_message_id' | 'delivered_at' | 'updated_at'>[]): void {
      db.transaction(() => {
        db.prepare(
          `INSERT INTO sos_events (id, user_id, idempotency_key, trip_id, status, outcome, note, location_detail, contacts_policy, escalate_after_minutes,
             location_sharing, lat, lng, accuracy_m, location_recorded_at, location_source, area_name, escalation_stage, next_escalation_at, activated_at, ended_at, updated_at, is_demo)
           VALUES (@id, @user_id, @idempotency_key, @trip_id, @status, @outcome, @note, @location_detail, @contacts_policy, @escalate_after_minutes,
             @location_sharing, @lat, @lng, @accuracy_m, @location_recorded_at, @location_source, @area_name, @escalation_stage, @next_escalation_at, @activated_at, @ended_at, @updated_at, @is_demo)`,
        ).run(e);
        const rs = db.prepare(
          `INSERT INTO sos_recipients (id, sos_id, kind, user_id, contact_id, name, phone_e164, location_level, created_at)
           VALUES (@id, @sos_id, @kind, @user_id, @contact_id, @name, @phone_e164, @location_level, @created_at)`,
        );
        for (const r of recipients) rs.run(r);
        for (const d of deliveries) insertDelivery(d);
      })();
    },
    update(id: string, fields: Partial<SosEventRow>, now: string): void {
      const keys = Object.keys(fields);
      if (keys.length === 0) return;
      db.prepare(`UPDATE sos_events SET ${keys.map((k) => `${k} = @${k}`).join(', ')}, updated_at = @__now WHERE id = @__id`).run({ ...fields, __now: now, __id: id });
    },
    /** Guarded end: only an ACTIVE event can end, once. */
    end(id: string, status: 'RESOLVED' | 'CANCELLED', outcome: 'safe' | 'false_alarm', now: string): boolean {
      return (
        db
          .prepare("UPDATE sos_events SET status = ?, outcome = ?, ended_at = ?, next_escalation_at = NULL, updated_at = ? WHERE id = ? AND status = 'ACTIVE'")
          .run(status, outcome, now, now, id).changes === 1
      );
    },
    dueEscalations: (now: string) =>
      db.prepare("SELECT * FROM sos_events WHERE status = 'ACTIVE' AND escalation_stage = 0 AND next_escalation_at IS NOT NULL AND next_escalation_at <= ?").all(now) as SosEventRow[],
    /** Guarded so two workers can't escalate the same event twice. */
    markEscalated: (id: string, now: string) =>
      db.prepare("UPDATE sos_events SET escalation_stage = 1, next_escalation_at = NULL, updated_at = ? WHERE id = ? AND escalation_stage = 0 AND status = 'ACTIVE'").run(now, id).changes === 1,

    // ─── Recipients & acknowledgements ───────────────────────────────────────
    recipients: (sosId: string) => db.prepare('SELECT * FROM sos_recipients WHERE sos_id = ? ORDER BY kind DESC, created_at, rowid').all(sosId) as SosRecipientRow[],
    recipient: (id: string) => db.prepare('SELECT * FROM sos_recipients WHERE id = ?').get(id) as SosRecipientRow | undefined,
    recipientForUser: (sosId: string, userId: string) =>
      db.prepare("SELECT * FROM sos_recipients WHERE sos_id = ? AND user_id = ? AND kind = 'guardian'").get(sosId, userId) as SosRecipientRow | undefined,
    /** Events where this user is a guardian recipient: active ones, plus those ended after `endedSince`. */
    receivedBy: (userId: string, endedSince: string) =>
      db
        .prepare(
          `SELECT e.* FROM sos_events e JOIN sos_recipients r ON r.sos_id = e.id AND r.user_id = ? AND r.kind = 'guardian'
           WHERE e.status = 'ACTIVE' OR e.ended_at >= ? ORDER BY e.activated_at DESC LIMIT 20`,
        )
        .all(userId, endedSince) as SosEventRow[],
    acknowledge(sosId: string, recipientId: string, response: string, now: string): void {
      db.prepare(
        `INSERT INTO sos_acknowledgements (sos_id, recipient_id, response, acknowledged_at) VALUES (?, ?, ?, ?)
         ON CONFLICT (sos_id, recipient_id) DO UPDATE SET response = excluded.response, acknowledged_at = excluded.acknowledged_at`,
      ).run(sosId, recipientId, response, now);
    },
    acknowledgements: (sosId: string) =>
      db.prepare('SELECT recipient_id, response, acknowledged_at FROM sos_acknowledgements WHERE sos_id = ? ORDER BY acknowledged_at, rowid').all(sosId) as {
        recipient_id: string;
        response: 'seen' | 'calling' | 'on_my_way';
        acknowledged_at: string;
      }[],
    ackCount: (sosId: string) => (db.prepare('SELECT COUNT(*) AS n FROM sos_acknowledgements WHERE sos_id = ?').get(sosId) as { n: number }).n,

    // ─── Deliveries (durable jobs) ───────────────────────────────────────────
    insertDelivery,
    deliveries: (sosId: string) => db.prepare('SELECT * FROM sos_deliveries WHERE sos_id = ? ORDER BY created_at, rowid').all(sosId) as DeliveryRow[],
    delivery: (id: string) => db.prepare('SELECT * FROM sos_deliveries WHERE id = ?').get(id) as DeliveryRow | undefined,
    /** Jobs ready to run: pending and due, or stuck in 'sending' past their lease (the worker died mid-send). */
    dueDeliveries: (now: string, limit = 50) =>
      db
        .prepare(
          `SELECT * FROM sos_deliveries WHERE (status = 'pending' AND (next_attempt_at IS NULL OR next_attempt_at <= ?))
             OR (status = 'sending' AND lease_expires_at <= ?) ORDER BY created_at LIMIT ?`,
        )
        .all(now, now, limit) as DeliveryRow[],
    /** Claims a job for one try. Only one worker can win, because the update is guarded by the observed state. */
    claim(d: DeliveryRow, now: string, leaseUntil: string): boolean {
      return (
        db
          .prepare(
            `UPDATE sos_deliveries SET status = 'sending', attempts = attempts + 1, lease_expires_at = ?, updated_at = ?
             WHERE id = ? AND status = ? AND attempts = ?`,
          )
          .run(leaseUntil, now, d.id, d.status, d.attempts).changes === 1
      );
    },
    finishDelivery(id: string, fields: Partial<DeliveryRow>, now: string): void {
      const keys = Object.keys(fields);
      db.prepare(`UPDATE sos_deliveries SET ${keys.map((k) => `${k} = @${k}`).join(', ')}, lease_expires_at = NULL, updated_at = @__now WHERE id = @__id`).run({
        ...fields,
        __now: now,
        __id: id,
      });
    },
    markInAppDelivered: (sosId: string, recipientId: string, now: string) =>
      db
        .prepare("UPDATE sos_deliveries SET status = 'delivered', delivered_at = ?, updated_at = ? WHERE sos_id = ? AND recipient_id = ? AND channel = 'in_app' AND status = 'accepted'")
        .run(now, now, sosId, recipientId).changes,
    /** When an SOS ends, alerts and escalations not yet handed to a channel are no longer needed. */
    skipPending: (sosId: string, now: string) =>
      db
        .prepare("UPDATE sos_deliveries SET status = 'skipped', next_attempt_at = NULL, last_error = 'The SOS ended before this was sent', updated_at = ? WHERE sos_id = ? AND status = 'pending' AND purpose IN ('alert', 'escalation', 'update')")
        .run(now, sosId).changes,
    startAttempt(deliveryId: string, attemptNo: number, now: string): string {
      const id = crypto.randomUUID();
      db.prepare('INSERT INTO sos_delivery_attempts (id, delivery_id, attempt_no, started_at) VALUES (?, ?, ?, ?)').run(id, deliveryId, attemptNo, now);
      return id;
    },
    finishAttempt(id: string, outcome: string, error: string | null, now: string): void {
      db.prepare('UPDATE sos_delivery_attempts SET outcome = ?, error = ?, finished_at = ? WHERE id = ?').run(outcome, error, now, id);
    },
    attemptLog: (deliveryId: string) =>
      db.prepare('SELECT attempt_no, outcome, error, started_at, finished_at FROM sos_delivery_attempts WHERE delivery_id = ? ORDER BY attempt_no').all(deliveryId) as {
        attempt_no: number;
        outcome: string | null;
        error: string | null;
        started_at: string;
        finished_at: string | null;
      }[],

    /** Development SMS adapter only: what would have been sent, newest first. */
    devOutbox: (limit = 50) =>
      db.prepare('SELECT id, to_e164, body, created_at FROM dev_sms_outbox ORDER BY created_at DESC LIMIT ?').all(limit) as { id: string; to_e164: string; body: string; created_at: string }[],

    // ─── Retention ────────────────────────────────────────────────────────────
    purge(coordinatesBefore: string, outboxBefore: string): { sosCoordinates: number; devSms: number } {
      const sosCoordinates = db
        .prepare('UPDATE sos_events SET lat = NULL, lng = NULL, accuracy_m = NULL WHERE ended_at IS NOT NULL AND ended_at < ? AND lat IS NOT NULL')
        .run(coordinatesBefore).changes;
      const devSms = db.prepare('DELETE FROM dev_sms_outbox WHERE created_at < ?').run(outboxBefore).changes;
      return { sosCoordinates, devSms };
    },
  };

  function insertDelivery(d: Omit<DeliveryRow, 'id' | 'attempts' | 'lease_expires_at' | 'last_error' | 'provider_message_id' | 'delivered_at' | 'updated_at'>): string {
    const id = crypto.randomUUID();
    db.prepare(
      `INSERT OR IGNORE INTO sos_deliveries (id, sos_id, recipient_id, channel, purpose, status, max_attempts, next_attempt_at, dev_adapter, accepted_at, created_at, updated_at)
       VALUES (@id, @sos_id, @recipient_id, @channel, @purpose, @status, @max_attempts, @next_attempt_at, @dev_adapter, @accepted_at, @created_at, @created_at)`,
    ).run({ id, ...d });
    return id;
  }
}

export type SosRepository = ReturnType<typeof createSosRepository>;
