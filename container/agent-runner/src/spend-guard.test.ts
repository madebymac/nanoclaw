import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import { closeSessionDb, initTestSessionDb } from './db/connection.js';
import { checkSpend, formatSpendBlockMessage, getSpendLimits, recordSpend } from './spend-guard.js';

const ENV_KEYS = ['NANOCLAW_MAX_TURN_USD', 'NANOCLAW_SPEND_LIMIT_USD', 'NANOCLAW_SPEND_WINDOW_HOURS'] as const;
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  initTestSessionDb();
  for (const k of ENV_KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  closeSessionDb();
});

describe('getSpendLimits', () => {
  it('defaults to a finite per-turn and per-window ceiling', () => {
    const limits = getSpendLimits();
    expect(limits.turnLimitUsd).toBe(5);
    expect(limits.windowLimitUsd).toBe(50);
    expect(limits.windowMs).toBe(24 * 60 * 60 * 1000);
  });

  it('honours env overrides, including 0 to disable', () => {
    process.env.NANOCLAW_MAX_TURN_USD = '0';
    process.env.NANOCLAW_SPEND_LIMIT_USD = '12.5';
    process.env.NANOCLAW_SPEND_WINDOW_HOURS = '1';
    const limits = getSpendLimits();
    expect(limits.turnLimitUsd).toBe(0);
    expect(limits.windowLimitUsd).toBe(12.5);
    expect(limits.windowMs).toBe(60 * 60 * 1000);
  });

  it('falls back to defaults on garbage values', () => {
    process.env.NANOCLAW_SPEND_LIMIT_USD = 'not-a-number';
    expect(getSpendLimits().windowLimitUsd).toBe(50);
    process.env.NANOCLAW_SPEND_LIMIT_USD = '-3';
    expect(getSpendLimits().windowLimitUsd).toBe(50);
  });
});

describe('spend window', () => {
  it('starts unblocked with nothing spent', () => {
    const status = checkSpend();
    expect(status.blocked).toBe(false);
    expect(status.spentUsd).toBe(0);
  });

  it('accumulates cost across calls', () => {
    const now = 1_000_000;
    recordSpend(1.5, now);
    recordSpend(2.25, now + 1000);
    expect(checkSpend(now + 2000).spentUsd).toBeCloseTo(3.75, 5);
  });

  it('blocks once the window limit is reached', () => {
    process.env.NANOCLAW_SPEND_LIMIT_USD = '10';
    const now = 1_000_000;
    recordSpend(9.99, now);
    expect(checkSpend(now).blocked).toBe(false);
    recordSpend(0.02, now);
    expect(checkSpend(now).blocked).toBe(true);
  });

  it('rolls over once the window elapses', () => {
    process.env.NANOCLAW_SPEND_LIMIT_USD = '10';
    process.env.NANOCLAW_SPEND_WINDOW_HOURS = '1';
    const now = 1_000_000;
    recordSpend(20, now);
    expect(checkSpend(now).blocked).toBe(true);

    const later = now + 60 * 60 * 1000 + 1;
    const rolled = checkSpend(later);
    expect(rolled.blocked).toBe(false);
    expect(rolled.spentUsd).toBe(0);
  });

  it('never blocks when the limit is disabled', () => {
    process.env.NANOCLAW_SPEND_LIMIT_USD = '0';
    recordSpend(10_000);
    const status = checkSpend();
    expect(status.blocked).toBe(false);
    expect(status.limitUsd).toBe(0);
  });

  it('ignores non-positive and non-finite costs', () => {
    const now = 1_000_000;
    recordSpend(0, now);
    recordSpend(-5, now);
    recordSpend(Number.NaN, now);
    recordSpend(Number.POSITIVE_INFINITY, now);
    expect(checkSpend(now).spentUsd).toBe(0);
  });

  it('survives a corrupt ledger row by starting a fresh window', () => {
    const { setStateValue } = require('./db/session-state.js');
    setStateValue('spend_window', '{{{not json');
    const status = checkSpend();
    expect(status.blocked).toBe(false);
    expect(status.spentUsd).toBe(0);
  });

  it('explains the block and how to lift it', () => {
    process.env.NANOCLAW_SPEND_LIMIT_USD = '10';
    const now = 1_000_000;
    recordSpend(11, now);
    const msg = formatSpendBlockMessage(checkSpend(now));
    expect(msg).toContain('$11.00');
    expect(msg).toContain('$10.00');
    expect(msg).toContain('NANOCLAW_SPEND_LIMIT_USD');
  });
});
