import crypto from 'node:crypto';
import type { EmergencyContact } from '@mahilasathi/shared';
import type { Db } from '../db/connection.js';

interface ContactRow {
  id: string;
  user_id: string;
  name: string;
  phone_e164: string;
  relationship: string | null;
  priority: number;
}

const toContact = (r: ContactRow): EmergencyContact => ({
  id: r.id,
  name: r.name,
  phone: r.phone_e164,
  relationship: r.relationship,
  priority: r.priority,
});

/** Every query is scoped by owner, so one user can never read or change another's contacts. */
export function createEmergencyContactRepository(db: Db) {
  return {
    list: (userId: string) =>
      (
        db
          .prepare('SELECT * FROM emergency_contacts WHERE user_id = ? ORDER BY priority, created_at')
          .all(userId) as ContactRow[]
      ).map(toContact),

    count: (userId: string) =>
      (db.prepare('SELECT COUNT(*) AS n FROM emergency_contacts WHERE user_id = ?').get(userId) as { n: number }).n,

    findOwned: (userId: string, id: string) => {
      const row = db.prepare('SELECT * FROM emergency_contacts WHERE id = ? AND user_id = ?').get(id, userId) as
        | ContactRow
        | undefined;
      return row ? toContact(row) : null;
    },

    phoneTaken: (userId: string, phone: string, exceptId?: string) =>
      db
        .prepare('SELECT 1 FROM emergency_contacts WHERE user_id = ? AND phone_e164 = ? AND id != ?')
        .get(userId, phone, exceptId ?? '') !== undefined,

    create(userId: string, c: { name: string; phone: string; relationship: string | null }, now: string): EmergencyContact {
      const id = crypto.randomUUID();
      const priority = (
        db.prepare('SELECT COALESCE(MAX(priority) + 1, 0) AS p FROM emergency_contacts WHERE user_id = ?').get(userId) as {
          p: number;
        }
      ).p;
      db.prepare(
        `INSERT INTO emergency_contacts (id, user_id, name, phone_e164, relationship, priority, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(id, userId, c.name, c.phone, c.relationship, priority, now, now);
      return this.findOwned(userId, id)!;
    },

    update(
      userId: string,
      id: string,
      patch: Partial<{ name: string; phone: string; relationship: string | null; priority: number }>,
      now: string,
    ): EmergencyContact | null {
      const current = db.prepare('SELECT * FROM emergency_contacts WHERE id = ? AND user_id = ?').get(id, userId) as
        | ContactRow
        | undefined;
      if (!current) return null;
      db.prepare(
        `UPDATE emergency_contacts SET name = ?, phone_e164 = ?, relationship = ?, priority = ?, updated_at = ?
         WHERE id = ? AND user_id = ?`,
      ).run(
        patch.name ?? current.name,
        patch.phone ?? current.phone_e164,
        patch.relationship !== undefined ? patch.relationship : current.relationship,
        patch.priority ?? current.priority,
        now,
        id,
        userId,
      );
      return this.findOwned(userId, id);
    },

    delete: (userId: string, id: string) =>
      db.prepare('DELETE FROM emergency_contacts WHERE id = ? AND user_id = ?').run(id, userId).changes === 1,
  };
}

export type EmergencyContactRepository = ReturnType<typeof createEmergencyContactRepository>;
