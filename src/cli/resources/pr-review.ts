/**
 * `ncl pr-review run` — invoke a single PR-review tick inside the host
 * process. Designed to be called from a system cron (or launchd / systemd
 * timer); the host stays the sole writer to session DBs.
 */
import { runPrReviewTick } from '../../modules/pr-review/index.js';
import { register } from '../registry.js';

register({
  name: 'pr-review-run',
  description:
    "Run one PR-review scan: list open PRs across the reviewer agent group's GitHub App installation and dispatch a review task for any the bot has not yet touched. Designed to be invoked from a system cron. Returns {status, dispatched?}.",
  access: 'open',
  parseArgs: () => ({}),
  handler: async () => runPrReviewTick(),
});
