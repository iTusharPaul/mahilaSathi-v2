import { describe, expect, it } from 'vitest';
import { SOS_STATUSES, SOS_TRANSITIONS, activateSosSchema, canTransitionSos, sosSettingsSchema } from '@mahilasathi/shared';
import { SOS_POLICY } from '../../server/src/services/sos/sosService.js';

describe('SOS state machine', () => {
  it('only allows an active SOS to end, once', () => {
    expect(canTransitionSos('ACTIVE', 'RESOLVED')).toBe(true);
    expect(canTransitionSos('ACTIVE', 'CANCELLED')).toBe(true);
    for (const to of SOS_STATUSES) {
      expect(canTransitionSos('RESOLVED', to)).toBe(false);
      expect(canTransitionSos('CANCELLED', to)).toBe(false);
    }
    for (const s of SOS_STATUSES) expect(SOS_TRANSITIONS[s]).not.toContain(s);
  });
});

describe('SOS retry policy', () => {
  it('backs off exponentially and gives up after a bounded number of tries', () => {
    expect(SOS_POLICY.maxAttempts).toBe(5);
    expect(SOS_POLICY.backoffMs).toHaveLength(SOS_POLICY.maxAttempts - 1);
    for (let i = 1; i < SOS_POLICY.backoffMs.length; i++) expect(SOS_POLICY.backoffMs[i]!).toBeGreaterThan(SOS_POLICY.backoffMs[i - 1]!);
    // The whole retry window stays short: an SOS that cannot be delivered is reported as failed within minutes.
    expect(SOS_POLICY.backoffMs.reduce((a, b) => a + b, 0)).toBeLessThan(10 * 60_000);
    // A crashed send is retried well within that window.
    expect(SOS_POLICY.leaseMs).toBeLessThanOrEqual(60_000);
  });
});

describe('SOS request validation', () => {
  it('requires an idempotency key and bounds settings', () => {
    expect(activateSosSchema.safeParse({}).success).toBe(false);
    expect(activateSosSchema.safeParse({ idempotencyKey: 'not-a-uuid' }).success).toBe(false);
    expect(activateSosSchema.safeParse({ idempotencyKey: '7f1d2c1e-8a3b-4b8e-9b55-0d2a1f3c4e5d', extra: 1 }).success).toBe(false);
    expect(sosSettingsSchema.safeParse({ locationDetail: 'precise', emergencyContacts: 'if_unacknowledged', escalateAfterMinutes: 0, shortcut: 'hold' }).success).toBe(false);
    expect(sosSettingsSchema.safeParse({ locationDetail: 'exact', emergencyContacts: 'never', escalateAfterMinutes: 3, shortcut: 'hold' }).success).toBe(false);
  });
});
