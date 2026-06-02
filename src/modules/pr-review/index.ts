/**
 * PR-review cron — periodic, host-side scan for open PRs the review bot hasn't
 * reviewed yet, dispatching a review task to the reviewer agent for each.
 *
 * Design intent (per the feature request):
 *   - The "does this PR need review?" decision is made PROGRAMMATICALLY against
 *     the GitHub REST API (list repos → list open PRs → check for the bot's
 *     own reviews/comments). No AI tokens are spent deciding.
 *   - The agent is woken ONLY when a PR actually needs review; it then performs
 *     the review (inline comments / approval) with its own GitHub access.
 *
 * Runs in-process on a timer (like self-upgrade), so all session-DB writes stay
 * in the host process — no second writer. Opt-in via PR_REVIEW_ENABLED.
 *
 * Host integration: src/index.ts calls startPrReview() at boot and
 * stopPrReview() on shutdown.
 */
import {
  PR_REVIEW_AGENT_GROUP_ID,
  PR_REVIEW_COOLDOWN_MS,
  PR_REVIEW_ENABLED,
  PR_REVIEW_INTERVAL_MS,
} from '../../config.js';
import { getGithubAppForAgentGroup } from '../../db/github-apps.js';
import { fetchAppLogin, mintInstallationToken, type GithubAppCredentials } from '../../github-app-broker.js';
import { log } from '../../log.js';
import { getDispatch, recordDispatch } from './db.js';
import { dispatchReview } from './dispatch.js';
import { botHasTouchedPull, listInstallationRepos, listOpenPulls } from './github.js';
import { shouldDispatch } from './scan.js';

const FETCH_TIMEOUT_MS = 10_000;

let timer: NodeJS.Timeout | null = null;
let inFlight = false;
let appLoginCache: string | null = null;

export function startPrReview(): void {
  if (!PR_REVIEW_ENABLED) {
    log.info('PR-review cron disabled (PR_REVIEW_ENABLED not set)');
    return;
  }
  if (!PR_REVIEW_AGENT_GROUP_ID) {
    log.warn('PR-review cron enabled but PR_REVIEW_AGENT_GROUP_ID is unset — not starting');
    return;
  }
  if (timer) return;
  log.info('PR-review cron enabled', {
    agentGroupId: PR_REVIEW_AGENT_GROUP_ID,
    intervalMs: PR_REVIEW_INTERVAL_MS,
    cooldownMs: PR_REVIEW_COOLDOWN_MS,
  });
  timer = setInterval(() => {
    if (inFlight) {
      log.debug('PR-review: previous tick still running — skipping');
      return;
    }
    inFlight = true;
    tick()
      .catch((err) => log.error('PR-review tick threw', { err }))
      .finally(() => {
        inFlight = false;
      });
  }, PR_REVIEW_INTERVAL_MS);
}

export function stopPrReview(): void {
  if (timer) clearInterval(timer);
  timer = null;
}

async function tick(): Promise<void> {
  const agentGroupId = PR_REVIEW_AGENT_GROUP_ID;
  if (!agentGroupId) return;

  const identity = getGithubAppForAgentGroup(agentGroupId);
  if (!identity) {
    log.warn('PR-review: reviewer agent group has no GitHub App identity — skipping', { agentGroupId });
    return;
  }
  const creds: GithubAppCredentials = {
    appId: identity.app_id,
    installationId: identity.installation_id,
    privateKeyPath: identity.private_key_path,
    apiUrl: identity.api_url,
  };
  const apiUrl = identity.api_url || 'https://api.github.com';

  const token = await mintInstallationToken(creds, FETCH_TIMEOUT_MS);
  if (!token) return; // mintInstallationToken logs the reason

  if (!appLoginCache) appLoginCache = await fetchAppLogin(creds, FETCH_TIMEOUT_MS);
  const botLogin = appLoginCache;
  if (!botLogin) {
    log.warn('PR-review: could not resolve the bot login — skipping tick');
    return;
  }

  const repos = await listInstallationRepos(token, apiUrl, FETCH_TIMEOUT_MS);
  if (!repos) return;

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
        await dispatchReview(agentGroupId, {
          fullName: r.fullName,
          number: pr.number,
          title: pr.title,
          author: pr.author,
          htmlUrl: pr.htmlUrl,
        });
        recordDispatch(r.fullName, pr.number, pr.headSha, new Date().toISOString());
        dispatched++;
      } catch (err) {
        log.error('PR-review: failed to dispatch review', { repo: r.fullName, pr: pr.number, err });
      }
    }
  }
  if (dispatched > 0) log.info('PR-review: tick dispatched reviews', { dispatched });
}
