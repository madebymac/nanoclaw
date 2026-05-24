/**
 * Self-upgrade — periodic poll for upstream commits, then `make deploy`.
 *
 * Why this lives on the host, not in an agent container:
 *   `make deploy` ends with `systemctl --user restart <unit>`, which kills
 *   the running host. A container can't restart its own host. The host can —
 *   provided the deploy itself escapes the host's cgroup before the restart
 *   fires. We use `systemd-run --user --no-block` to start the deploy in a
 *   fresh transient unit; that unit survives the parent's SIGTERM and runs
 *   to completion.
 *
 * Skips that protect against unwanted upgrades:
 *   - dirty working tree (someone is hacking locally)
 *   - HEAD not strictly behind upstream (fork with local commits, detached
 *     HEAD, diverged history)
 *   - no upstream tracking branch
 *
 * Linux-only — the Makefile's deploy target uses `systemctl --user restart`.
 */
import { spawn } from 'child_process';

import { SELF_UPGRADE_INTERVAL_MS, SELF_UPGRADE_REMOTE } from './config.js';
import { getSystemdUnit } from './install-slug.js';
import { log } from './log.js';

export type UpgradeDecision =
  | { action: 'skip'; reason: 'up-to-date' | 'working-tree-dirty' | 'not-fast-forward' }
  | { action: 'upgrade'; from: string; to: string };

/**
 * Pure decision: given the current git state, should we trigger a deploy?
 * Side-effecting git reads happen in the caller.
 */
export function decideUpgrade(args: {
  localHead: string;
  upstreamHead: string;
  isFastForward: boolean;
  workingTreeDirty: boolean;
}): UpgradeDecision {
  if (args.workingTreeDirty) return { action: 'skip', reason: 'working-tree-dirty' };
  if (args.localHead === args.upstreamHead) return { action: 'skip', reason: 'up-to-date' };
  if (!args.isFastForward) return { action: 'skip', reason: 'not-fast-forward' };
  return { action: 'upgrade', from: args.localHead, to: args.upstreamHead };
}

// Fetch can stall on slow networks. Bound it well below the poll interval so
// a hung remote can't pile up overlapping ticks. Capped to keep a sane upper
// bound even when the interval is set very large.
const FETCH_TIMEOUT_MS = Math.min(60_000, Math.max(10_000, Math.floor(SELF_UPGRADE_INTERVAL_MS / 2)));
const QUICK_GIT_TIMEOUT_MS = 10_000;
const SYSTEMD_RUN_TIMEOUT_MS = 10_000;

let timer: NodeJS.Timeout | null = null;
let inFlight = false;

export function startSelfUpgrade(projectRoot: string = process.cwd()): void {
  if (process.platform !== 'linux') {
    log.warn('Self-upgrade only supported on Linux (uses systemd-run) — not starting', {
      platform: process.platform,
    });
    return;
  }
  if (timer) return;
  log.info('Self-upgrade enabled', {
    intervalMs: SELF_UPGRADE_INTERVAL_MS,
    remote: SELF_UPGRADE_REMOTE,
    fetchTimeoutMs: FETCH_TIMEOUT_MS,
  });
  timer = setInterval(() => {
    if (inFlight) {
      log.debug('Self-upgrade: previous tick still running — skipping');
      return;
    }
    inFlight = true;
    tick(projectRoot)
      .catch((err) => log.error('Self-upgrade tick threw', { err }))
      .finally(() => {
        inFlight = false;
      });
  }, SELF_UPGRADE_INTERVAL_MS);
}

// NOTE: shutdown is currently synchronous-safe — clearInterval prevents new
// ticks, and any in-flight tick will finish on its own (it only logs and shells
// out via systemd-run, never holds a DB handle or socket). If the tick ever
// grows side effects that must complete before process exit, switch this to
// async and await the in-flight promise here.
export function stopSelfUpgrade(): void {
  if (timer) clearInterval(timer);
  timer = null;
}

