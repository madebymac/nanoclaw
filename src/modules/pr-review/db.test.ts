import { describe, expect, it, beforeEach, afterEach } from 'vitest';

import { getDispatch, recordDispatch } from './db.js';
import { closeDb, initTestDb, runMigrations } from '../../db/index.js';

describe('pr_review_dispatch', () => {
  beforeEach(() => {
    const db = initTestDb();
    runMigrations(db);
  });
  afterEach(() => {
    closeDb();
  });

  it('returns undefined when no row exists', () => {
    expect(getDispatch('o/r', 1)).toBeUndefined();
  });

  it('records and reads back a dispatch', () => {
    recordDispatch('o/r', 7, 'sha-abc', '2026-06-02T12:00:00.000Z');
    const row = getDispatch('o/r', 7);
    expect(row).toEqual({ repo: 'o/r', pr_number: 7, head_sha: 'sha-abc', dispatched_at: '2026-06-02T12:00:00.000Z' });
  });

  it('upserts on (repo, pr_number) — second dispatch overwrites sha + timestamp', () => {
    recordDispatch('o/r', 7, 'sha-abc', '2026-06-02T12:00:00.000Z');
    recordDispatch('o/r', 7, 'sha-def', '2026-06-02T13:00:00.000Z');
    const row = getDispatch('o/r', 7);
    expect(row?.head_sha).toBe('sha-def');
    expect(row?.dispatched_at).toBe('2026-06-02T13:00:00.000Z');
  });

  it('keys separately per repo and per PR number', () => {
    recordDispatch('o/r', 1, 'a', '2026-06-02T12:00:00.000Z');
    recordDispatch('o/r', 2, 'b', '2026-06-02T12:00:00.000Z');
    recordDispatch('o/other', 1, 'c', '2026-06-02T12:00:00.000Z');
    expect(getDispatch('o/r', 1)?.head_sha).toBe('a');
    expect(getDispatch('o/r', 2)?.head_sha).toBe('b');
    expect(getDispatch('o/other', 1)?.head_sha).toBe('c');
  });

  it('accepts a null head SHA', () => {
    recordDispatch('o/r', 9, null, '2026-06-02T12:00:00.000Z');
    expect(getDispatch('o/r', 9)?.head_sha).toBeNull();
  });
});
