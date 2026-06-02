import { describe, expect, it, vi, afterEach } from 'vitest';

import { botHasTouchedPull, listInstallationRepos, listOpenPulls } from './github.js';

const API = 'https://api.github.com';
const TOKEN = 'ghs_test';
const TIMEOUT = 5_000;

function jsonResponse(body: unknown): Response {
  return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) } as unknown as Response;
}

function route(map: Record<string, unknown>): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      // Match by pathname prefix, ignoring the per_page/page query we append.
      const path = url.replace(API, '').split('&page=')[0];
      for (const key of Object.keys(map)) {
        if (path.startsWith(key)) return jsonResponse(map[key]);
      }
      return jsonResponse([]);
    }),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('listInstallationRepos', () => {
  it('unwraps the .repositories envelope into owner/repo/fullName', async () => {
    route({
      '/installation/repositories': {
        repositories: [
          { name: 'widgets', full_name: 'acme/widgets', owner: { login: 'acme' } },
          { name: 'gadgets', full_name: 'acme/gadgets', owner: { login: 'acme' } },
        ],
      },
    });
    const repos = await listInstallationRepos(TOKEN, API, TIMEOUT);
    expect(repos).toEqual([
      { owner: 'acme', repo: 'widgets', fullName: 'acme/widgets' },
      { owner: 'acme', repo: 'gadgets', fullName: 'acme/gadgets' },
    ]);
  });
});

describe('listOpenPulls', () => {
  it('maps PR fields including draft + head sha', async () => {
    route({
      '/repos/acme/widgets/pulls': [
        { number: 5, title: 'Feature', draft: false, head: { sha: 'abc' }, html_url: 'u5', user: { login: 'octocat' } },
        { number: 6, title: 'WIP', draft: true, head: { sha: 'def' }, html_url: 'u6', user: { login: 'dev' } },
      ],
    });
    const pulls = await listOpenPulls(TOKEN, API, 'acme', 'widgets', TIMEOUT);
    expect(pulls).toEqual([
      { number: 5, title: 'Feature', draft: false, headSha: 'abc', htmlUrl: 'u5', author: 'octocat' },
      { number: 6, title: 'WIP', draft: true, headSha: 'def', htmlUrl: 'u6', author: 'dev' },
    ]);
  });
});

describe('botHasTouchedPull', () => {
  it('returns true when the bot authored a review', async () => {
    route({
      '/repos/acme/widgets/pulls/5/reviews': [{ user: { login: 'reviewbot[bot]' } }],
    });
    expect(await botHasTouchedPull(TOKEN, API, 'acme', 'widgets', 5, 'reviewbot[bot]', TIMEOUT)).toBe(true);
  });

  it('returns true when the bot left an issue comment but no review', async () => {
    route({
      '/repos/acme/widgets/pulls/5/reviews': [{ user: { login: 'someone-else' } }],
      '/repos/acme/widgets/issues/5/comments': [{ user: { login: 'reviewbot[bot]' } }],
    });
    expect(await botHasTouchedPull(TOKEN, API, 'acme', 'widgets', 5, 'reviewbot[bot]', TIMEOUT)).toBe(true);
  });

  it('returns false when only other users have touched the PR', async () => {
    route({
      '/repos/acme/widgets/pulls/5/reviews': [{ user: { login: 'human' } }],
      '/repos/acme/widgets/issues/5/comments': [{ user: { login: 'other-bot[bot]' } }],
      '/repos/acme/widgets/pulls/5/comments': [],
    });
    expect(await botHasTouchedPull(TOKEN, API, 'acme', 'widgets', 5, 'reviewbot[bot]', TIMEOUT)).toBe(false);
  });

  it('returns null when an endpoint errors (so the caller skips rather than mis-dispatches)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: false, status: 500, text: async () => 'boom', json: async () => ({}) }) as unknown as Response),
    );
    expect(await botHasTouchedPull(TOKEN, API, 'acme', 'widgets', 5, 'reviewbot[bot]', TIMEOUT)).toBeNull();
  });
});
