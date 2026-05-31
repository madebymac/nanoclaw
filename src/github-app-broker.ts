/**
 * GitHub App token broker.
 *
 * Exchanges a GitHub App private key (read from disk) for a short-lived (~1h)
 * installation access token. The private key never enters any LLM context and
 * never touches the DB — only its filesystem path is stored
 * (github_app_identities.private_key_path), pointing at a chmod-600 .pem on the
 * host outside the repo.
 *
 * This is the "second secrets store" broker for credentials OneCLI cannot do on
 * its free plan (self-hosted GitHub App bot identity is a Pro feature). The
 * minted token is injected into the agent's container at spawn time as
 * GH_TOKEN / GITHUB_TOKEN (see container-runner.ts) so the agent can act AS the
 * app's bot identity. The token is short-lived and scoped to the installation;
 * only the long-lived private key needs protecting, and it stays on the host.
 *
 * Ported from scripts/github-app-token.mjs so the host can mint inline without
 * shelling out.
 */
import { createSign } from 'node:crypto';
import { readFileSync } from 'node:fs';

import { log } from './log.js';

export interface GithubAppCredentials {
  appId: string;
  installationId: string;
  privateKeyPath: string;
  apiUrl?: string | null;
}

function b64url(input: string): string {
  return Buffer.from(input).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

/** Build a short-lived app JWT (RS256) signed with the app private key. */
function buildAppJwt(appId: string, privateKey: string): string {
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  // iat backdated 60s to tolerate clock skew; 10-minute lifetime (GitHub max).
  const payload = b64url(JSON.stringify({ iat: now - 60, exp: now + 600, iss: appId }));
  const signingInput = `${header}.${payload}`;
  const sig = createSign('RSA-SHA256')
    .update(signingInput)
    .sign(privateKey, 'base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=/g, '');
  return `${signingInput}.${sig}`;
}

/**
 * Mint a short-lived installation access token. Returns null (and logs) on any
 * failure — callers treat a null token as "spawn without GitHub-App creds"
 * rather than blocking the container, mirroring OneCLI's best-effort posture.
 */
export async function mintInstallationToken(creds: GithubAppCredentials): Promise<string | null> {
  const apiUrl = creds.apiUrl || 'https://api.github.com';
  let privateKey: string;
  try {
    privateKey = readFileSync(creds.privateKeyPath, 'utf8').trim();
  } catch (err) {
    log.warn('GitHub App private key unreadable; skipping token mint', {
      privateKeyPath: creds.privateKeyPath,
      err,
    });
    return null;
  }

  let jwt: string;
  try {
    jwt = buildAppJwt(creds.appId, privateKey);
  } catch (err) {
    log.warn('GitHub App JWT signing failed; skipping token mint', { appId: creds.appId, err });
    return null;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);
  try {
    const res = await fetch(`${apiUrl}/app/installations/${creds.installationId}/access_tokens`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${jwt}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
      signal: controller.signal,
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      log.warn('GitHub App token mint non-OK', { status: res.status, body: body.slice(0, 200) });
      return null;
    }
    const json = (await res.json()) as { token?: string };
    return json.token ?? null;
  } catch (err) {
    log.warn('GitHub App token mint request failed', { err });
    return null;
  } finally {
    clearTimeout(timeout);
  }
}
