import type Database from 'better-sqlite3';
import type { Migration } from './index.js';

/**
 * PR-review dispatch tracking.
 *
 * The periodic PR-review job (src/modules/pr-review/) scans open PRs and, for
 * any the review bot hasn't reviewed yet, injects a review instruction into
 * the reviewer agent's session. That GitHub check is the source of truth for
 * "needs review", but the bot's review takes minutes to land — so between the
 * dispatch and the review appearing on GitHub, every subsequent tick would
 * see the PR as still-un-reviewed and re-instruct it.
 *
 * This table records what's already been dispatched so the job doesn't spam
 * the agent. A row is (re)written each time a PR is dispatched; the job skips
 * a PR whose row is recent (within the cooldown) and whose head SHA is
 * unchanged. A new push (head SHA change) or an elapsed cooldown (agent never
 * delivered a review — e.g. it errored) allows a re-dispatch.
 *
 * Pure host-side bookkeeping in the central DB; no agent/LLM involvement.
 */
export const migration017: Migration = {
  version: 17,
  name: 'pr-review-dispatch',
  up(db: Database.Database) {
    db.exec(`
      CREATE TABLE pr_review_dispatch (
        repo          TEXT    NOT NULL,
        pr_number     INTEGER NOT NULL,
        head_sha      TEXT,
        dispatched_at TEXT    NOT NULL,
        PRIMARY KEY (repo, pr_number)
      );
    `);
  },
};
