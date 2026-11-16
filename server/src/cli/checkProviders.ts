/**
 * Checks that configured provider credentials actually work, without printing them.
 *
 *   npm run check:providers
 *
 * Nexconn: issues an access token for a fixed diagnostic user id (`mscheck`). This registers that
 * user at Nexconn if it doesn't exist; it has no other effect.
 * Geoapify: runs one autocomplete query restricted to NCR.
 */
import { ConfigError, loadConfigFromProcess } from '../config/index.js';
import { createGeoapifyGeocoder } from '../services/geography/providers/geoapifyGeocoder.js';
import { createNexconnServerApi } from '../services/nexconn/nexconnServerApi.js';

type Result = { name: string; status: 'ok' | 'failed' | 'not configured'; detail: string };

async function main(): Promise<void> {
  let config;
  try {
    config = loadConfigFromProcess();
  } catch (err) {
    console.error(err instanceof ConfigError ? err.message : String(err));
    process.exitCode = 1;
    return;
  }
  console.log(`Config valid (NODE_ENV=${config.env}, DEMO_MODE=${config.demoMode}).`);
  if (config.jwtSecretIsEphemeral) console.log('Note: JWT_SECRET is empty, so sessions reset on restart (fine for development).');
  if (!config.adminToken) console.log('Note: ADMIN_TOKEN is empty, so moderator endpoints are disabled.');

  const results: Result[] = [];

  const { appKey, appSecret, apiHosts, area } = config.nexconn;
  if (appKey && appSecret) {
    const started = Date.now();
    try {
      const api = createNexconnServerApi({ appKey, appSecret, hosts: apiHosts });
      const token = await api.issueAccessToken('mscheck', 'mahilaSathi check');
      results.push({ name: 'Nexconn', status: 'ok', detail: `token issued (${token.length} chars) via ${apiHosts.join(' → ')} [area ${area}] in ${Date.now() - started} ms` });
    } catch (err) {
      results.push({ name: 'Nexconn', status: 'failed', detail: `${(err as Error).message} (hosts tried: ${apiHosts.join(', ')})` });
    }
  } else {
    results.push({ name: 'Nexconn', status: 'not configured', detail: 'community chat will use the development relay' });
  }

  if (config.geoapify.apiKey) {
    const started = Date.now();
    try {
      const places = await createGeoapifyGeocoder(config.geoapify.apiKey).search('Connaught Place', { limit: 3 });
      results.push({ name: 'Geoapify', status: 'ok', detail: `${places.length} result(s), first: "${places[0]?.label ?? '—'}" in ${Date.now() - started} ms` });
    } catch (err) {
      results.push({ name: 'Geoapify', status: 'failed', detail: (err as Error).message });
    }
  } else {
    results.push({ name: 'Geoapify', status: 'not configured', detail: 'place search uses the local NCR gazetteer; Phase 3 routing would use labelled synthetic routes' });
  }

  for (const r of results) console.log(`${r.status === 'ok' ? '✔' : r.status === 'failed' ? '✘' : '–'} ${r.name.padEnd(9)} ${r.status.padEnd(15)} ${r.detail}`);
  if (results.some((r) => r.status === 'failed')) process.exitCode = 1;
}

void main();