async function tick(projectRoot: string): Promise<void> {
  const fetched = await run('git', ['fetch', '--quiet', SELF_UPGRADE_REMOTE], {
    cwd: projectRoot,
    timeoutMs: FETCH_TIMEOUT_MS,
  });
  if (fetched.code !== 0) {
    log.warn('Self-upgrade: git fetch failed', {
      remote: SELF_UPGRADE_REMOTE,
      timedOut: fetched.timedOut,
      stderr: fetched.stderr.trim(),
    });
    return;
  }

  const upstream = await gitText(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'], projectRoot);
  if (upstream === null) {
    log.warn('Self-upgrade: current branch has no upstream tracking branch — skipping');
    return;
  }
  const localHead = await gitText(['rev-parse', 'HEAD'], projectRoot);
  const upstreamHead = await gitText(['rev-parse', '@{u}'], projectRoot);
  if (localHead === null || upstreamHead === null) {
    log.warn('Self-upgrade: could not resolve HEAD or upstream rev');
    return;
  }
  const ff = await run('git', ['merge-base', '--is-ancestor', 'HEAD', '@{u}'], {
    cwd: projectRoot,
    timeoutMs: QUICK_GIT_TIMEOUT_MS,
  });
  const isFastForward = ff.code === 0;

  // Fail-safe: if `git status` itself fails (lock file, broken index, ENOENT
  // on the git binary, timeout), treat the tree as dirty so we DON'T fire a
  // deploy against an unknown working state.
  const status = await run('git', ['status', '--porcelain'], {
    cwd: projectRoot,
    timeoutMs: QUICK_GIT_TIMEOUT_MS,
  });
  if (status.code !== 0) {
    log.warn('Self-upgrade: git status failed — treating as dirty and skipping', {
      timedOut: status.timedOut,
      stderr: status.stderr.trim(),
    });
    return;
  }
  const workingTreeDirty = status.stdout.trim().length > 0;

  const decision = decideUpgrade({ localHead, upstreamHead, isFastForward, workingTreeDirty });
  if (decision.action === 'skip') {
    log.debug('Self-upgrade: skipping', {
      reason: decision.reason,
      localHead,
      upstreamHead,
      upstream,
    });
    return;
  }

  log.info('Self-upgrade: upstream advanced — triggering make deploy', {
    from: decision.from,
    to: decision.to,
    upstream,
  });
  await triggerDeploy(projectRoot);
}

async function gitText(args: string[], cwd: string): Promise<string | null> {
  const r = await run('git', args, { cwd, timeoutMs: QUICK_GIT_TIMEOUT_MS });
  if (r.code !== 0) return null;
  return r.stdout.trim();
}

async function triggerDeploy(projectRoot: string): Promise<void> {
  const instance = (process.env.NCL_INSTANCE || '').trim();
  // Per-instance unit so two instances upgrading concurrently don't
  // collide on the systemd-run lock. getSystemdUnit() picks up
  // NCL_INSTANCE automatically.
  const unit = `${getSystemdUnit(projectRoot)}-upgrade`;
  // When running as an instance, drive the matching Makefile target so the
  // final `systemctl --user restart` hits the right unit. Default `make
  // deploy` restarts the single-install unit only.
  const deployCmd = instance ? `make deploy-${instance}` : 'make deploy';

  // A previous deploy that exited non-zero leaves a stale unit in `failed`
  // state under the same name, which would block subsequent `systemd-run
  // --unit=...` invocations with "Unit ... already exists". Best-effort clear
  // it first — the call is harmless and idempotent when no failed unit
  // exists; we ignore its exit status.
  await run('systemctl', ['--user', 'reset-failed', `${unit}.service`], {
    timeoutMs: QUICK_GIT_TIMEOUT_MS,
  });

  // Fixed unit name (per-install) doubles as a lock for in-flight runs —
  // if a previous deploy is still active, systemd-run refuses with
  // "Unit already exists" and we log the conflict.
  const r = await run(
    'systemd-run',
    [
      '--user',
      '--no-block',
      `--unit=${unit}`,
      '--description=NanoClaw self-upgrade',
      `--working-directory=${projectRoot}`,
      '/bin/bash',
      '-lc',
      deployCmd,
    ],
    { timeoutMs: SYSTEMD_RUN_TIMEOUT_MS },
  );
  if (r.code === 0) {
    log.info('Self-upgrade: deploy unit started', { unit });
    return;
  }
  log.error('Self-upgrade: failed to start deploy unit', {
    unit,
    timedOut: r.timedOut,
    stderr: r.stderr.trim(),
    stdout: r.stdout.trim(),
  });
}

type RunResult = { code: number | null; stdout: string; stderr: string; timedOut: boolean };

function run(cmd: string, args: string[], opts: { cwd?: string; timeoutMs?: number } = {}): Promise<RunResult> {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const child = spawn(cmd, args, { cwd: opts.cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    const timer =
      opts.timeoutMs && opts.timeoutMs > 0
        ? setTimeout(() => {
            timedOut = true;
            child.kill('SIGTERM');
            // Escalate if the child ignores SIGTERM (e.g. wedged libcurl).
            setTimeout(() => {
              if (!child.killed) child.kill('SIGKILL');
            }, 2_000);
          }, opts.timeoutMs)
        : null;
    child.stdout?.on('data', (d) => {
      stdout += d.toString();
    });
    child.stderr?.on('data', (d) => {
      stderr += d.toString();
    });
    child.once('error', (err) => {
      if (timer) clearTimeout(timer);
      resolve({ code: null, stdout, stderr: stderr + String(err), timedOut });
    });
    child.once('close', (code) => {
      if (timer) clearTimeout(timer);
      resolve({ code, stdout, stderr, timedOut });
    });
  });
}
