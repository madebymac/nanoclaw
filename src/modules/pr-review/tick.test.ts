/**
 * Smoke tests for runPrReviewTick's opt-in gates. The full
 * scan-and-dispatch path is covered by github.test.ts + scan.test.ts +
 * dispatch.test.ts; here we just verify the short-circuits the cron
 * caller relies on (disabled / misconfigured) return a recognisable
 * status without hitting GitHub.
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../config.js', async () => {
  const actual = await vi.importActual<typeof import('../../config.js')>('../../config.js');
  return {
    ...actual,
    PR_REVIEW_ENABLED: false,
    PR_REVIEW_AGENT_GROUP_ID: null,
  };
});

import { runPrReviewTick } from './index.js';

describe('runPrReviewTick gates', () => {
  it('returns disabled when PR_REVIEW_ENABLED is false', async () => {
    const result = await runPrReviewTick();
    expect(result.status).toBe('disabled');
    expect(result.reason).toMatch(/PR_REVIEW_ENABLED/);
  });
});
