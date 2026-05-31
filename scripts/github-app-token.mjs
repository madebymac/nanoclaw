#!/usr/bin/env node
// Exchanges a GitHub App private key for a short-lived installation token.
// The private key is read from disk — it never appears in any LLM context.
//
// Required env vars:
//   GITHUB_APP_ID                - App's numeric ID
//   GITHUB_APP_PRIVATE_KEY_PATH  - Absolute path to the .pem file
//   GITHUB_APP_INSTALLATION_ID   - Installation ID (from github.com/settings/installations URL)
//
// Optional:
//   GITHUB_API_URL               - Defaults to https://api.github.com
//
// Usage: TOKEN=$(node scripts/github-app-token.mjs)

import { createSign } from 'node:crypto';
import { readFileSync } from 'node:fs';

const appId = process.env.GITHUB_APP_ID;
const keyPath = process.env.GITHUB_APP_PRIVATE_KEY_PATH;
const installationId = process.env.GITHUB_APP_INSTALLATION_ID;
const apiUrl = process.env.GITHUB_API_URL ?? 'https://api.github.com';

if (!appId || !keyPath || !installationId) {
  process.stderr.write(
    'Error: GITHUB_APP_ID, GITHUB_APP_PRIVATE_KEY_PATH, and GITHUB_APP_INSTALLATION_ID are required\n'
  );
  process.exit(1);
}

const privateKey = readFileSync(keyPath, 'utf8').trim();
const now = Math.floor(Date.now() / 1000);

const b64url = (obj) =>
  Buffer.from(typeof obj === 'string' ? obj : JSON.stringify(obj))
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=/g, '');

const header = b64url({ alg: 'RS256', typ: 'JWT' });
const payload = b64url({ iat: now - 60, exp: now + 600, iss: appId });
const signingInput = `${header}.${payload}`;

const sign = createSign('RSA-SHA256');
sign.update(signingInput);
const sig = sign.sign(privateKey, 'base64')
  .replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');

const jwt = `${signingInput}.${sig}`;

const controller = new AbortController();
const timeout = setTimeout(() => controller.abort(), 10_000);
let res;
try {
  res = await fetch(`${apiUrl}/app/installations/${installationId}/access_tokens`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${jwt}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    },
    signal: controller.signal,
  });
} catch (err) {
  process.stderr.write(`GitHub API request failed: ${err.message}\n`);
  process.exit(1);
} finally {
  clearTimeout(timeout);
}

if (!res.ok) {
  const body = await res.text().catch(() => '');
  process.stderr.write(`GitHub API error ${res.status}: ${body}\n`);
  process.exit(1);
}

const { token } = await res.json();
process.stdout.write(token + '\n');
