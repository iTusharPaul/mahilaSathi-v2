import {
  blockedUserSchema,
  channelMemberSchema,
  channelSummarySchema,
  chatSessionSchema,
  circleSchema,
  inviteCreatedSchema,
  relayMessageSchema,
  type CreateJourneyRoom,
  type REPORT_REASONS,
} from '@mahilasathi/shared';
import { z } from 'zod';
import { apiRequest } from './apiClient';

const neighbourhoodOptionsSchema = z.object({
  homeNeighbourhoodId: z.string().nullable(),
  joinedCount: z.number(),
  limit: z.number(),
  neighbourhoods: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      city: z.string().nullable(),
      district: z.string(),
      isHome: z.boolean(),
      channel: channelSummarySchema.nullable(),
    }),
  ),
});
export type NeighbourhoodOptions = z.infer<typeof neighbourhoodOptionsSchema>;

const enc = encodeURIComponent;
type Reason = (typeof REPORT_REASONS)[number];

export const communityApi = {
  session: () => apiRequest('/community/session', { schema: chatSessionSchema }),
  myChannels: () => apiRequest('/community/channels', { schema: z.object({ channels: z.array(channelSummarySchema) }) }),
  channel: (id: string) => apiRequest(`/community/channels/${enc(id)}`, { schema: channelSummarySchema }),
  members: (id: string) => apiRequest(`/community/channels/${enc(id)}/members`, { schema: z.object({ members: z.array(channelMemberSchema) }) }),
  leave: (id: string) => apiRequest(`/community/channels/${enc(id)}/leave`, { method: 'POST' }),
  neighbourhoods: () => apiRequest('/community/neighbourhoods', { schema: neighbourhoodOptionsSchema }),
  joinNeighbourhood: (neighbourhoodId: string) =>
    apiRequest(`/community/neighbourhoods/${enc(neighbourhoodId)}/join`, { method: 'POST', schema: channelSummarySchema }),
  journeyRooms: (districtId?: string) =>
    apiRequest(`/community/journey-rooms${districtId ? `?districtId=${enc(districtId)}` : ''}`, {
      schema: z.object({ rooms: z.array(channelSummarySchema) }),
    }),
  createJourneyRoom: (input: CreateJourneyRoom) => apiRequest('/community/channels', { method: 'POST', body: input, schema: channelSummarySchema }),
  joinRoom: (id: string) => apiRequest(`/community/channels/${enc(id)}/join`, { method: 'POST', schema: channelSummarySchema }),
  relayMessages: (id: string, params: { after?: number; before?: number }, signal?: AbortSignal) => {
    const qs = new URLSearchParams();
    if (params.after !== undefined) qs.set('after', String(params.after));
    if (params.before !== undefined) qs.set('before', String(params.before));
    return apiRequest(`/community/channels/${enc(id)}/messages?${qs}`, {
      schema: z.object({ messages: z.array(relayMessageSchema) }),
      ...(signal ? { signal } : {}),
    });
  },
  sendRelayText: (id: string, text: string) =>
    apiRequest(`/community/channels/${enc(id)}/messages`, {
      method: 'POST',
      body: { text },
      schema: z.object({ id: z.string(), seq: z.number(), sentAt: z.string() }),
    }),
  postUpdate: (id: string, input: { category: string; note: string }) =>
    apiRequest(`/community/channels/${enc(id)}/updates`, { method: 'POST', body: input }),

  circles: () => apiRequest('/circles', { schema: z.object({ circles: z.array(circleSchema) }) }),
  createCircle: (name: string) => apiRequest('/circles', { method: 'POST', body: { name }, schema: circleSchema }),
  invite: (circleId: string, phone?: string) =>
    apiRequest(`/circles/${enc(circleId)}/invite`, { method: 'POST', body: phone ? { phone } : {}, schema: inviteCreatedSchema }),
  revokeInvite: (circleId: string, inviteId: string) => apiRequest(`/circles/${enc(circleId)}/invites/${enc(inviteId)}`, { method: 'DELETE' }),
  acceptInvite: (code: string) => apiRequest('/circles/accept', { method: 'POST', body: { code }, schema: circleSchema }),
  removeCircleMember: (circleId: string, publicId: string) =>
    apiRequest(`/circles/${enc(circleId)}/members/${enc(publicId)}`, { method: 'DELETE' }),

  blocks: () => apiRequest('/users/me/blocks', { schema: z.object({ blocked: z.array(blockedUserSchema) }) }),
  block: (publicId: string) => apiRequest(`/users/${enc(publicId)}/block`, { method: 'POST' }),
  unblock: (publicId: string) => apiRequest(`/users/${enc(publicId)}/block`, { method: 'DELETE' }),
  reportMessage: (
    messageId: string,
    input: { channelId: string; reason: Reason; details?: string; snapshot?: { text: string; senderPublicId: string; sentAt: number } },
  ) => apiRequest(`/moderation/messages/${enc(messageId)}/report`, { method: 'POST', body: input }),
  reportUser: (input: { reportedPublicId: string; reason: Reason; details?: string; channelId?: string }) =>
    apiRequest('/reports', { method: 'POST', body: input }),
};
