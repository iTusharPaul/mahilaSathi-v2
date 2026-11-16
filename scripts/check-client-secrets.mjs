#!/usr/bin/env node
// Scans the built client bundle for server secrets. Run after `npm run build`:
//   npm run check:secrets
// Exits non-zero if any configured secret value (from .env or the environment) or any
// server-only variable name appears in client/dist.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const SECRET_ENV_VARS = [
  'JWT_SECRET',
  'ADMIN_TOKEN',
  'GEOAPIFY_API_KEY',
  'NEXCONN_APP_SECRET',
  'OTP_PROVIDER_API_KEY',
  'PUSH_PROVIDER_API_KEY',
];

function* walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(full);
    else yield full;
  }
}

/** Returns one finding per (file, needle) match. Values shorter than 8 chars are ignored as too noisy. */
export function scanForSecrets(dir, { values = [], names = SECRET_ENV_VARS } = {}) {
  const needles = [
    ...values.filter((v) => typeof v === 'string' && v.length >= 8).map((v) => ({ kind: 'value', needle: v })),
    ...names.map((n) => ({ kind: 'name', needle: n })),
  ];
  const findings = [];
  for (const file of walk(dir)) {
    const text = fs.readFileSync(file, 'utf8');
    for (const { kind, needle } of needles) {
      if (text.includes(needle)) {
        findings.push({ file: path.relative(dir, file), kind, needle: kind === 'value' ? `${needle.slice(0, 3)}…` : needle });
      }
    }
  }
  return findings;
}

function readDotEnv(file) {
  if (!fs.existsSync(file)) return {};
  const out = {};
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*(#.*)?$/.exec(line);
    if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
  return out;
}

const isCli = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isCli) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const dist = path.join(root, 'client', 'dist');
  if (!fs.existsSync(dist)) {
    console.error('client/dist not found. Run `npm run build` first.');
    process.exit(2);
  }
  const env = { ...readDotEnv(path.join(root, '.env')), ...process.env };
  const findings = scanForSecrets(dist, { values: SECRET_ENV_VARS.map((k) => env[k]) });
  if (findings.length) {
    console.error('Server secrets found in the client bundle:');
    for (const f of findings) console.error(`  ${f.file}: ${f.kind} ${f.needle}`);
    process.exit(1);
  }
  console.log(`No server secrets found in ${path.relative(root, dist)}.`);
}
