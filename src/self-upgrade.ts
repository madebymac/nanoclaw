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
 * Off by default. Set `NANOCLAW_SELF_UPGRADE_ENABLED=true` to enable.
 * Linux-only — the Makefile's deploy target uses `systemctl --user restart`.
 */
import { spawnSync } from 'child_process';

import { SELF_UPGRADE_ENABLED, SELF_UPGRADE_INTERVAL_MS, SELF_UPGRADE_REMOTE } from './config.js';
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

let timer: NodeJS.Timeout | null = null;

export function startSelfUpgrade(projectRoot: string = process.cwd()): void {
  if (!SELF_UPGRADE_ENABLED) {
    log.info('Self-upgrade disabled (set NANOCLAW_SELF_UPGRADE_ENABLED=true to enable)');
    return;
  }
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
  });
  timer = setInterval(() => {
    try {
      tick(projectRoot);
    } catch (err) {
      log.error('Self-upgrade tick threw', { err });
    }
  }, SELF_UPGRADE_INTERVAL_MS);
}

export function stopSelfUpgrade(): void {
  if (timer) clearInterval(timer);
  timer = null;
}

function tick(projectRoot: string): void {
  const fetched = spawnSync('git', ['fetch', '--quiet', SELF_UPGRADE_REMOTE], {
    cwd: projectRoot,
  });
  if (fetched.status !== 0) {
    log.warn('Self-upgrade: git fetch failed', {
      remote: SELF_UPGRADE_REMOTE,
      stderr: fetched.stderr?.toString().trim(),
    });
    return;
  }

  const upstream = git(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'], projectRoot);
  if (!upstream) {
    log.warn('Self-upgrade: current branch has no upstream tracking branch — skipping');
    return;
  }
  const localHead = git(['rev-parse', 'HEAD'], projectRoot);
  const upstreamHead = git(['rev-parse', '@{u}'], projectRoot);
  if (!localHead || !upstreamHead) {
    log.warn('Self-upgrade: could not resolve HEAD or upstream rev');
    return;
  }
  const ff = spawnSync('git', ['merge-base', '--is-ancestor', 'HEAD', '@{u}'], {
    cwd: projectRoot,
  });
  const isFastForward = ff.status === 0;
  const porcelain = git(['status', '--porcelain'], projectRoot);
  const workingTreeDirty = porcelain !== null && porcelain.length > 0;

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
  triggerDeploy(projectRoot);
}

function git(args: string[], cwd: string): string | null {
  const r = spawnSync('git', args, { cwd });
  if (r.status !== 0) return null;
  return r.stdout.toString().trim();
}

function triggerDeploy(projectRoot: string): void {
  // Run `make deploy` in a detached systemd user scope. Fixed unit name
  // (per-install) doubles as a lock — if a previous deploy is still running,
  // systemd-run will refuse and we log the conflict.
  const unit = `${getSystemdUnit(projectRoot)}-upgrade`;
  const r = spawnSync(
    'systemd-run',
    [
      '--user',
      '--no-block',
      `--unit=${unit}`,
      '--description=NanoClaw self-upgrade',
      `--working-directory=${projectRoot}`,
      '/bin/bash',
      '-lc',
      'make deploy',
    ],
    { stdio: 'pipe' },
  );
  if (r.status === 0) {
    log.info('Self-upgrade: deploy unit started', { unit });
    return;
  }
  log.error('Self-upgrade: failed to start deploy unit', {
    unit,
    stderr: r.stderr?.toString().trim(),
    stdout: r.stdout?.toString().trim(),
  });
}
