/**
 * Container Runner v2
 * Spawns agent containers with session folder + agent group folder mounts.
 * The container runs the v2 agent-runner which polls the session DB.
 */
import { ChildProcess, execSync, spawn } from 'child_process';
import fs from 'fs';
import path from 'path';

import { OneCLI } from '@onecli-sh/sdk';

import {
  CONTAINER_IMAGE,
  CONTAINER_IMAGE_BASE,
  CONTAINER_INSTALL_LABEL,
  DATA_DIR,
  GROUPS_DIR,
  ONECLI_API_KEY,
  ONECLI_URL,
  TIMEZONE,
} from './config.js';
import { materializeContainerJson } from './container-config.js';
import { getContainerConfig } from './db/container-configs.js';
import { updateContainerConfigScalars, updateContainerConfigJson } from './db/container-configs.js';
import { CONTAINER_RUNTIME_BIN, hostGatewayArgs, readonlyMountArgs, stopContainer } from './container-runtime.js';
import { composeGroupClaudeMd } from './claude-md-compose.js';
import { getAgentGroup } from './db/agent-groups.js';
import { getGithubAppForAgentGroup } from './db/github-apps.js';
import { mintInstallationToken } from './github-app-broker.js';
import { getDb, hasTable } from './db/connection.js';
import { initGroupFilesystem } from './group-init.js';
import { stopTypingRefresh } from './modules/typing/index.js';
import { log } from './log.js';
import { validateAdditionalMounts } from './modules/mount-security/index.js';
// Provider host-side config barrel — each provider that needs host-side
// container setup self-registers on import.
import './providers/index.js';
import {
  getProviderContainerConfig,
  type ProviderContainerContribution,
  type VolumeMount,
} from './providers/provider-container-registry.js';
import {
  heartbeatPath,
  markContainerRunning,
  markContainerStopped,
  sessionDir,
  writeSessionRouting,
} from './session-manager.js';
import type { AgentGroup, Session } from './types.js';

const onecli = new OneCLI({ url: ONECLI_URL, apiKey: ONECLI_API_KEY });

/**
 * Flip a newly-created agent's secret mode from "selective" (OneCLI default)
 * to "all" so every vault secret + connected app matching the request's
 * host pattern gets injected, without per-agent assignment busywork.
 *
 * The SDK doesn't expose this — we hit the OneCLI HTTP API directly:
 *   GET   /api/agents               → find the agent by identifier
 *   PATCH /api/agents/<id>/secret-mode  body {mode:"all"}
 *
 * Errors are logged and swallowed: a fresh agent in selective mode still
 * spawns, the user just hits the documented "401 / app not connected"
 * symptom and can flip the mode by hand. Throwing here would block all
 * sessions for the agent group on a transient OneCLI hiccup.
 */
// GitHub App installation tokens expire after ~1h. Refresh when within 5m of
// expiry so long-lived sessions don't silently lose GitHub access. See #66.
const GH_TOKEN_LIFETIME_MS = 60 * 60 * 1000;
const GH_TOKEN_REFRESH_THRESHOLD_MS = 5 * 60 * 1000;

/**
 * If the agent group has a bound GitHub App identity, mint a short-lived
 * installation token on the host and append it to the container's env args as
 * GH_TOKEN + GITHUB_TOKEN. Best-effort by design (see call site). The private
 * key stays on the host filesystem; only the minted token crosses into the
 * container, and it expires within ~1h.
 *
 * Returns the mint timestamp on success (used to track token age for refresh).
 */
async function injectGithubAppToken(args: string[], agentGroupId: string): Promise<number | undefined> {
  const identity = getGithubAppForAgentGroup(agentGroupId);
  if (!identity) return undefined;
  // 5s (not the broker default 10s) — this is awaited inline on the spawn path,
  // so a slow/unreachable GitHub shouldn't add much latency before the
  // best-effort null path kicks in. The happy path is well under a second.
  const token = await mintInstallationToken(
    {
      appId: identity.app_id,
      installationId: identity.installation_id,
      privateKeyPath: identity.private_key_path,
      apiUrl: identity.api_url,
    },
    5_000,
  );
  if (!token) {
    log.warn('GitHub App token unavailable; spawning without it', { agentGroupId });
    return undefined;
  }
  args.push('-e', `GH_TOKEN=${token}`, '-e', `GITHUB_TOKEN=${token}`);
  log.info('GitHub App token injected', { agentGroupId, appId: identity.app_id });
  return Date.now();
}

