import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { geoSearchResponseSchema, readyResponseSchema, resolutionSchema, reverseResponseSchema } from '@mahilasathi/shared';
import { createGeoapifyGeocoder } from '../../server/src/services/geography/providers/geoapifyGeocoder.js';
import type { FetchLike } from '../../server/src/services/geography/providers/types.js';
import { createTestApp, signIn } from '../helpers/testApp.js';

const API_KEY = 'test-geoapify-key-must-not-leak';

function fakeGeoapify(results: unknown[] | Error) {
  const calls: string[] = [];
  const fetchImpl: FetchLike = async (url) => {
    calls.push(url);
    if (results instanceof Error) throw results;
    return { ok: true, status: 200, json: async () => ({ results }) };
  };
  return { geocoder: createGeoapifyGeocoder(API_KEY, fetchImpl), calls };
}

describe('geo search', () => {
  it('requires sign-in', async () => {
    const { app } = createTestApp();
    await request(app).get('/api/geo/search?q=saket').expect(401);
    await request(app).get('/api/geo/resolve?lat=28.6&lng=77.2').expect(401);
  });

  it('uses the labelled local gazetteer when no provider is configured', async () => {
    const { app } = createTestApp({ geocoder: null });
    const { agent } = await signIn(app);
    const body = geoSearchResponseSchema.parse((await agent.get('/api/geo/search?q=indira').expect(200)).body);
    expect(body.provider).toEqual({ name: 'local-gazetteer', mode: 'dev-adapter' });
    expect(body.results[0]).toMatchObject({ label: 'Indirapuram', source: 'registry', neighbourhoodId: 'ghaziabad-indirapuram' });
    await agent.get('/api/geo/search?q=a').expect(400);
  });

  it('filters live provider results to NCR, keeps registry neighbourhoods first, and never leaks the key', async () => {
    const { geocoder, calls } = fakeGeoapify([
      { lat: 28.5245, lon: 77.2066, address_line1: 'Select Citywalk', address_line2: 'Saket, New Delhi', result_type: 'amenity', place_id: 'p1' },
      { lat: 26.9124, lon: 75.7873, address_line1: 'Saket Colony', address_line2: 'Jaipur, Rajasthan', result_type: 'suburb', place_id: 'p2' },
    ]);
    const { app } = createTestApp({ geocoder });
    const { agent } = await signIn(app);
    const res = await agent.get('/api/geo/search?q=saket').expect(200);
    const body = geoSearchResponseSchema.parse(res.body);
    expect(body.provider).toEqual({ name: 'geoapify', mode: 'live' });
    expect(body.outsideNcrHidden).toBe(1);
    expect(body.results.map((r) => r.label)).toEqual(['Saket', 'Select Citywalk']);
    expect(body.results[1]).toMatchObject({ source: 'geoapify', kind: 'place', neighbourhoodId: 'delhi-saket', stateName: 'NCT of Delhi' });
    expect(calls[0]).toContain('filter=rect');
    expect(res.text).not.toContain(API_KEY);
  });

  it('degrades to the local gazetteer when the provider fails, and says so', async () => {
    const { geocoder } = fakeGeoapify(new Error(`connect ECONNREFUSED https://api.geoapify.com?apiKey=${API_KEY}`));
    const { app } = createTestApp({ geocoder });
    const { agent } = await signIn(app);
    const res = await agent.get('/api/geo/search?q=dwarka').expect(200);
    const body = geoSearchResponseSchema.parse(res.body);
    expect(body).toMatchObject({ degraded: true, provider: { mode: 'dev-adapter' } });
    expect(body.results[0]?.label).toBe('Dwarka');
    expect(res.text).not.toContain(API_KEY);
  });

  it('reverse-geocodes with a registry label when there is no provider', async () => {
    const { app } = createTestApp({ geocoder: null });
    const { agent } = await signIn(app);
    const body = reverseResponseSchema.parse((await agent.get('/api/geo/reverse?lat=28.4950&lng=77.0895').expect(200)).body);
    expect(body.label).toBe('Cyber City');
    expect(body.resolution.state?.id).toBe('haryana');
  });
});

describe('geo resolve', () => {
  it('resolves NCR points and explains points outside NCR', async () => {
    const { app } = createTestApp();
    const { agent } = await signIn(app);
    const inside = resolutionSchema.parse((await agent.get('/api/geo/resolve?lat=28.627&lng=77.365').expect(200)).body);
    expect(inside).toMatchObject({ inNcr: true, state: { id: 'uttar-pradesh' }, neighbourhood: { id: 'noida-sector-62' } });

    const outside = resolutionSchema.parse((await agent.get('/api/geo/resolve?lat=12.9716&lng=77.5946').expect(200)).body);
    expect(outside.inNcr).toBe(false);
    expect(outside.message).toMatch(/outside the National Capital Region/);

    await agent.get('/api/geo/resolve?lat=200&lng=77').expect(400);
    await agent.get('/api/geo/resolve?lat=abc&lng=77').expect(400);
  });
});

describe('public geography', () => {
  it('serves boundaries at district, state and NCR level as GeoJSON', async () => {
    const { app } = createTestApp();
    const district = await request(app).get('/api/geo/boundaries').expect(200);
    expect(district.headers['content-type']).toContain('application/geo+json');
    expect(district.headers['cache-control']).toContain('public');
    expect(district.body.features).toHaveLength(34);
    expect((await request(app).get('/api/geo/boundaries?level=state').expect(200)).body.features).toHaveLength(4);
    expect((await request(app).get('/api/geo/boundaries?level=ncr').expect(200)).body.features).toHaveLength(1);
    await request(app).get('/api/geo/boundaries?level=planet').expect(400);
  });

  it('lists neighbourhoods by district and by distance', async () => {
    const { app } = createTestApp();
    const gurugram = (await request(app).get('/api/geo/neighbourhoods?districtId=hr-gurugram').expect(200)).body.neighbourhoods;
    expect(gurugram.length).toBeGreaterThanOrEqual(5);
    expect(gurugram.every((n: { district: { id: string } }) => n.district.id === 'hr-gurugram')).toBe(true);

    const near = (await request(app).get('/api/geo/neighbourhoods?near=28.5245,77.2066&limit=3').expect(200)).body.neighbourhoods;
    expect(near[0].id).toBe('delhi-saket');
    await request(app).get('/api/geo/neighbourhoods?near=nonsense').expect(400);
  });

  it('reports unknown coverage honestly and 404s unknown areas', async () => {
    const { app } = createTestApp();
    const res = await request(app).get('/api/geo/coverage?areaType=neighbourhood&areaId=delhi-saket').expect(200);
    expect(res.body.coverage).toMatchObject({ level: 'unknown', assessedAt: null });
    await request(app).get('/api/geo/coverage?areaType=district&areaId=nowhere').expect(404);
    const byPoint = await request(app).get('/api/geo/coverage?lat=28.495&lng=77.0895').expect(200);
    expect(byPoint.body).toMatchObject({ areaType: 'neighbourhood', areaId: 'gurugram-cyber-city', inNcr: true });
  });

  it('includes geography in readiness', async () => {
    const ready = readyResponseSchema.parse((await request(createTestApp().app).get('/api/ready').expect(200)).body);
    expect(ready.checks.geography).toMatchObject({ ok: true });
    const empty = readyResponseSchema.parse((await request(createTestApp({ seedGeo: false }).app).get('/api/ready').expect(503)).body);
    expect(empty.checks.geography.ok).toBe(false);
  });
});
