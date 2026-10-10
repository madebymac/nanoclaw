/**
 * Pure decision logic for the PR-review cron — no network, no DB, fully
 * unit-testable. Given what we learned about a PR (already reviewed by the
 * bot? draft?) and its dispatch history, decide whether to instruct the agent
 * to review it now.
 */
import type { PrReviewDispatch } from './db.js';

export interface DispatchDecisionInput {
  /** PR is a draft — never auto-review drafts. */
  isDraft: boolean;
  /** The bot has already left a review/comment on this PR. */
  alreadyTouched: boolean;
  /** Current head SHA of the PR (null if unknown). */
  headSha: string | null;
  /** Existing dispatch record for this (repo, PR), if any. */
  dispatch: PrReviewDispatch | undefined;
  /** `Date.now()` at decision time. */
  nowMs: number;
  /** Re-dispatch cooldown in ms. */
  cooldownMs: number;
}

/**
 * Dispatch a review when the PR is open, non-draft, not yet touched by the
 * bot, and either never dispatched, dispatched against an older head SHA
 * (new commits pushed), or last dispatched longer ago than the cooldown
 * (previous run never produced a review — let it retry).
 */
export function shouldDispatch(input: DispatchDecisionInput): boolean {
  if (input.isDraft) return false;
  if (input.alreadyTouched) return false;
  if (!input.dispatch) return true;
  if (input.dispatch.head_sha !== input.headSha) return true;
  const last = Date.parse(input.dispatch.dispatched_at);
  if (Number.isNaN(last)) return true;
  return input.nowMs - last >= input.cooldownMs;
}

export interface PullAuthorship {
  /** `user.login` of the PR author. */
  login: string;
  /** `user.type` from the GitHub API — 'Bot' for GitHub App / bot accounts. */
  userType: string | null;
  /** PR description, or null if empty. */
  body: string | null;
}

// Footers that agent tooling stamps into the PR description. Claude Code
// opens PRs under the human's own account, so the author login alone can't
// tell us an agent wrote it — the footer can.
const AGENT_BODY_MARKERS = [/Generated with \[Claude Code\]/i, /claude\.ai\/code\/session_/i];

/**
 * Was this PR raised by a bot / coding agent rather than a person at a
 * keyboard? Such an author has no physical device, so the reviewer must not
 * ask it for on-device screenshots or manual testing evidence.
 */
export function isBotAuthored(pr: PullAuthorship): boolean {
  if (pr.userType === 'Bot') return true;
  if (pr.login.endsWith('[bot]')) return true;
  return pr.body !== null && AGENT_BODY_MARKERS.some((re) => re.test(pr.body!));
}
