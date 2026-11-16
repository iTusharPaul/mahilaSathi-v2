import { describe, expect, it } from 'vitest';
import { chatSessionSchema, circleSchema, inviteCreatedSchema } from '@mahilasathi/shared';
import { CIRCLE_LIMITS } from '../../server/src/services/circles/circleService.js';
import { createTestApp, signIn, testClock, type TestContext } from '../helpers/testApp.js';

async function person(app: TestContext['app'], name: string) {
  const s = await signIn(app);
  await s.agent.patch('/api/users/me').send({ displayName: name }).expect(200);
  const { chatUserId } = chatSessionSchema.parse((await s.agent.get('/api/community/session').expect(200)).body);
  return { ...s, publicId: chatUserId };
}

describe('Guardian Circle', () => {
  it('creates a private circle, invites with a single-use code, and lets members chat', async () => {
    const { app, db } = createTestApp();
    const lotus = await person(app, 'Lotus');
    const jasmine = await person(app, 'Jasmine');
    const stranger = await person(app, 'Stranger');

    const circle = circleSchema.parse((await lotus.agent.post('/api/circles').send({ name: 'Family' }).expect(201)).body);
    expect(circle).toMatchObject({ isOwner: true, members: [{ role: 'owner', displayName: 'Lotus' }] });
    await lotus.agent.post('/api/circles').send({}).expect(409);

    const invite = inviteCreatedSchema.parse((await lotus.agent.post(`/api/circles/${circle.id}/invite`).send({}).expect(201)).body);
    expect(invite.code).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    expect(JSON.stringify(db.prepare('SELECT * FROM circle_invites').all())).not.toContain(invite.code.replace('-', ''));

    const joined = circleSchema.parse((await jasmine.agent.post('/api/circles/accept').send({ code: invite.code.toLowerCase() }).expect(200)).body);
    expect(joined.isOwner).toBe(false);
    expect(joined.members.map((m) => m.displayName)).toEqual(['Lotus', 'Jasmine']);
    expect(joined.pendingInvites).toEqual([]); // only the owner sees invites

    // Single use.
    await stranger.agent.post('/api/circles/accept').send({ code: invite.code }).expect(400);

    // Members chat privately, and may share contact details there.
    await jasmine.agent.post(`/api/community/channels/${circle.channelId}/messages`).send({ text: 'Home safe? Call me on 98765 43210' }).expect(201);
    const msgs = (await lotus.agent.get(`/api/community/channels/${circle.channelId}/messages`).expect(200)).body.messages;
    expect(msgs).toHaveLength(1);
    const members = (await lotus.agent.get(`/api/community/channels/${circle.channelId}/members`).expect(200)).body.members;
    expect(members.map((m: { displayName: string }) => m.displayName)).toEqual(['Lotus', 'Jasmine']);

    // Non-members cannot discover, read, post to, or list the circle.
    await stranger.agent.get(`/api/community/channels/${circle.channelId}`).expect(404);
    await stranger.agent.get(`/api/community/channels/${circle.channelId}/members`).expect(404);
    await stranger.agent.get(`/api/community/channels/${circle.channelId}/messages`).expect(403);
    await stranger.agent.post(`/api/community/channels/${circle.channelId}/messages`).send({ text: 'hi' }).expect(404);
    expect((await stranger.agent.get('/api/circles').expect(200)).body.circles).toEqual([]);
    await stranger.agent.post(`/api/circles/${circle.id}/invite`).send({}).expect(404);
    await stranger.agent.delete(`/api/circles/${circle.id}/members/${jasmine.publicId}`).expect(404);

    // Circles cannot be left through the generic channel API.
    await jasmine.agent.post(`/api/community/channels/${circle.channelId}/leave`).expect(400);
  });

  it('binds invites to a phone number when given one, and expires them', async () => {
    const clock = testClock();
    const { app } = createTestApp({ clock });
    const owner = await person(app, 'Owner');
    const intended = await person(app, 'Intended');
    const other = await person(app, 'Other');
    const circle = (await owner.agent.post('/api/circles').send({}).expect(201)).body;

    const bound = (await owner.agent.post(`/api/circles/${circle.id}/invite`).send({ phone: intended.phone }).expect(201)).body;
    expect(bound.boundToPhone).toBe(true);
    await other.agent.post('/api/circles/accept').send({ code: bound.code }).expect(400);
    await intended.agent.post(`/api/circles/${circle.id}/accept`).send({ code: bound.code }).expect(200);

    const later = (await owner.agent.post(`/api/circles/${circle.id}/invite`).send({}).expect(201)).body;
    clock.advance(CIRCLE_LIMITS.inviteTtlMs + 1);
    await other.agent.post('/api/circles/accept').send({ code: later.code }).expect(400);
    await owner.agent.post(`/api/circles/${circle.id}/invite`).send({ phone: owner.phone }).expect(400);
  });

  it('only the owner invites or removes; guardians can leave', async () => {
    const { app } = createTestApp();
    const owner = await person(app, 'Owner');
    const g1 = await person(app, 'Guardian One');
    const g2 = await person(app, 'Guardian Two');
    const circle = (await owner.agent.post('/api/circles').send({}).expect(201)).body;
    for (const g of [g1, g2]) {
      const { code } = (await owner.agent.post(`/api/circles/${circle.id}/invite`).send({}).expect(201)).body;
      await g.agent.post('/api/circles/accept').send({ code }).expect(200);
    }
    await g1.agent.post(`/api/circles/${circle.id}/invite`).send({}).expect(403);
    await g1.agent.delete(`/api/circles/${circle.id}/members/${g2.publicId}`).expect(403);
    await g1.agent.delete(`/api/circles/${circle.id}/members/${owner.publicId}`).expect(400);

    await owner.agent.delete(`/api/circles/${circle.id}/members/${g2.publicId}`).expect(204);
    await g2.agent.get(`/api/community/channels/${circle.channelId}/messages`).expect(403);
    await g1.agent.delete(`/api/circles/${circle.id}/members/${g1.publicId}`).expect(204);
    expect((await g1.agent.get('/api/circles').expect(200)).body.circles).toEqual([]);
    expect((await owner.agent.get('/api/circles').expect(200)).body.circles[0].members).toHaveLength(1);
  });

  it('blocking separates users from each other’s circles and voids invites between them', async () => {
    const { app } = createTestApp();
    const owner = await person(app, 'Owner');
    const g = await person(app, 'Guardian');
    const circle = (await owner.agent.post('/api/circles').send({}).expect(201)).body;
    const { code } = (await owner.agent.post(`/api/circles/${circle.id}/invite`).send({}).expect(201)).body;
    await g.agent.post('/api/circles/accept').send({ code }).expect(200);

    await owner.agent.post(`/api/users/${g.publicId}/block`).expect(204);
    expect((await g.agent.get('/api/circles').expect(200)).body.circles).toEqual([]);

    // A new invite cannot be used to rejoin while the block stands.
    const again = (await owner.agent.post(`/api/circles/${circle.id}/invite`).send({}).expect(201)).body;
    await g.agent.post('/api/circles/accept').send({ code: again.code }).expect(400);
  });
});
