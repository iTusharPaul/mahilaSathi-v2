import type { BlockedUser, ModerationQueue, ModerationReport, REPORT_REASONS } from '@mahilasathi/shared';
import type { Logger } from 'pino';
import type { AuditRepository } from '../../repositories/auditRepository.js';
import type { CommunityRepository } from '../../repositories/communityRepository.js';
import type { SafetyRepository } from '../../repositories/safetyRepository.js';
import type { UserRow } from '../../repositories/userRepository.js';
import { AppError, notFound } from '../../utils/errors.js';
import type { Clock } from '../../utils/crypto.js';
import type { CircleService } from '../circles/circleService.js';
import type { CommunityService } from '../community/communityService.js';
import { POLICY, messageText } from './messagePolicy.js';

type Reason = (typeof REPORT_REASONS)[number];

export function createSafetyService(deps: {
  safety: SafetyRepository;
  community: CommunityRepository;
  communityService: CommunityService;
  circleService: CircleService;
  audit: AuditRepository;
  clock: Clock;
  logger: Logger;
}) {
  const { safety, community, communityService, circleService, audit, clock, logger } = deps;
  const nowIso = () => clock().toISOString();

  function resolvePublicId(publicId: string): string {
    const userId = community.userIdForChatUserId(publicId);
    if (!userId) throw notFound('User');
    return userId;
  }

  /**
   * Three different people reporting someone within 24 hours pauses their community posting until a
   * moderator reviews. A single reporter can never trigger this alone.
   */
  function maybeAutoSuspend(reportedUserId: string, reportId: string): void {
    const since = new Date(clock().getTime() - POLICY.autoSuspendWindowMs).toISOString();
    if (safety.distinctReportersSince(reportedUserId, since) < POLICY.autoSuspendReporters) return;
    const current = safety.suspendedUntil(reportedUserId);
    if (current && Date.parse(current) > clock().getTime()) return;
    const until = new Date(clock().getTime() + POLICY.autoSuspendMs).toISOString();
    safety.setSuspension(reportedUserId, until);
    safety.recordAction({ actorType: 'system', action: 'auto_suspend', targetUserId: reportedUserId, channelId: null, reportId, reason: `${POLICY.autoSuspendReporters}+ distinct reporters in 24h`, expiresAt: until, now: nowIso() });
    audit.record({ actorType: 'system', action: 'moderation.auto_suspend', targetType: 'user', targetId: reportedUserId, metadata: { until } });
    logger.warn({ reportId }, 'user auto-suspended pending review');
  }

  return {
    async block(user: UserRow, targetPublicId: string): Promise<void> {
      const targetId = resolvePublicId(targetPublicId);
      if (targetId === user.id) throw new AppError('BAD_REQUEST', 'You can’t block yourself.');
      if (safety.block(user.id, targetId, nowIso())) {
        audit.record({ actorType: 'user', actorId: user.id, action: 'safety.blocked', targetType: 'user', targetId });
        await circleService.separateAfterBlock(user.id, targetId);
      }
    },

    unblock(user: UserRow, targetPublicId: string): void {
      const targetId = resolvePublicId(targetPublicId);
      if (safety.unblock(user.id, targetId)) audit.record({ actorType: 'user', actorId: user.id, action: 'safety.unblocked', targetType: 'user', targetId });
    },

    blocks(user: UserRow): BlockedUser[] {
      return safety.blockedByMe(user.id).map((b) => ({ publicId: b.chat_user_id ?? '', handle: b.community_handle, blockedAt: b.created_at }));
    },

    /**
     * Dev relay: the server holds the message, so the snapshot is authoritative. Nexconn: the server can't read
     * message history, so the reporter's copy is stored and labelled `reporter` (unverified).
     */
    reportMessage(
      user: UserRow,
      providerMessageId: string,
      input: { channelId: string; reason: Reason; details?: string | undefined; snapshot?: { text: string; senderPublicId: string; sentAt: number } | undefined },
    ): { id: string; duplicate: boolean } {
      const channel = community.channel(input.channelId);
      if (!channel || !community.membership(channel.id, user.id)) throw notFound('Channel');

      let reportedUserId: string | null = null;
      let snapshotText: string | null = null;
      let snapshotSource: 'server' | 'reporter' = 'reporter';
      if (channel.provider === 'dev-relay') {
        const msg = community.relayMessage(providerMessageId);
        if (!msg || msg.channel_id !== channel.id) throw notFound('Message');
        reportedUserId = msg.sender_user_id;
        snapshotText = messageText(msg.message_type, JSON.parse(msg.content_json)).slice(0, 2000);
        snapshotSource = 'server';
      } else if (input.snapshot) {
        reportedUserId = community.userIdForChatUserId(input.snapshot.senderPublicId);
        snapshotText = input.snapshot.text.slice(0, 2000);
      }
      if (reportedUserId === user.id) throw new AppError('BAD_REQUEST', 'You can’t report your own message.');

      const result = safety.insertMessageReport({
        channel_id: channel.id,
        provider_message_id: providerMessageId,
        reporter_id: user.id,
        reported_user_id: reportedUserId,
        reason: input.reason,
        details: input.details ?? null,
        snapshot_text: snapshotText,
        snapshot_source: snapshotSource,
        created_at: nowIso(),
      });
      if (!result.duplicate) {
        audit.record({ actorType: 'user', actorId: user.id, action: 'safety.message_reported', targetType: 'message_report', targetId: result.id, metadata: { reason: input.reason, channelId: channel.id } });
        if (reportedUserId) maybeAutoSuspend(reportedUserId, result.id);
      }
      return result;
    },

    reportUser(user: UserRow, input: { reportedPublicId: string; reason: Reason; details?: string | undefined; channelId?: string | undefined }): { id: string } {
      const reportedId = resolvePublicId(input.reportedPublicId);
      if (reportedId === user.id) throw new AppError('BAD_REQUEST', 'You can’t report yourself.');
      if (input.channelId && !community.membership(input.channelId, user.id)) throw notFound('Channel');
      const id = safety.insertUserReport({
        reporter_id: user.id,
        reported_user_id: reportedId,
        reason: input.reason,
        details: input.details ?? null,
        context_channel_id: input.channelId ?? null,
        created_at: nowIso(),
      });
      audit.record({ actorType: 'user', actorId: user.id, action: 'safety.user_reported', targetType: 'user_report', targetId: id, metadata: { reason: input.reason } });
      maybeAutoSuspend(reportedId, id);
      return { id };
    },

    // ─── Moderator review (admin token) ───────────────────────────────────────

    /** Open reports for moderators, with pseudonyms and context (never phone numbers or internal ids). */
    queue(): ModerationQueue {
      const { messages, users } = safety.openReports(100);
      const person = (id: string | null): ModerationReport['reported'] => {
        if (!id) return null;
        const u = safety.userSummary(id);
        const until = u?.community_suspended_until ?? null;
        return {
          handle: u?.community_handle ?? 'Deleted account',
          isDemo: u?.is_demo === 1,
          suspendedUntil: until && Date.parse(until) > clock().getTime() ? until : null,
          openReports: safety.openReportsAgainst(id),
        };
      };
      const channel = (id: string | null) => {
        const c = id ? community.channel(id) : undefined;
        return c ? { name: c.name, kind: c.kind } : null;
      };
      const reporter = (id: string) => safety.userSummary(id)?.community_handle ?? 'Deleted account';
      return {
        messages: messages.map((r) => ({
          id: r.id,
          type: 'message' as const,
          reason: r.reason,
          details: r.details,
          createdAt: r.created_at,
          snapshotText: r.snapshot_text,
          snapshotSource: r.snapshot_source,
          reported: person(r.reported_user_id),
          reporterHandle: reporter(r.reporter_id),
          channel: channel(r.channel_id),
        })),
        users: users.map((r) => ({
          id: r.id,
          type: 'user' as const,
          reason: r.reason,
          details: r.details,
          createdAt: r.created_at,
          snapshotText: null,
          snapshotSource: null,
          reported: person(r.reported_user_id),
          reporterHandle: reporter(r.reporter_id),
          channel: channel(r.context_channel_id),
        })),
      };
    },

    async resolve(reportId: string, input: { action: 'dismiss' | 'warn' | 'remove_from_channel' | 'suspend'; reason: string; suspendHours?: number | undefined }) {
      const report = safety.findReport(reportId);
      if (!report) throw notFound('Report');
      if (report.status !== 'open') throw new AppError('CONFLICT', 'This report has already been resolved.');
      const targetUserId = report.reported_user_id;
      const channelId = report.type === 'message' ? report.channel_id : report.context_channel_id;
      const now = nowIso();

      if (input.action !== 'dismiss' && !targetUserId) throw new AppError('BAD_REQUEST', 'This report has no identifiable user to act on.');
      let expiresAt: string | null = null;
      if (input.action === 'remove_from_channel') {
        if (!channelId) throw new AppError('BAD_REQUEST', 'This report is not linked to a channel.');
        await communityService.removeFromChannel(channelId, targetUserId!, 'moderator');
      } else if (input.action === 'suspend') {
        expiresAt = new Date(clock().getTime() + (input.suspendHours ?? 72) * 60 * 60_000).toISOString();
        safety.setSuspension(targetUserId!, expiresAt);
      }
      const actionName = input.action === 'dismiss' ? 'dismiss_report' : input.action;
      safety.recordAction({ actorType: 'admin', action: actionName, targetUserId, channelId: channelId ?? null, reportId, reason: input.reason, expiresAt, now });
      safety.resolveReport(reportId, report.type, input.action === 'dismiss' ? 'dismissed' : 'actioned', `${input.action}: ${input.reason}`, now);
      // A dismissed report lifts an automatic suspension it contributed to.
      if (input.action === 'dismiss' && targetUserId) {
        const until = safety.suspendedUntil(targetUserId);
        if (until && Date.parse(until) > clock().getTime()) {
          const since = new Date(clock().getTime() - POLICY.autoSuspendWindowMs).toISOString();
          if (safety.distinctReportersSince(targetUserId, since) <= POLICY.autoSuspendReporters) safety.setSuspension(targetUserId, null);
        }
      }
      audit.record({ actorType: 'admin', action: `moderation.${actionName}`, targetType: 'report', targetId: reportId, metadata: { targetUserId, channelId } });
      return { status: input.action === 'dismiss' ? 'dismissed' : 'actioned' };
    },
  };
}

export type SafetyService = ReturnType<typeof createSafetyService>;
