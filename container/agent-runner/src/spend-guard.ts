/**
 * Spend guard — a rolling-window cost ceiling for one session.
 *
 * Two independent layers, because they fail differently:
 *
 *   1. **Per-turn** (`NANOCLAW_MAX_TURN_USD`) — handed to the Claude SDK as
 *      `maxBudgetUsd`, so a single runaway turn stops itself mid-flight and
 *      returns an `error_max_budget_usd` result instead of grinding on.
 *
 *   2. **Rolling window** (`NANOCLAW_SPEND_LIMIT_USD` over
 *      `NANOCLAW_SPEND_WINDOW_HOURS`) — enforced here. Every completed query
 *      reports `total_cost_usd`; we accumulate it and refuse to open a new
 *      query once the window total is spent. This is the layer that catches
 *      the slow bleed: many individually-reasonable turns, forever, with
 *      nobody watching.
 *
 * The ledger lives in `session_state` (outbound.db), so it survives container
 * restarts — a guard you can reset by bouncing the container is not a guard.
 *
 * SCOPE: per session. Each session keeps its own window, so N active sessions
 * can each spend up to the limit. Enforcing a true install-wide ceiling needs
 * host-side aggregation across session DBs; this deliberately stays inside
 * the container where the cost is actually observed.
 *
 * Both limits default to generous-but-finite values and are disabled by
 * setting them to 0. When the window limit trips, the agent stops calling the
 * model and the user is told which knob to turn — a visible stop, never a
 * silent one.
 */
import { getStateValue, setStateValue } from './db/session-state.js';

const SPEND_STATE_KEY = 'spend_window';

/** Default ceiling for a single turn, in USD. 0 disables. */
const DEFAULT_MAX_TURN_USD = 5;
/** Default ceiling for the rolling window, in USD. 0 disables. */
const DEFAULT_SPEND_LIMIT_USD = 50;
/** Default rolling-window length, in hours. */
const DEFAULT_SPEND_WINDOW_HOURS = 24;

function log(msg: string): void {
  console.error(`[spend-guard] ${msg}`);
}

/**
 * Parse a non-negative number from the environment. Falls back to `fallback`
 * for unset/garbage values; a valid 0 means "disabled" and is preserved.
 */
function envNumber(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) {
    log(`Ignoring invalid ${name}=${raw} — using ${fallback}`);
    return fallback;
  }
  return parsed;
}

export interface SpendLimits {
  /** Per-query ceiling in USD. 0 = unlimited. */
  turnLimitUsd: number;
  /** Rolling-window ceiling in USD. 0 = unlimited. */
  windowLimitUsd: number;
  /** Rolling-window length in ms. */
  windowMs: number;
}

export function getSpendLimits(): SpendLimits {
  return {
    turnLimitUsd: envNumber('NANOCLAW_MAX_TURN_USD', DEFAULT_MAX_TURN_USD),
    windowLimitUsd: envNumber('NANOCLAW_SPEND_LIMIT_USD', DEFAULT_SPEND_LIMIT_USD),
    windowMs: envNumber('NANOCLAW_SPEND_WINDOW_HOURS', DEFAULT_SPEND_WINDOW_HOURS) * 60 * 60 * 1000,
  };
}

interface SpendWindow {
  /** Epoch ms at which the current window opened. */
  startedAt: number;
  /** USD accumulated since `startedAt`. */
  spentUsd: number;
}

function readWindow(): SpendWindow | null {
  const raw = getStateValue(SPEND_STATE_KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<SpendWindow>;
    if (typeof parsed.startedAt !== 'number' || typeof parsed.spentUsd !== 'number') return null;
    if (!Number.isFinite(parsed.startedAt) || !Number.isFinite(parsed.spentUsd)) return null;
    return { startedAt: parsed.startedAt, spentUsd: parsed.spentUsd };
  } catch {
    return null;
  }
}

function writeWindow(w: SpendWindow): void {
  setStateValue(SPEND_STATE_KEY, JSON.stringify(w));
}

/**
 * Return the live window, rolling it over if the previous one has aged out.
 * A missing/corrupt row starts a fresh window rather than failing closed —
 * a broken ledger must not wedge the agent permanently.
 */
function currentWindow(now: number, windowMs: number): SpendWindow {
  const existing = readWindow();
  if (!existing) return { startedAt: now, spentUsd: 0 };
  if (windowMs > 0 && now - existing.startedAt >= windowMs) {
    return { startedAt: now, spentUsd: 0 };
  }
  return existing;
}

export interface SpendStatus {
  /** True when the window ceiling is spent and no new query should start. */
  blocked: boolean;
  spentUsd: number;
  limitUsd: number;
  /** Epoch ms when the current window rolls over. 0 when no limit applies. */
  resetsAt: number;
}

/**
 * Record the cost of a completed query against the rolling window.
 * Non-finite or non-positive costs are ignored (providers that don't report
 * cost simply never move the ledger).
 */
export function recordSpend(costUsd: number, now: number = Date.now()): void {
  if (!Number.isFinite(costUsd) || costUsd <= 0) return;
  const { windowMs } = getSpendLimits();
  const w = currentWindow(now, windowMs);
  const updated = { startedAt: w.startedAt, spentUsd: w.spentUsd + costUsd };
  writeWindow(updated);
  log(`Recorded $${costUsd.toFixed(4)} — window total $${updated.spentUsd.toFixed(4)}`);
}

/**
 * Check whether a new query may start. Call before opening a provider query;
 * `blocked` means the session has spent its window allowance.
 */
export function checkSpend(now: number = Date.now()): SpendStatus {
  const { windowLimitUsd, windowMs } = getSpendLimits();
  const w = currentWindow(now, windowMs);
  if (windowLimitUsd <= 0) {
    return { blocked: false, spentUsd: w.spentUsd, limitUsd: 0, resetsAt: 0 };
  }
  return {
    blocked: w.spentUsd >= windowLimitUsd,
    spentUsd: w.spentUsd,
    limitUsd: windowLimitUsd,
    resetsAt: w.startedAt + windowMs,
  };
}

/** Human-facing explanation of a block, including how to lift it. */
export function formatSpendBlockMessage(status: SpendStatus): string {
  const resets = status.resetsAt ? new Date(status.resetsAt).toISOString() : 'unknown';
  return (
    `⚠️ Spend guard tripped: this session has used $${status.spentUsd.toFixed(2)} of its ` +
    `$${status.limitUsd.toFixed(2)} budget, so I've stopped calling the model. ` +
    `The budget resets at ${resets}. To raise or disable it, set NANOCLAW_SPEND_LIMIT_USD ` +
    `(0 disables) and restart the container.`
  );
}

/** Test helper — clears the ledger. */
export function resetSpendWindow(): void {
  setStateValue(SPEND_STATE_KEY, JSON.stringify({ startedAt: Date.now(), spentUsd: 0 }));
}
