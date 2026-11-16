import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { auditEventSchema, channelSummarySchema, chatSessionSchema, communityReviewItemSchema, moderationQueueSchema } from '@mahilasathi/shared';
import { createTestApp, signIn } from '../helpers/testApp.js';

const ADMIN = 'moderation-ui-admin-token-0123456789abcdef';

async function resident(app: Parameters<typeof signIn>[0], name: string) {
  const s = await signIn(app);
  await s.agent.patch('/api/users/me').send({ displayName: name, homeNeighbourhoodId: 'delhi-saket' }).expect(200);
  const session = chatSessionSchema.parse((await s.agent.get('/api/community/session').expect(200)).body);
  const me = (await s.agent.get('/api/auth/me').expect(200)).body as { id: string; communityHandle: string };
  return { ...s, publicId: session.chatUserId, handle: me.communityHandle, id: me.id };
}

describe('moderator views', () => {
  it('lists open reports with pseudonyms and context, never phone numbers or internal ids', async () => {
    const { app } = createTestApp({ env: { ADMIN_TOKEN: ADMIN } });
    const offender = await resident(app, 'Offender');
    const reporters = [await resident(app, 'R One'), await resident(app, 'R Two'), await resident(app, 'R Three')];
    const ch = channelSummarySchema.parse((await offender.agent.post('/api/community/neighbourhoods/delhi-saket/join').expect(200)).body);
    const msg = (await offender.agent.post(`/api/community/channels/${ch.id}/messages`).send({ text: 'you will regret walking here' }).expect(201)).body;
    for (const r of reporters) {
      await r.agent.post('/api/community/neighbourhoods/delhi-saket/join').expect(200);
      await r.agent.post(`/api/moderation/messages/${msg.id}/report`).send({ channelId: ch.id, reason: 'threat', details: 'Felt threatening' }).expect(201);
    }
    await reporters[0]!.agent.post('/api/reports').send({ reportedPublicId: offender.publicId, reason: 'harassment' }).expect(201);

    const res = await request(app).get('/api/moderation/queue').set('X-Admin-Token', ADMIN).expect(200);
    const queue = moderationQueueSchema.parse(res.body);
    expect(queue.messages).toHaveLength(3);
    expect(queue.users).toHaveLength(1);
    const first = queue.messages[0]!;
    expect(first).toMatchObject({
      type: 'message',
      reason: 'threat',
      details: 'Felt threatening',
      snapshotText: 'you will regret walking here',
      snapshotSource: 'server',
      reporterHandle: reporters[0]!.handle,
      channel: { name: expect.any(String), kind: 'neighbourhood' },
    });
    // Three different reporters triggered the automatic pause; the view shows it and the report count.
    expect(first.reported).toMatchObject({ handle: offender.handle, isDemo: false, openReports: 4, suspendedUntil: expect.any(String) });
    expect(queue.users[0]).toMatchObject({ type: 'user', reason: 'harassment', snapshotText: null, channel: null, reported: { handle: offender.handle } });

    // Nothing that identifies people beyond their pseudonym leaves the server.
    const raw = JSON.stringify(res.body);
    for (const p of [offender, ...reporters]) {
      expect(raw).not.toContain(p.phone);
      expect(raw).not.toContain(p.id);
    }
    expect(raw).not.toMatch(/reporter_id|reported_user_id|phone/);

    // Dismissing all reports lifts the automatic pause, and the queue empties.
    for (const r of [...queue.messages, ...queue.users]) {
      await request(app).post(`/api/moderation/reports/${r.id}/resolve`).set('X-Admin-Token', ADMIN).send({ action: 'dismiss', reason: 'Context: friends joking' }).expect(200);
    }
    const after = moderationQueueSchema.parse((await request(app).get('/api/moderation/queue').set('X-Admin-Token', ADMIN).expect(200)).body);
    expect(after).toEqual({ messages: [], users: [] });
    await offender.agent.post(`/api/community/channels/${ch.id}/messages`).send({ text: 'sorry about that' }).expect(201);
  });

  it('serves community reports and a filterable audit log in the shapes the moderator screen expects', async () => {
    const { app } = createTestApp({ env: { ADMIN_TOKEN: ADMIN } });
    const a = await resident(app, 'Reporter');
    await a.agent.post('/api/community/reports').send({ category: 'harassment', description: 'Followed from the gate', lat: 28.5245, lng: 77.2066 }).expect(201);
    const reports = (await request(app).get('/api/moderation/community-reports').set('X-Admin-Token', ADMIN).expect(200)).body.reports;
    expect(reports.map((r: unknown) => communityReviewItemSchema.parse(r))).toEqual([expect.objectContaining({ category: 'harassment', status: 'under_review', demo: false })]);

    const audit = (await request(app).get('/api/moderation/audit').query({ action: 'community.', limit: 5 }).set('X-Admin-Token', ADMIN).expect(200)).body.events;
    expect(audit.length).toBeGreaterThan(0);
    for (const e of audit) expect(auditEventSchema.parse(e).action.startsWith('community.')).toBe(true);
  });

  it('requires the admin token and is switched off without one', async () => {
    const on = createTestApp({ env: { ADMIN_TOKEN: ADMIN } }).app;
    for (const path of ['/api/moderation/queue', '/api/moderation/community-reports', '/api/moderation/audit']) {
      await request(on).get(path).expect(401);
      await request(on).get(path).set('X-Admin-Token', `${ADMIN}x`).expect(401);
    }
    // A signed-in user's session is not enough.
    const u = await signIn(on);
    await u.agent.get('/api/moderation/queue').expect(401);
    const off = createTestApp().app;
    await request(off).get('/api/moderation/queue').set('X-Admin-Token', ADMIN).expect(404);
  });
});
