/**
 * Thin GitHub REST helpers for the PR-review cron. All calls use the review
 * bot's installation token (minted host-side, never AI-visible) and read-only
 * endpoints — listing repos/PRs and checking for the bot's own reviews and
 * comments. No writes happen here; the actual review (inline comments /
 * approval) is performed by the agent, not the host.
 */
import { log } from '../../log.js';

const API_VERSION = '2022-11-28';

export interface InstallationRepo {
  owner: string;
  repo: string;
  fullName: string;
}

export interface OpenPull {
  number: number;
  title: string;
  draft: boolean;
  headSha: string | null;
  htmlUrl: string;
  author: string;
}

async function ghFetch(
  token: string,
  apiUrl: string,
  pathAndQuery: string,
  timeoutMs: number,
): Promise<unknown | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${apiUrl}${pathAndQuery}`, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': API_VERSION,
      },
      signal: controller.signal,
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      log.warn('pr-review: GitHub API non-OK', { path: pathAndQuery, status: res.status, body: body.slice(0, 200) });
      return null;
    }
    return await res.json();
  } catch (err) {
    log.warn('pr-review: GitHub API request failed', { path: pathAndQuery, err });
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Page through a list endpoint until a short page (or the cap) is reached.
 * Returns null if any page fails — callers treat null as "couldn't determine,
 * skip this tick" rather than acting on partial data.
 */
async function ghFetchAll(
  token: string,
  apiUrl: string,
  basePath: string,
  timeoutMs: number,
  maxPages = 10,
): Promise<unknown[] | null> {
  const out: unknown[] = [];
  for (let page = 1; page <= maxPages; page++) {
    const sep = basePath.includes('?') ? '&' : '?';
    const json = (await ghFetch(token, apiUrl, `${basePath}${sep}per_page=100&page=${page}`, timeoutMs)) as
      | unknown[]
      | { repositories?: unknown[] }
      | null;
    if (json === null) return null;
    // /installation/repositories wraps the list in `.repositories`; list
    // endpoints return a bare array.
    const items = Array.isArray(json) ? json : Array.isArray(json.repositories) ? json.repositories : [];
    out.push(...items);
    if (items.length < 100) break;
  }
  return out;
}

export async function listInstallationRepos(
  token: string,
  apiUrl: string,
  timeoutMs: number,
): Promise<InstallationRepo[] | null> {
  const items = await ghFetchAll(token, apiUrl, '/installation/repositories', timeoutMs);
  if (items === null) return null;
  return items
    .map((r) => r as { name?: string; owner?: { login?: string }; full_name?: string })
    .filter((r) => r.owner?.login && r.name)
    .map((r) => ({ owner: r.owner!.login as string, repo: r.name as string, fullName: r.full_name ?? `${r.owner!.login}/${r.name}` }));
}

export async function listOpenPulls(
  token: string,
  apiUrl: string,
  owner: string,
  repo: string,
  timeoutMs: number,
): Promise<OpenPull[] | null> {
  const items = await ghFetchAll(token, apiUrl, `/repos/${owner}/${repo}/pulls?state=open`, timeoutMs);
  if (items === null) return null;
  return items.map((p) => {
    const pr = p as {
      number: number;
      title?: string;
      draft?: boolean;
      head?: { sha?: string };
      html_url?: string;
      user?: { login?: string };
    };
    return {
      number: pr.number,
      title: pr.title ?? '',
      draft: pr.draft === true,
      headSha: pr.head?.sha ?? null,
      htmlUrl: pr.html_url ?? '',
      author: pr.user?.login ?? 'unknown',
    };
  });
}

/**
 * Has `botLogin` left a formal review OR any comment on this PR? Checks the
 * reviews, issue-comments, and review-comments endpoints. Returns null if any
 * call fails (so the caller can skip rather than mis-dispatch).
 */
export async function botHasTouchedPull(
  token: string,
  apiUrl: string,
  owner: string,
  repo: string,
  prNumber: number,
  botLogin: string,
  timeoutMs: number,
): Promise<boolean | null> {
  const endpoints = [
    `/repos/${owner}/${repo}/pulls/${prNumber}/reviews`,
    `/repos/${owner}/${repo}/issues/${prNumber}/comments`,
    `/repos/${owner}/${repo}/pulls/${prNumber}/comments`,
  ];
  for (const ep of endpoints) {
    const items = await ghFetchAll(token, apiUrl, ep, timeoutMs);
    if (items === null) return null;
    const found = items.some((i) => (i as { user?: { login?: string } }).user?.login === botLogin);
    if (found) return true;
  }
  return false;
}
