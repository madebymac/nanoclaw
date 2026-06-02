/**
 * Dispatch-tracking for the PR-review cron (central DB, table
 * `pr_review_dispatch` — migration 017). Records which (repo, PR) pairs have
 * already been handed to the reviewer agent so the job doesn't re-instruct a
 * PR every tick while the agent's review is still in flight. See the migration
 * for the full rationale.
 */
import { getDb } from '../../db/connection.js';

export interface PrReviewDispatch {
  repo: string;
  pr_number: number;
  head_sha: string | null;
  dispatched_at: string;
}

export function getDispatch(repo: string, prNumber: number): PrReviewDispatch | undefined {
  return getDb()
    .prepare('SELECT repo, pr_number, head_sha, dispatched_at FROM pr_review_dispatch WHERE repo = ? AND pr_number = ?')
    .get(repo, prNumber) as PrReviewDispatch | undefined;
}

export function recordDispatch(repo: string, prNumber: number, headSha: string | null, dispatchedAt: string): void {
  getDb()
    .prepare(
      `INSERT INTO pr_review_dispatch (repo, pr_number, head_sha, dispatched_at)
       VALUES (@repo, @pr_number, @head_sha, @dispatched_at)
       ON CONFLICT(repo, pr_number)
       DO UPDATE SET head_sha = excluded.head_sha, dispatched_at = excluded.dispatched_at`,
    )
    .run({ repo, pr_number: prNumber, head_sha: headSha, dispatched_at: dispatchedAt });
}