/**
 * Refresh the GitHub App token in a running container when near expiry.
 *
 * Writes a fresh token to /tmp/.gh-token inside the container via docker exec.
 * The BASH_ENV hook (created at container startup) reads that file on every
 * non-interactive bash subshell, so subsequent git/gh/curl calls pick up the
 * new token without a container restart. See #66.
 */
/** Write `input` to a container via docker exec, returns a promise (non-blocking). */
function dockerExecWrite(containerName: string, shellCmd: string, input: string, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(CONTAINER_RUNTIME_BIN, ['exec', '-i', containerName, 'sh', '-c', shellCmd]);
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`docker exec timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`docker exec exited with code ${code}`));
    });
    child.stdin?.write(input);
    child.stdin?.end();
  });
}

async function refreshGithubTokenInContainer(
  agentGroupId: string,
  entry: { containerName: string; tokenMintedAt?: number },
): Promise<void> {
  if (!entry.tokenMintedAt) return;
  const age = Date.now() - entry.tokenMintedAt;
  if (age < GH_TOKEN_LIFETIME_MS - GH_TOKEN_REFRESH_THRESHOLD_MS) return;

  // Deduplicate: two messages arriving in the same tick both pass the age
  // check. Guard with a per-container in-flight set (mirrors wakePromises).
  if (refreshingContainers.has(entry.containerName)) return;
  refreshingContainers.add(entry.containerName);

  try {
    const identity = getGithubAppForAgentGroup(agentGroupId);
    if (!identity) return;

    const token = await mintInstallationToken(
      {
        appId: identity.app_id,
        installationId: identity.installation_id,
        privateKeyPath: identity.private_key_path,
        apiUrl: identity.api_url,
      },
      5_000,
    );
    if (!token) {
      log.warn('GitHub App token refresh failed; container keeps expired token', {
        agentGroupId,
        containerName: entry.containerName,
      });
      return;
    }

    await dockerExecWrite(entry.containerName, 'cat > /tmp/.gh-token && chmod 600 /tmp/.gh-token', token, 5_000);
    entry.tokenMintedAt = Date.now();
    log.info('GitHub App token refreshed in container', { agentGroupId, containerName: entry.containerName });
  } catch (err) {
    log.warn('GitHub App token refresh docker exec failed', { agentGroupId, containerName: entry.containerName, err });
  } finally {
    refreshingContainers.delete(entry.containerName);
  }
}

async function ensureAgentSecretModeAll(identifier: string): Promise<void> {
  const baseUrl = ONECLI_URL.replace(/\/+$/, '');
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (ONECLI_API_KEY) headers.Authorization = `Bearer ${ONECLI_API_KEY}`;

  try {
    const listRes = await fetch(`${baseUrl}/api/agents`, {
      headers,
      signal: AbortSignal.timeout(5000),
    });
    if (!listRes.ok) {
      log.warn('OneCLI list agents failed; cannot set secret mode', {
        status: listRes.status,
        identifier,
      });
      return;
    }
    const agents = (await listRes.json()) as Array<{
      id: string;
      identifier?: string;
      secretMode?: 'all' | 'selective';
    }>;
    const agent = agents.find((a) => a.identifier === identifier);
    if (!agent) {
      log.warn('OneCLI agent not found after ensureAgent; skipping secret mode flip', { identifier });
      return;
    }
    // Field name is reverse-engineered from the OneCLI HTTP API (no SDK contract).
    // If OneCLI renames `secretMode` we'd silently lose the idempotency check
    // and PATCH on every spawn — surface the drift instead.
    if (agent.secretMode === undefined) {
      log.warn('OneCLI agent missing expected `secretMode` field; field may have been renamed', {
        identifier,
        agentId: agent.id,
      });
    }
    if (agent.secretMode === 'all') return; // already correct, idempotent no-op

    const patchRes = await fetch(`${baseUrl}/api/agents/${agent.id}/secret-mode`, {
      method: 'PATCH',
      headers,
      body: JSON.stringify({ mode: 'all' }),
      signal: AbortSignal.timeout(5000),
    });
    if (!patchRes.ok) {
      log.warn('OneCLI set-secret-mode failed', {
        status: patchRes.status,
        identifier,
        agentId: agent.id,
      });
      return;
    }
    log.info('OneCLI agent secret mode set to all', { identifier, agentId: agent.id });
  } catch (err) {
    log.warn('OneCLI set-secret-mode threw', { err: String(err), identifier });
  }
}

/**
 * Hardcoded proxy port baked into OneCLI 1.23.x's `/api/container-config`
 * response (it ignores `GATEWAY_API_URL` and always emits
 * `host.docker.internal:10255` in `HTTPS_PROXY`/`HTTP_PROXY`). Stock
 * single-instance installs put the gateway on host port 10255, so the
 * default matches and nothing has to be rewritten.
 */
const ONECLI_DEFAULT_PROXY_PORT = 10255;

/**
 * Per-instance OneCLI port allocation is defined in `instances.conf` —
 * the i-th instance gets a contiguous triple
 * `(app, proxy, …) = (base + i*stride, base + i*stride + 1, base + i*stride + 2)`.
 * So the proxy port for any given OneCLI app port is `app_port + 1`.
 * If that allocation convention ever changes in `instances.conf`,
 * `fixProxyGatewayPort` will rewrite to the wrong port.
 */
const ONECLI_PROXY_PORT_OFFSET = 1;

const PROXY_ENV_KEYS = new Set(['HTTPS_PROXY', 'HTTP_PROXY', 'https_proxy', 'http_proxy']);

/**
 * Rewrite the proxy port in the env args pushed by `applyContainerConfig`.
 *
 * OneCLI 1.23.x hardcodes `host.docker.internal:10255` in the
 * `HTTPS_PROXY`/`HTTP_PROXY` env it returns from `/api/container-config`,
 * which is correct for stock single-instance setups but wrong for
 * multi-instance installs where each instance's proxy lives on a
 * different port (see `instances.conf` and `ONECLI_PROXY_PORT_OFFSET`
 * above). Without this rewrite, every API call from the container hangs
 * because nothing is listening on :10255.
 *
 * Strategy: parse the port from `onecliUrl`, compute the expected proxy
 * port (`app_port + ONECLI_PROXY_PORT_OFFSET`), and rewrite the
 * `-e HTTP[S]_PROXY=...` args in place. No-op when the computed port is
 * already `ONECLI_DEFAULT_PROXY_PORT` (single-instance default).
 *
 * If `expectedProxyPort !== ONECLI_DEFAULT_PROXY_PORT` but zero proxy args
 * get rewritten, the function logs a warning — that means OneCLI changed
 * the hardcoded port, the env-key set, or the `-e KEY=VALUE` arg shape
 * (e.g. switched to `--env` or `-e KEY VALUE`), all of which would
 * silently resurrect the original hang.
 *
 * Exported only for unit tests.
 */
export function fixProxyGatewayPort(args: string[], onecliUrl: string): void {
  let onecliPort: number;
  try {
    onecliPort = Number(new URL(onecliUrl).port);
  } catch {
    return;
  }
  if (!Number.isFinite(onecliPort) || onecliPort === 0) return;
  const expectedProxyPort = onecliPort + ONECLI_PROXY_PORT_OFFSET;
  if (expectedProxyPort === ONECLI_DEFAULT_PROXY_PORT) return;

  const defaultPortBoundary = new RegExp(`:${ONECLI_DEFAULT_PROXY_PORT}(?=[@/?#]|$)`, 'g');
  let rewriteCount = 0;
  for (let i = 0; i < args.length - 1; i++) {
    if (args[i] !== '-e') continue;
    const next = args[i + 1];
    const eq = next.indexOf('=');
    if (eq < 0) continue;
    const key = next.slice(0, eq);
    if (!PROXY_ENV_KEYS.has(key)) continue;
    const value = next.slice(eq + 1);
    const rewritten = value.replace(defaultPortBoundary, `:${expectedProxyPort}`);
    if (rewritten !== value) rewriteCount++;
    args[i + 1] = `${key}=${rewritten}`;
  }

  if (rewriteCount === 0) {
    log.warn('fixProxyGatewayPort: no proxy args rewritten — OneCLI may have changed the hardcoded port or arg shape', {
      onecliPort,
      expectedProxyPort,
      defaultProxyPort: ONECLI_DEFAULT_PROXY_PORT,
    });
  }
}

/** Active containers tracked by session ID. */
const activeContainers = new Map<string, { process: ChildProcess; containerName: string; tokenMintedAt?: number }>();

/** Containers with a token refresh already in-flight (deduplicates concurrent wakes). */
const refreshingContainers = new Set<string>();

/**
 * In-flight wake promises, keyed by session id. Deduplicates concurrent
 * `wakeContainer` calls while the first spawn is still mid-setup (async
 * buildContainerArgs, OneCLI gateway apply, etc.) — otherwise a second
 * wake in that window passes the `activeContainers.has` check and spawns
 * a duplicate container against the same session directory, producing
 * racy double-replies.
 */
const wakePromises = new Map<string, Promise<boolean>>();

export function getActiveContainerCount(): number {
  return activeContainers.size;
}

export function isContainerRunning(sessionId: string): boolean {
  return activeContainers.has(sessionId);
}

/**
 * Wake up a container for a session. If already running or mid-spawn, no-op
 * (the in-flight wake promise is reused).
 *
 * The container runs the v2 agent-runner which polls the session DB.
 *
 * Contract: never throws. Returns `true` on successful spawn, `false` on
 * transient spawn failure (e.g. OneCLI gateway unreachable). Callers don't
 * need to wrap — the inbound row stays pending and host-sweep retries on
 * its next tick. Callers that care (e.g. the router's typing indicator)
 * can branch on the boolean.
 */
export function wakeContainer(session: Session): Promise<boolean> {
  const running = activeContainers.get(session.id);
  if (running) {
    log.debug('Container already running', { sessionId: session.id });
    void refreshGithubTokenInContainer(session.agent_group_id, running);
    return Promise.resolve(true);
  }
  const existing = wakePromises.get(session.id);
  if (existing) {
    log.debug('Container wake already in-flight — joining existing promise', { sessionId: session.id });
    return existing;
  }
  const promise = spawnContainer(session)
    .then(() => true)
    .catch((err) => {
      log.warn('wakeContainer failed — host-sweep will retry', { sessionId: session.id, err });
      return false;
    })
    .finally(() => {
      wakePromises.delete(session.id);
    });
  wakePromises.set(session.id, promise);
  return promise;
}

async function spawnContainer(session: Session): Promise<void> {
  const agentGroup = getAgentGroup(session.agent_group_id);
  if (!agentGroup) {
    log.error('Agent group not found', { agentGroupId: session.agent_group_id });
    return;
  }

  // Refresh the destination map and default reply routing so any admin
  // changes take effect on wake. Destinations come from the agent-to-agent
  // module — skip when the module isn't installed (table absent).
  if (hasTable(getDb(), 'agent_destinations')) {
    const { writeDestinations } = await import('./modules/agent-to-agent/write-destinations.js');
    writeDestinations(agentGroup.id, session.id);
  }
  writeSessionRouting(agentGroup.id, session.id);

  // Materialize container.json from DB — writes fresh file and returns
  // the config object, threaded through provider resolution, buildMounts,
  // and buildContainerArgs so we don't re-read.
  const containerConfig = materializeContainerJson(agentGroup.id);

  // Resolve the effective provider + any host-side contribution it declares
  // (extra mounts, env passthrough). Computed once and threaded through both
  // buildMounts and buildContainerArgs so side effects (mkdir, etc.) fire once.
  const { provider, contribution } = resolveProviderContribution(session, agentGroup, containerConfig);

  const mounts = buildMounts(agentGroup, session, containerConfig, contribution);
  const containerName = `nanoclaw-v2-${agentGroup.folder}-${Date.now()}`;
  // OneCLI agent identifier is always the agent group id — stable across
  // sessions and reversible via getAgentGroup() for approval routing.
  const agentIdentifier = agentGroup.id;
  const { args, githubTokenMintedAt } = await buildContainerArgs(
    mounts,
    containerName,
    agentGroup,
    containerConfig,
    provider,
    contribution,
    agentIdentifier,
  );

  log.info('Spawning container', { sessionId: session.id, agentGroup: agentGroup.name, containerName });

  // Clear any orphan heartbeat from a previous container instance — the
  // sweep's ceiling check treats a missing file as "fresh spawn, give grace"
  // (host-sweep.ts line 87). Without this, the stale mtime can trigger an
  // immediate kill before the new container touches the file itself.
  fs.rmSync(heartbeatPath(agentGroup.id, session.id), { force: true });

  const container = spawn(CONTAINER_RUNTIME_BIN, args, { stdio: ['ignore', 'pipe', 'pipe'] });

  activeContainers.set(session.id, { process: container, containerName, tokenMintedAt: githubTokenMintedAt });
  markContainerRunning(session.id);

  // Log stderr
  container.stderr?.on('data', (data) => {
    for (const line of data.toString().trim().split('\n')) {
      if (line) log.debug(line, { container: agentGroup.folder });
    }
  });

  // stdout is unused in v2 (all IO is via session DB)
  container.stdout?.on('data', () => {});

  // No host-side idle timeout. Stale/stuck detection is driven by the host
  // sweep reading heartbeat mtime + processing_ack claim age + container_state
  // (see src/host-sweep.ts). This avoids killing long-running legitimate work
  // on a wall-clock timer.

  container.on('close', (code) => {
    activeContainers.delete(session.id);
    markContainerStopped(session.id);
    stopTypingRefresh(session.id);
    log.info('Container exited', { sessionId: session.id, code, containerName });
  });

  container.on('error', (err) => {
    activeContainers.delete(session.id);
    markContainerStopped(session.id);
    stopTypingRefresh(session.id);
    log.error('Container spawn error', { sessionId: session.id, err });
  });
}

/** Kill a container for a session. */
export function killContainer(sessionId: string, reason: string, onExit?: () => void): void {
  const entry = activeContainers.get(sessionId);
  if (!entry) return;

  if (onExit) {
    entry.process.once('close', onExit);
  }

  log.info('Killing container', { sessionId, reason, containerName: entry.containerName });
  try {
    stopContainer(entry.containerName);
  } catch {
    entry.process.kill('SIGKILL');
  }
}

/**
 * Resolve the provider name for a session:
 *
 *   sessions.agent_provider
 *     → container_configs.provider
 *     → 'claude'
 *
 * Pure so the precedence can be unit-tested without a DB or filesystem.
 */
export function resolveProviderName(
  sessionProvider: string | null | undefined,
  containerConfigProvider: string | null | undefined,
): string {
  return (sessionProvider || containerConfigProvider || 'claude').toLowerCase();
}

function resolveProviderContribution(
  session: Session,
  agentGroup: AgentGroup,
  containerConfig: import('./container-config.js').ContainerConfig,
): { provider: string; contribution: ProviderContainerContribution } {
  const provider = resolveProviderName(session.agent_provider, containerConfig.provider);
  const fn = getProviderContainerConfig(provider);
  const contribution = fn
    ? fn({
        sessionDir: sessionDir(agentGroup.id, session.id),
        agentGroupId: agentGroup.id,
        hostEnv: process.env,
      })
    : {};
  return { provider, contribution };
}

function buildMounts(
  agentGroup: AgentGroup,
  session: Session,
  containerConfig: import('./container-config.js').ContainerConfig,
  providerContribution: ProviderContainerContribution,
): VolumeMount[] {
  const projectRoot = process.cwd();

  // Per-group filesystem state lives forever after first creation. Init is
  // idempotent: it only writes paths that don't already exist, so this call
  // is a no-op for groups that have spawned before.
  initGroupFilesystem(agentGroup);

  // Recompose CLAUDE.md and sync skill symlinks only when the fragment set has
  // changed. composeGroupClaudeMd hashes the inputs (skills, MCP config,
  // cli_scope) and returns false without touching the filesystem if unchanged.
  // syncSkillSymlinks is driven by the same inputs, so we gate it on the same
  // result to avoid redundant directory scans on every spawn.
  const claudeDir = path.join(DATA_DIR, 'v2-sessions', agentGroup.id, '.claude-shared');
  if (composeGroupClaudeMd(agentGroup)) {
    syncSkillSymlinks(claudeDir, containerConfig);
  }

  const mounts: VolumeMount[] = [];
  const sessDir = sessionDir(agentGroup.id, session.id);
  const groupDir = path.resolve(GROUPS_DIR, agentGroup.folder);

  // Session folder at /workspace (contains inbound.db, outbound.db, outbox/, .claude/)
  mounts.push({ hostPath: sessDir, containerPath: '/workspace', readonly: false });

  // Agent group folder at /workspace/agent (RW for working files + CLAUDE.local.md)
  mounts.push({ hostPath: groupDir, containerPath: '/workspace/agent', readonly: false });

  // container.json — nested RO mount on top of RW group dir so the agent
  // can read its config but cannot modify it.
  const containerJsonPath = path.join(groupDir, 'container.json');
  if (fs.existsSync(containerJsonPath)) {
    mounts.push({ hostPath: containerJsonPath, containerPath: '/workspace/agent/container.json', readonly: true });
  }

  // Composer-managed CLAUDE.md artifacts — nested RO mounts. These are
  // regenerated from the shared base + fragments on every spawn; any
  // agent-side writes would be clobbered, so enforce read-only. Only
  // CLAUDE.local.md (per-group memory) remains RW via the group-dir mount.
  // `.claude-shared.md` is a symlink whose target (`/app/CLAUDE.md`) is
  // already RO-mounted, so writes through it fail regardless — no need for
  // a nested mount there.
  const composedClaudeMd = path.join(groupDir, 'CLAUDE.md');
  if (fs.existsSync(composedClaudeMd)) {
    mounts.push({ hostPath: composedClaudeMd, containerPath: '/workspace/agent/CLAUDE.md', readonly: true });
  }
  const fragmentsDir = path.join(groupDir, '.claude-fragments');
  if (fs.existsSync(fragmentsDir)) {
    mounts.push({ hostPath: fragmentsDir, containerPath: '/workspace/agent/.claude-fragments', readonly: true });
  }

  // Global memory directory — always read-only.
  const globalDir = path.join(GROUPS_DIR, 'global');
  if (fs.existsSync(globalDir)) {
    mounts.push({ hostPath: globalDir, containerPath: '/workspace/global', readonly: true });
  }

  // Shared CLAUDE.md — read-only, imported by the composed entry point via
  // the `.claude-shared.md` symlink inside the group dir.
  const sharedClaudeMd = path.join(process.cwd(), 'container', 'CLAUDE.md');
  if (fs.existsSync(sharedClaudeMd)) {
    mounts.push({ hostPath: sharedClaudeMd, containerPath: '/app/CLAUDE.md', readonly: true });
  }

  // Per-group .claude-shared at /home/node/.claude (Claude state, settings,
  // skill symlinks)
  mounts.push({ hostPath: claudeDir, containerPath: '/home/node/.claude', readonly: false });

  // Shared agent-runner source — read-only, same code for all groups.
  const agentRunnerSrc = path.join(projectRoot, 'container', 'agent-runner', 'src');
  mounts.push({ hostPath: agentRunnerSrc, containerPath: '/app/src', readonly: true });

  // Shared skills — read-only, symlinks in .claude-shared/skills/ point here.
  const skillsSrc = path.join(projectRoot, 'container', 'skills');
  if (fs.existsSync(skillsSrc)) {
    mounts.push({ hostPath: skillsSrc, containerPath: '/app/skills', readonly: true });
  }

  // Additional mounts from container config
  if (containerConfig.additionalMounts && containerConfig.additionalMounts.length > 0) {
    const validated = validateAdditionalMounts(containerConfig.additionalMounts, agentGroup.name);
    mounts.push(...validated);
  }

  // Provider-contributed mounts (e.g. opencode-xdg)
  if (providerContribution.mounts) {
    mounts.push(...providerContribution.mounts);
  }

  return mounts;
}

/**
 * Sync skill symlinks in .claude-shared/skills/ to match the container.json
 * selection. Each symlink points to a container path (/app/skills/<name>)
 * so it's dangling on the host but valid inside the container.
 */
function syncSkillSymlinks(claudeDir: string, containerConfig: import('./container-config.js').ContainerConfig): void {
  const skillsDir = path.join(claudeDir, 'skills');
  if (!fs.existsSync(skillsDir)) {
    fs.mkdirSync(skillsDir, { recursive: true });
  }

  // Determine desired skill set
  const projectRoot = process.cwd();
  const sharedSkillsDir = path.join(projectRoot, 'container', 'skills');
  let desired: string[];
  if (containerConfig.skills === 'all') {
    // Recompute from shared dir — newly-added upstream skills appear automatically
    desired = fs.existsSync(sharedSkillsDir)
      ? fs.readdirSync(sharedSkillsDir).filter((e) => {
          try {
            return fs.statSync(path.join(sharedSkillsDir, e)).isDirectory();
          } catch {
            return false;
          }
        })
      : [];
  } else {
    desired = containerConfig.skills;
  }

  const desiredSet = new Set(desired);

  // Remove symlinks not in the desired set
  for (const entry of fs.readdirSync(skillsDir)) {
    const entryPath = path.join(skillsDir, entry);
    let isSymlink = false;
    try {
      isSymlink = fs.lstatSync(entryPath).isSymbolicLink();
    } catch {
      continue;
    }
    if (isSymlink && !desiredSet.has(entry)) {
      fs.unlinkSync(entryPath);
    }
  }

  // Create symlinks for desired skills (container path targets)
  for (const skill of desired) {
    const linkPath = path.join(skillsDir, skill);
    let exists = false;
    try {
      fs.lstatSync(linkPath);
      exists = true;
    } catch {
      /* missing */
    }
    if (!exists) {
      fs.symlinkSync(`/app/skills/${skill}`, linkPath);
    }
  }
}

async function buildContainerArgs(
  mounts: VolumeMount[],
  containerName: string,
  agentGroup: AgentGroup,
  containerConfig: import('./container-config.js').ContainerConfig,
  provider: string,
  providerContribution: ProviderContainerContribution,
  agentIdentifier?: string,
): Promise<{ args: string[]; githubTokenMintedAt: number | undefined }> {
  const args: string[] = ['run', '--rm', '--name', containerName, '--label', CONTAINER_INSTALL_LABEL];

  // Environment — only vars read by code we don't own.
  // Everything NanoClaw-specific is in container.json (read by runner at startup).
  args.push('-e', `TZ=${TIMEZONE}`);

  // Provider-contributed env vars (e.g. XDG_DATA_HOME, OPENCODE_*, NO_PROXY).
  if (providerContribution.env) {
    for (const [key, value] of Object.entries(providerContribution.env)) {
      args.push('-e', `${key}=${value}`);
    }
  }

  // GitHub App bot identity (the "second secrets store" for credentials OneCLI
  // can't broker on its free plan). When this agent group has a bound GitHub
  // App, the host mints a short-lived (~1h) installation token from the
  // on-disk private key — the key never enters the container or any LLM
  // context — and injects it as GH_TOKEN / GITHUB_TOKEN so `gh`, git, and the
  // agent can act AS the app's bot identity. Best-effort: a mint failure logs
  // and spawns without the token rather than blocking the container.
  const githubTokenMintedAt = await injectGithubAppToken(args, agentGroup.id);

  // OneCLI gateway — injects HTTPS_PROXY + certs so container API calls
  // are routed through the agent vault for credential injection. The wiring
  // calls (ensureAgent + applyContainerConfig) are treated as transient hard
  // failures: if we can't wire the gateway, we don't spawn — the caller
  // (router or host-sweep) catches the throw, leaves the inbound message
  // pending, and the next sweep tick retries.
  //
  // ensureAgentSecretModeAll is intentionally best-effort: secret-mode is a
  // credential-availability optimization, not a wiring prerequisite, so a
  // OneCLI hiccup here degrades the agent to its old selective-mode
  // behaviour (the documented gotcha) rather than blocking the spawn.
  if (agentIdentifier) {
    await onecli.ensureAgent({ name: agentGroup.name, identifier: agentIdentifier });
    await ensureAgentSecretModeAll(agentIdentifier);
  }
  const onecliApplied = await onecli.applyContainerConfig(args, { addHostMapping: false, agent: agentIdentifier });
  if (!onecliApplied) {
    throw new Error('OneCLI gateway not applied — refusing to spawn container without credentials');
  }
  fixProxyGatewayPort(args, ONECLI_URL);
  log.info('OneCLI gateway applied', { containerName });

  // Host gateway
  args.push(...hostGatewayArgs());

  // User mapping
  const hostUid = process.getuid?.();
  const hostGid = process.getgid?.();
  if (hostUid != null && hostUid !== 0 && hostUid !== 1000) {
    args.push('--user', `${hostUid}:${hostGid}`);
    args.push('-e', 'HOME=/home/node');
  }

  // Volume mounts
  for (const mount of mounts) {
    if (mount.readonly) {
      args.push(...readonlyMountArgs(mount.hostPath, mount.containerPath));
    } else {
      args.push('-v', `${mount.hostPath}:${mount.containerPath}`);
    }
  }

  // Override entrypoint: run v2 entry point directly via Bun (no tsc, no stdin).
  args.push('--entrypoint', 'bash');

  // Use per-agent-group image if one has been built, otherwise base image
  const imageTag = containerConfig.imageTag || CONTAINER_IMAGE;
  args.push(imageTag);

  // Seed /tmp/.gh-token and create the BASH_ENV hook so every non-interactive
  // bash subshell (git, gh, curl invoked by the agent) transparently picks up
  // a refreshed GH_TOKEN written by the host via docker exec. See #66.
  args.push(
    '-c',
    `if [ -n "$GH_TOKEN" ]; then
  printf '%s' "$GH_TOKEN" > /tmp/.gh-token
  chmod 600 /tmp/.gh-token
fi
cat > /tmp/.gh-token-env << 'HOOKEOF'
if [ -f /tmp/.gh-token ]; then
  read -r _nanoclaw_gh_t < /tmp/.gh-token 2>/dev/null || true
  if [ -n "$_nanoclaw_gh_t" ]; then
    export GH_TOKEN="$_nanoclaw_gh_t"
    export GITHUB_TOKEN="$_nanoclaw_gh_t"
  fi
  unset _nanoclaw_gh_t
fi
HOOKEOF
exec bun run /app/src/index.ts`,
  );

  return { args, githubTokenMintedAt };
}

/** Build a per-agent-group Docker image with custom packages. */
export async function buildAgentGroupImage(agentGroupId: string): Promise<void> {
  const agentGroup = getAgentGroup(agentGroupId);
  if (!agentGroup) throw new Error('Agent group not found');

  const configRow = getContainerConfig(agentGroup.id);
  if (!configRow) throw new Error('Container config not found');
  const aptPackages = JSON.parse(configRow.packages_apt) as string[];
  const npmPackages = JSON.parse(configRow.packages_npm) as string[];
  if (aptPackages.length === 0 && npmPackages.length === 0) {
    throw new Error('No packages to install. Use install_packages first.');
  }

  let dockerfile = `FROM ${CONTAINER_IMAGE}\nUSER root\n`;
  if (aptPackages.length > 0) {
    dockerfile += `RUN apt-get update && apt-get install -y ${aptPackages.join(' ')} && rm -rf /var/lib/apt/lists/*\n`;
  }
  if (npmPackages.length > 0) {
    // pnpm skips build scripts unless packages are allowlisted. Append each
    // to /root/.npmrc (base image sets it up for agent-browser) so packages
    // with postinstall — e.g. playwright, puppeteer, native addons — don't
    // install silently broken.
    const allowlist = npmPackages.map((p) => `echo 'only-built-dependencies[]=${p}' >> /root/.npmrc`).join(' && ');
    dockerfile += `RUN ${allowlist} && pnpm install -g ${npmPackages.join(' ')}\n`;
  }
  dockerfile += 'USER node\n';

  const imageTag = `${CONTAINER_IMAGE_BASE}:${agentGroupId}`;

  log.info('Building per-agent-group image', { agentGroupId, imageTag, apt: aptPackages, npm: npmPackages });

  // Write Dockerfile to temp file and build
  const tmpDockerfile = path.join(DATA_DIR, `Dockerfile.${agentGroupId}`);
  fs.writeFileSync(tmpDockerfile, dockerfile);
  try {
    execSync(`${CONTAINER_RUNTIME_BIN} build -t ${imageTag} -f ${tmpDockerfile} .`, {
      cwd: DATA_DIR,
      stdio: 'pipe',
      timeout: 900_000,
    });
  } finally {
    fs.unlinkSync(tmpDockerfile);
  }

  // Store the image tag in the DB
  updateContainerConfigScalars(agentGroup.id, { image_tag: imageTag });

  log.info('Per-agent-group image built', { agentGroupId, imageTag });
}
