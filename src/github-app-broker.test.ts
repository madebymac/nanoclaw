import { describe, it, expect, beforeAll, afterAll, vi, afterEach } from 'vitest';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { mintInstallationToken } from './github-app-broker.js';

let dir: string;
let keyPath: string;

beforeAll(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'gh-app-'));
  keyPath = path.join(dir, 'key.pem');
  const { privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
  });
  writeFileSync(keyPath, privateKey as string, { mode: 0o600 });
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('github-app-broker', () => {
  it('mints an installation token via the GitHub API', async () => {
    const fetchMock = vi.fn(async (url: string, init: { method?: string; headers: Record<string, string> }) => {
      // Signs and posts to the installation access_tokens endpoint with a JWT.
      expect(url).toBe('https://api.github.com/app/installations/42/access_tokens');
      expect(init.method).toBe('POST');
      expect(init.headers.Authorization).toMatch(/^Bearer .+\..+\..+$/); // header.payload.sig
      return new Response(JSON.stringify({ token: 'ghs_minted' }), { status: 201 });
    });
    vi.stubGlobal('fetch', fetchMock);

    const token = await mintInstallationToken({
      appId: '123',
      installationId: '42',
      privateKeyPath: keyPath,
    });
    expect(token).toBe('ghs_minted');
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('honours a custom api_url', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      expect(url).toBe('https://ghe.example.com/api/v3/app/installations/9/access_tokens');
      return new Response(JSON.stringify({ token: 't' }), { status: 201 });
    });
    vi.stubGlobal('fetch', fetchMock);

    const token = await mintInstallationToken({
      appId: '1',
      installationId: '9',
      privateKeyPath: keyPath,
      apiUrl: 'https://ghe.example.com/api/v3',
    });
    expect(token).toBe('t');
  });

  it('returns null (best-effort) when the key path is unreadable', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const token = await mintInstallationToken({
      appId: '1',
      installationId: '9',
      privateKeyPath: path.join(dir, 'does-not-exist.pem'),
    });
    expect(token).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns null when GitHub responds non-OK', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('nope', { status: 401 })),
    );
    const token = await mintInstallationToken({
      appId: '1',
      installationId: '9',
      privateKeyPath: keyPath,
    });
    expect(token).toBeNull();
  });
});
