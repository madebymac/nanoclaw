import { describe, expect, it } from 'vitest';

import type { PrReviewDispatch } from './db.js';
import { shouldDispatch } from './scan.js';

const NOW = Date.parse('2026-06-02T12:00:00.000Z');
const COOLDOWN = 30 * 60_000; // 30 min

function dispatch(over: Partial<PrReviewDispatch> = {}): PrReviewDispatch {
  return { repo: 'o/r', pr_number: 1, head_sha: 'sha-1', dispatched_at: '2026-06-02T11:59:00.000Z', ...over };
}

describe('shouldDispatch', () => {
  it('dispatches a fresh, non-draft, un-touched PR with no history', () => {
    expect(
      shouldDispatch({
        isDraft: false,
        alreadyTouched: false,
        headSha: 'sha-1',
        dispatch: undefined,
        nowMs: NOW,
        cooldownMs: COOLDOWN,
      }),
    ).toBe(true);
  });

  it('never dispatches drafts', () => {
    expect(
      shouldDispatch({
        isDraft: true,
        alreadyTouched: false,
        headSha: 'sha-1',
        dispatch: undefined,
        nowMs: NOW,
        cooldownMs: COOLDOWN,
      }),
    ).toBe(false);
  });

  it('never dispatches a PR the bot has already touched', () => {
    expect(
      shouldDispatch({
        isDraft: false,
        alreadyTouched: true,
        headSha: 'sha-1',
        dispatch: undefined,
        nowMs: NOW,
        cooldownMs: COOLDOWN,
      }),
    ).toBe(false);
  });

  it('does not re-dispatch within the cooldown for the same head', () => {
    expect(
      shouldDispatch({
        isDraft: false,
        alreadyTouched: false,
        headSha: 'sha-1',
        dispatch: dispatch({ dispatched_at: '2026-06-02T11:59:00.000Z' }), // 1 min ago
        nowMs: NOW,
        cooldownMs: COOLDOWN,
      }),
    ).toBe(false);
  });

  it('re-dispatches after the cooldown elapses (agent never produced a review)', () => {
    expect(
      shouldDispatch({
        isDraft: false,
        alreadyTouched: false,
        headSha: 'sha-1',
        dispatch: dispatch({ dispatched_at: '2026-06-02T11:00:00.000Z' }), // 60 min ago
        nowMs: NOW,
        cooldownMs: COOLDOWN,
      }),
    ).toBe(true);
  });

  it('re-dispatches immediately when new commits change the head SHA', () => {
    expect(
      shouldDispatch({
        isDraft: false,
        alreadyTouched: false,
        headSha: 'sha-2',
        dispatch: dispatch({ head_sha: 'sha-1', dispatched_at: '2026-06-02T11:59:00.000Z' }),
        nowMs: NOW,
        cooldownMs: COOLDOWN,
      }),
    ).toBe(true);
  });

  it('treats an unparseable dispatched_at as stale and re-dispatches', () => {
    expect(
      shouldDispatch({
        isDraft: false,
        alreadyTouched: false,
        headSha: 'sha-1',
        dispatch: dispatch({ dispatched_at: 'not-a-date' }),
        nowMs: NOW,
        cooldownMs: COOLDOWN,
      }),
    ).toBe(true);
  });
});
