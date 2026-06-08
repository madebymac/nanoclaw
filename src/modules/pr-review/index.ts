/**
 * PR-review tick — a one-shot scan for open PRs the review bot hasn't
 * reviewed yet, dispatching a review task to the reviewer agent for each.
 *
 * Design intent:
 *   - The "does this PR need review?" decision is made PROGRAMMATICALLY against
 *     the GitHub REST API (list repos → list open PRs → check for the bot's
 *     own reviews/comments). No AI tokens are spent deciding.
 *   - The agent is woken ONLY when a PR actually needs review; it then performs
 *     the review (inline comments / approval) with its own GitHub access.
 *
 * Scheduling lives outside the host process: a system cron (or launchd /
 * systemd timer) invokes `ncl pr-review run` on whatever cadence the
 * operator chose. That command calls runPrReviewTick() inside the host so
 * session-DB writes still come from the single host writer. Opt-in via
 * PR_REVIEW_ENABLED.
 */
import {
  PR_REVIEW_AGENT_GROUP_ID,
  PR_REVIEW_COOLDOWN_MS,
  PR_REVIEW_ENABLED,
  PR_REVIEW_STATUS_MESSAGING_GROUP_ID,
} from '../../config.js';
import { getGithubAppForAgentGroup } from '../../db/github-apps.js';
import { fetchAppLogin, mintInstallationToken, type GithubAppCredentials } from '../../github-app-broker.js';
import { log } from '../../log.js';
import { getDispatch, recordDispatch } from './db.js';
import { dispatchReview } from './dispatch.js';
import { botHasTouchedPull, listInstallationRepos, listOpenPulls } from './github.js';
import { shouldDispatch } from './scan.js';

const FETCH_TIMEOUT_MS = 10_000;

// The bot login (`<app-slug>[bot]`), resolved once via fetchAppLogin and cached
// for the process lifetime. Stays null after a transient failure (bad JWT,
// network blip), so the next tick retries — intentional: the login is required
// to recognise the bot's own reviews, and one extra GET /app per tick until
// GitHub recovers is far cheaper than a sentinel that would disable reviewing
// until a host restart.
let appLoginCache: string | null = null;

// Guard against a cron entry firing faster than a tick can complete (e.g. the
// operator set `* * * * *` but a tick scanning many repos takes 90s). Without
// it, two concurrent ticks would race on the dispatch table. Concurrent
// invocations skip with a clear status; the caller (cron / ncl) sees it.
let inFlight = false;

export interface TickResult {
  status: 'ran' | 'disabled' | 'misconfigured' | 'busy';
  dispatched?: number;
  reason?: string;
}

/**
 * Run one PR-review scan inside the host process. Invoked by
 * `ncl pr-review run` (typically from cron). Returns a summary the caller
 * can render or log.
 */
export async function runPrReviewTick(): Promise<TickResult> {
  if (!PR_REVIEW_ENABLED) {
    return { status: 'disabled', reason: 'PR_REVIEW_ENABLED is not set' };
  }
  if (!PR_REVIEW_AGENT_GROUP_ID) {
    return { status: 'misconfigured', reason: 'PR_REVIEW_AGENT_GROUP_ID is not set' };
  }
  if (inFlight) {
    return { status: 'busy', reason: 'previous tick still running' };
  }

  inFlight = true;
  try {
    const dispatched = await scanAndDispatch(PR_REVIEW_AGENT_GROUP_ID);
    return { status: 'ran', dispatched };
  } finally {
    inFlight = false;
  }
}

async function scanAndDispatch(agentGroupId: string): Promise<number> {
  const identity = getGithubAppForAgentGroup(agentGroupId);
  if (!identity) {
    log.warn('PR-review: reviewer agent group has no GitHub App identity — skipping', { agentGroupId });
    return 0;
  }
  const creds: GithubAppCredentials = {
    appId: identity.app_id,
    installationId: identity.installation_id,
    privateKeyPath: identity.private_key_path,
    apiUrl: identity.api_url,
  };
  const apiUrl = identity.api_url || 'https://api.github.com';

  const token = await mintInstallationToken(creds, FETCH_TIMEOUT_MS);
  if (!token) return 0; // mintInstallationToken logs the reason

  if (!appLoginCache) appLoginCache = await fetchAppLogin(creds, FETCH_TIMEOUT_MS);
  const botLogin = appLoginCache;
  if (!botLogin) {
    log.warn('PR-review: could not resolve the bot login — skipping tick');
    return 0;
  }

  const repos = await listInstallationRepos(token, apiUrl, FETCH_TIMEOUT_MS);
  if (!repos) return 0;

  const now = Date.now();
  let dispatched = 0;
  for (const r of repos) {
    const pulls = await listOpenPulls(token, apiUrl, r.owner, r.repo, FETCH_TIMEOUT_MS);
    if (!pulls) continue;

    for (const pr of pulls) {
      if (pr.draft) continue;

      const dispatch = getDispatch(r.fullName, pr.number);
      // Cheap short-circuit: a PR dispatched recently against the same head is
      // still being worked on — skip the per-PR review/comment API calls.
      if (
        dispatch &&
        dispatch.head_sha === pr.headSha &&
        now - Date.parse(dispatch.dispatched_at) < PR_REVIEW_COOLDOWN_MS
      ) {
        continue;
      }

      const touched = await botHasTouchedPull(token, apiUrl, r.owner, r.repo, pr.number, botLogin, FETCH_TIMEOUT_MS);
      if (touched === null) continue; // couldn't determine — don't risk a false dispatch

      if (
        !shouldDispatch({
          isDraft: pr.draft,
          alreadyTouched: touched,
          headSha: pr.headSha,
          dispatch,
          nowMs: now,
          cooldownMs: PR_REVIEW_COOLDOWN_MS,
        })
      ) {
        continue;
      }

      try {
        await dispatchReview(
          agentGroupId,
          {
            fullName: r.fullName,
            number: pr.number,
            title: pr.title,
            author: pr.author,
            htmlUrl: pr.htmlUrl,
          },
          PR_REVIEW_STATUS_MESSAGING_GROUP_ID,
        );
        recordDispatch(r.fullName, pr.number, pr.headSha, new Date().toISOString());
        dispatched++;
      } catch (err) {
        log.error('PR-review: failed to dispatch review', { repo: r.fullName, pr: pr.number, err });
      }
    }
  }
  if (dispatched > 0) log.info('PR-review: tick dispatched reviews', { dispatched });
  return dispatched;
}
