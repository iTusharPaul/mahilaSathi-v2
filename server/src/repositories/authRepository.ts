import type { Db } from '../db/connection.js';

export interface OtpSessionRow {
  id: string;
  phone_e164: string;
  code_hash: string;
  provider: string;
  attempts: number;
  max_attempts: number;
  created_at: string;
  expires_at: string;
  consumed_at: string | null;
  invalidated_at: string | null;
}

export interface UserSessionRow {
  id: string;
  user_id: string;
  token_hash: string;
  created_at: string;
  last_seen_at: string;
  expires_at: string;
  revoked_at: string | null;
}

export function createAuthRepository(db: Db) {
  return {
    insertOtpSession(row: Omit<OtpSessionRow, 'attempts' | 'consumed_at' | 'invalidated_at'>): void {
      db.prepare(
        `INSERT INTO otp_sessions (id, phone_e164, code_hash, provider, max_attempts, created_at, expires_at)
         VALUES (@id, @phone_e164, @code_hash, @provider, @max_attempts, @created_at, @expires_at)`,
      ).run(row);
    },

    findOtpSession: (id: string) =>
      db.prepare('SELECT * FROM otp_sessions WHERE id = ?').get(id) as OtpSessionRow | undefined,

    recentOtpSessions: (phone: string, sinceIso: string) =>
      db
        .prepare('SELECT * FROM otp_sessions WHERE phone_e164 = ? AND created_at >= ? ORDER BY created_at DESC')
        .all(phone, sinceIso) as OtpSessionRow[],

    invalidateActiveOtpSessions(phone: string, now: string): void {
      db.prepare(
        'UPDATE otp_sessions SET invalidated_at = ? WHERE phone_e164 = ? AND consumed_at IS NULL AND invalidated_at IS NULL',
      ).run(now, phone);
    },

    invalidateOtpSession(id: string, now: string): void {
      db.prepare('UPDATE otp_sessions SET invalidated_at = ? WHERE id = ?').run(now, id);
    },

    /** Atomically consumes one attempt. Returns false if none remain or the session is closed. */
    takeOtpAttempt(id: string): boolean {
      return (
        db
          .prepare(
            `UPDATE otp_sessions SET attempts = attempts + 1
             WHERE id = ? AND attempts < max_attempts AND consumed_at IS NULL AND invalidated_at IS NULL`,
          )
          .run(id).changes === 1
      );
    },

    /** Returns false if another request consumed it first. */
    consumeOtpSession(id: string, now: string): boolean {
      return db.prepare('UPDATE otp_sessions SET consumed_at = ? WHERE id = ? AND consumed_at IS NULL').run(now, id).changes === 1;
    },

    insertUserSession(row: Omit<UserSessionRow, 'revoked_at'> & { user_agent: string | null }): void {
      db.prepare(
        `INSERT INTO user_sessions (id, user_id, token_hash, user_agent, created_at, last_seen_at, expires_at)
         VALUES (@id, @user_id, @token_hash, @user_agent, @created_at, @last_seen_at, @expires_at)`,
      ).run(row);
    },

    findLiveSession: (tokenHash: string, now: string) =>
      db
        .prepare('SELECT * FROM user_sessions WHERE token_hash = ? AND revoked_at IS NULL AND expires_at > ?')
        .get(tokenHash, now) as UserSessionRow | undefined,

    touchSession(id: string, now: string): void {
      db.prepare('UPDATE user_sessions SET last_seen_at = ? WHERE id = ?').run(now, id);
    },

    revokeSession(id: string, now: string): void {
      db.prepare('UPDATE user_sessions SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL').run(now, id);
    },

    /** Retention: OTP rows after 24 h; sessions 7 days after they expire or are revoked. */
    purge(otpBeforeIso: string, sessionsBeforeIso: string): { otp: number; sessions: number } {
      const otp = db.prepare('DELETE FROM otp_sessions WHERE created_at < ?').run(otpBeforeIso).changes;
      const sessions = db
        .prepare('DELETE FROM user_sessions WHERE expires_at < ? OR (revoked_at IS NOT NULL AND revoked_at < ?)')
        .run(sessionsBeforeIso, sessionsBeforeIso).changes;
      return { otp, sessions };
    },
  };
}

export type AuthRepository = ReturnType<typeof createAuthRepository>;
