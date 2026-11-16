import crypto from 'node:crypto';
import type { Circle } from '@mahilasathi/shared';
import type { AuditRepository } from '../../repositories/auditRepository.js';
import type { CircleRepository, CircleRow } from '../../repositories/circleRepository.js';
import type { CommunityRepository } from '../../repositories/communityRepository.js';
import type { SafetyRepository } from '../../repositories/safetyRepository.js';
import type { UserRow } from '../../repositories/userRepository.js';
import { AppError, forbidden, notFound } from '../../utils/errors.js';
import { hmacHex, type Clock } from '../../utils/crypto.js';
import type { CommunityService } from '../community/communityService.js';

export const CIRCLE_LIMITS = { maxMembers: 10, maxPendingInvites: 5, inviteTtlMs: 7 * 24 * 60 * 60_000 } as const;

// No 0/O, 1/I/L: codes are read aloud and typed by hand.
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const INVALID_INVITE = 'This invite code isn’t valid or has expired.';

function generateCode(): string {
  let raw = '';
  for (let i = 0; i < 8; i++) raw += ALPHABET[crypto.randomInt(0, ALPHABET.length)];
  return `${raw.slice(0, 4)}-${raw.slice(4)}`;
}
const normaliseCode = (code: string) => code.toUpperCase().replace(/[^A-Z0-9]/g, '');

