import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
// @ts-expect-error plain ESM script without type declarations
import { scanForSecrets } from '../../scripts/check-client-secrets.mjs';
import { makeTempDir } from '../helpers/testApp.js';

const CLIENT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../client');

const PLANTED = {
  JWT_SECRET: 'planted-jwt-secret-value-0123456789',
  ADMIN_TOKEN: 'planted-admin-token-value-0123456789',
  GEOAPIFY_API_KEY: 'planted-geoapify-key-0123',
  NEXCONN_APP_SECRET: 'planted-nexconn-secret-0123',
  // Even a VITE_-prefixed variable must not reach the bundle: the client reads no env at all.
  VITE_GEOAPIFY_API_KEY: 'planted-vite-prefixed-key-0123',
};

describe('scanForSecrets', () => {
  it('finds planted values and server-only variable names', () => {
    const dir = makeTempDir();
    fs.writeFileSync(path.join(dir, 'a.js'), 'const k="super-secret-value-1"; const n="NEXCONN_APP_SECRET";');
    fs.writeFileSync(path.join(dir, 'b.js'), 'clean');
    const findings = scanForSecrets(dir, { values: ['super-secret-value-1'] });
    expect(findings).toEqual([
      { file: 'a.js', kind: 'value', needle: 'sup…' },
      { file: 'a.js', kind: 'name', needle: 'NEXCONN_APP_SECRET' },
    ]);
  });
});

describe('production client bundle', () => {
  let outDir: string;

  beforeAll(() => {
    // Build with the client's own Vite and config, exactly as `npm run build` does, but with
    // secrets planted in the build environment.
    const viteBin = path.join(
      path.dirname(createRequire(path.join(CLIENT_ROOT, 'package.json')).resolve('vite/package.json')),
      'bin',
      'vite.js',
    );
    outDir = path.join(makeTempDir('ms-bundle-'), 'dist');
    execFileSync(process.execPath, [viteBin, 'build', '--outDir', outDir, '--emptyOutDir', '--logLevel', 'error'], {
      cwd: CLIENT_ROOT,
      env: { ...process.env, ...PLANTED, NODE_ENV: 'production' },
      stdio: 'pipe',
    });
  }, 180_000);

  it('builds an index.html and hashed assets', () => {
    expect(fs.existsSync(path.join(outDir, 'index.html'))).toBe(true);
    expect(fs.readdirSync(path.join(outDir, 'assets')).some((f) => /\.js$/.test(f))).toBe(true);
  });

  it('contains no server secrets even when they are present in the build environment', () => {
    expect(scanForSecrets(outDir, { values: Object.values(PLANTED) })).toEqual([]);
  });
});