export function createCircleService(deps: {
  circles: CircleRepository;
  community: CommunityRepository;
  communityService: CommunityService;
  safety: SafetyRepository;
  audit: AuditRepository;
  secret: string;
  clock: Clock;
}) {
  const { circles, community, communityService, safety, audit, secret, clock } = deps;
  const nowIso = () => clock().toISOString();
  const codeHash = (code: string) => hmacHex(secret, `circle-invite:${normaliseCode(code)}`);
  const phoneHash = (phone: string) => hmacHex(secret, `circle-invite-phone:${phone}`);

  function serialize(circle: CircleRow, viewerId: string): Circle {
    const members = circles.activeMembers(circle.id);
    const owner = members.find((m) => m.role === 'owner');
    const isOwner = circle.owner_id === viewerId;
    return {
      id: circle.id,
      name: circle.name,
      isOwner,
      channelId: circle.channel_id,
      owner: { publicId: owner?.chat_user_id ?? '', handle: owner?.community_handle ?? '', displayName: owner?.display_name ?? null },
      members: members.map((m) => ({
        publicId: m.chat_user_id ?? '',
        handle: m.community_handle,
        displayName: m.display_name,
        role: m.role,
        joinedAt: m.joined_at,
      })),
      pendingInvites: isOwner
        ? circles.pendingInvites(circle.id, nowIso()).map((i) => ({ id: i.id, expiresAt: i.expires_at, boundToPhone: i.bound_phone_hash !== null }))
        : [],
    };
  }

  /** Members only. Non-members get 404 so a circle's existence isn't revealed. */
  function requireCircle(circleId: string, userId: string): CircleRow {
    const circle = circles.byId(circleId);
    if (!circle || !circles.isActiveMember(circle.id, userId)) throw notFound('Circle');
    return circle;
  }

  async function removeGuardian(circle: CircleRow, userId: string, status: 'removed' | 'left', actorId: string): Promise<void> {
    if (!circles.endMember(circle.id, userId, status, nowIso())) throw notFound('Member');
    await communityService.removeFromChannel(circle.channel_id, userId, actorId);
    audit.record({ actorType: 'user', actorId, action: status === 'left' ? 'circle.left' : 'circle.member_removed', targetType: 'circle', targetId: circle.id, metadata: { userId } });
  }

  return {
    list(user: UserRow): Circle[] {
      return circles.forMember(user.id).map((c) => serialize(c, user.id));
    },

    async create(user: UserRow, name: string): Promise<Circle> {
      if (circles.byOwner(user.id)) throw new AppError('CONFLICT', 'You already have a Guardian Circle.');
      const channel = await communityService.createChannel(
        {
          kind: 'guardian_circle',
          name: name.slice(0, 64),
          neighbourhood_id: null,
          from_area_type: null,
          from_area_id: null,
          to_area_type: null,
          to_area_id: null,
          window_start: null,
          window_end: null,
          expires_at: null,
          max_members: CIRCLE_LIMITS.maxMembers,
          created_by: user.id,
        },
        { chatUserId: communityService.chatUserId(user.id) },
      );
      community.upsertMembership(channel.id, user.id, 'owner', nowIso());
      const circle: CircleRow = { id: crypto.randomUUID(), owner_id: user.id, name, channel_id: channel.id, created_at: nowIso() };
      circles.insertCircle(circle);
      audit.record({ actorType: 'user', actorId: user.id, action: 'circle.created', targetType: 'circle', targetId: circle.id });
      return serialize(circle, user.id);
    },

    /** Returns the code once; only its hash is stored. Optionally bound to the invitee's phone number. */
    createInvite(user: UserRow, circleId: string, phone?: string) {
      const circle = requireCircle(circleId, user.id);
      if (circle.owner_id !== user.id) throw forbidden('Only the circle owner can invite guardians');
      if (phone && phone === user.phone_e164) throw new AppError('VALIDATION_FAILED', 'You can’t invite yourself');
      if (circles.activeMemberCount(circle.id) >= CIRCLE_LIMITS.maxMembers) throw new AppError('CONFLICT', `A circle can have up to ${CIRCLE_LIMITS.maxMembers} members.`);
      if (circles.pendingInvites(circle.id, nowIso()).length >= CIRCLE_LIMITS.maxPendingInvites) {
        throw new AppError('CONFLICT', `You can have up to ${CIRCLE_LIMITS.maxPendingInvites} pending invites. Revoke one first.`);
      }
      const code = generateCode();
      const expiresAt = new Date(clock().getTime() + CIRCLE_LIMITS.inviteTtlMs).toISOString();
      const id = circles.insertInvite({
        circle_id: circle.id,
        code_hash: codeHash(code),
        bound_phone_hash: phone ? phoneHash(phone) : null,
        created_by: user.id,
        created_at: nowIso(),
        expires_at: expiresAt,
      });
      audit.record({ actorType: 'user', actorId: user.id, action: 'circle.invite_created', targetType: 'circle', targetId: circle.id, metadata: { inviteId: id, boundToPhone: Boolean(phone) } });
      return { id, code, expiresAt, boundToPhone: Boolean(phone) };
    },

    revokeInvite(user: UserRow, circleId: string, inviteId: string): void {
      const circle = requireCircle(circleId, user.id);
      if (circle.owner_id !== user.id) throw forbidden('Only the circle owner can revoke invites');
      if (!circles.revokeInvite(inviteId, circle.id, nowIso())) throw notFound('Invite');
      audit.record({ actorType: 'user', actorId: user.id, action: 'circle.invite_revoked', targetType: 'circle', targetId: circle.id, metadata: { inviteId } });
    },

    async accept(user: UserRow, code: string, expectedCircleId?: string): Promise<Circle> {
      const invite = circles.inviteByCodeHash(codeHash(code));
      const now = clock().getTime();
      if (!invite || invite.revoked_at || invite.accepted_at || Date.parse(invite.expires_at) <= now) throw new AppError('BAD_REQUEST', INVALID_INVITE);
      if (expectedCircleId && invite.circle_id !== expectedCircleId) throw new AppError('BAD_REQUEST', INVALID_INVITE);
      if (invite.bound_phone_hash && (!user.phone_e164 || invite.bound_phone_hash !== phoneHash(user.phone_e164))) {
        throw new AppError('BAD_REQUEST', INVALID_INVITE);
      }
      const circle = circles.byId(invite.circle_id);
      if (!circle) throw new AppError('BAD_REQUEST', INVALID_INVITE);
      if (circle.owner_id === user.id) throw new AppError('BAD_REQUEST', 'This is your own circle.');
      if (circles.isActiveMember(circle.id, user.id)) return serialize(circle, user.id);
      if (circles.activeMemberCount(circle.id) >= CIRCLE_LIMITS.maxMembers) throw new AppError('CONFLICT', 'This circle is full.');
      // A block between the invitee and any member makes the invite unusable (reason not revealed).
      const memberIds = circles.activeMembers(circle.id).map((m) => m.user_id);
      if (safety.anyBlockedAmong(user.id, memberIds)) throw new AppError('BAD_REQUEST', INVALID_INVITE);

      const channel = community.channel(circle.channel_id);
      if (!channel) throw new AppError('INTERNAL', 'Circle channel missing');
      await communityService.addMember(channel, user, 'member');
      if (!circles.acceptInvite(invite.id, user.id, new Date(now).toISOString())) {
        await communityService.removeFromChannel(channel.id, user.id, user.id);
        throw new AppError('BAD_REQUEST', INVALID_INVITE);
      }
      circles.addGuardian(circle.id, user.id, new Date(now).toISOString());
      audit.record({ actorType: 'user', actorId: user.id, action: 'circle.invite_accepted', targetType: 'circle', targetId: circle.id, metadata: { inviteId: invite.id } });
      return serialize(circle, user.id);
    },

    /** The owner removes a guardian, or a guardian removes themselves (leaves). */
    async removeMember(user: UserRow, circleId: string, targetPublicId: string): Promise<void> {
      const circle = requireCircle(circleId, user.id);
      const targetId = community.userIdForChatUserId(targetPublicId);
      if (!targetId || !circles.isActiveMember(circle.id, targetId)) throw notFound('Member');
      if (targetId === circle.owner_id) throw new AppError('BAD_REQUEST', 'The owner can’t be removed from their own circle.');
      if (user.id !== circle.owner_id && user.id !== targetId) throw forbidden('Only the circle owner can remove other members');
      await removeGuardian(circle, targetId, user.id === targetId ? 'left' : 'removed', user.id);
    },

    /** Called when `blockerId` blocks `blockedId`: they must not stay in each other's circles. */
    async separateAfterBlock(blockerId: string, blockedId: string): Promise<void> {
      const own = circles.byOwner(blockerId);
      if (own && circles.isActiveMember(own.id, blockedId)) await removeGuardian(own, blockedId, 'removed', blockerId);
      const theirs = circles.byOwner(blockedId);
      if (theirs && circles.isActiveMember(theirs.id, blockerId)) await removeGuardian(theirs, blockerId, 'left', blockerId);
    },
  };
}

export type CircleService = ReturnType<typeof createCircleService>;
