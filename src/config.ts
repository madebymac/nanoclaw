import os from 'os';
import path from 'path';

import { readEnvFile } from './env.js';
import { getContainerImageBase, getDefaultContainerImage, getInstallSlug } from './install-slug.js';
import { isValidTimezone } from './timezone.js';

// Absolute paths needed for container mounts
const PROJECT_ROOT = process.cwd();
const HOME_DIR = process.env.HOME || os.homedir();

// Single-install layout: all per-install state lives at the project root.
// Exported so channel adapters and provider configs read tokens from the
// project-root .env. Anything that calls readEnvFile() must pass
// ENV_FILE_PATH so it doesn't silently fall back to process.cwd().
export const ENV_FILE_PATH = path.join(PROJECT_ROOT, '.env');

// Read config values from .env (falls back to process.env).
const envConfig = readEnvFile(
  [
    'ASSISTANT_NAME',
    'ASSISTANT_HAS_OWN_NUMBER',
    'ONECLI_URL',
    'ONECLI_API_KEY',
    'TZ',
    'PR_REVIEW_AGENT_GROUP_ID',
    'PR_REVIEW_COOLDOWN_MS',
    'PR_REVIEW_STATUS_MESSAGING_GROUP_ID',
  ],
  ENV_FILE_PATH,
);

export const ASSISTANT_NAME = process.env.ASSISTANT_NAME || envConfig.ASSISTANT_NAME || 'Andy';
export const ASSISTANT_HAS_OWN_NUMBER =
  (process.env.ASSISTANT_HAS_OWN_NUMBER || envConfig.ASSISTANT_HAS_OWN_NUMBER) === 'true';

// Mount security: allowlist stored OUTSIDE project root, never mounted into containers
export const MOUNT_ALLOWLIST_PATH = path.join(HOME_DIR, '.config', 'nanoclaw', 'mount-allowlist.json');
export const SENDER_ALLOWLIST_PATH = path.join(HOME_DIR, '.config', 'nanoclaw', 'sender-allowlist.json');
export const STORE_DIR = path.resolve(PROJECT_ROOT, 'store');
export const GROUPS_DIR = path.resolve(PROJECT_ROOT, 'groups');
export const DATA_DIR = path.resolve(PROJECT_ROOT, 'data');

// Per-checkout image tag so two installs on the same host don't share
// `nanoclaw-agent:latest` and clobber each other on rebuild.
export const CONTAINER_IMAGE_BASE = process.env.CONTAINER_IMAGE_BASE || getContainerImageBase(PROJECT_ROOT);
export const CONTAINER_IMAGE = process.env.CONTAINER_IMAGE || getDefaultContainerImage(PROJECT_ROOT);
// Install slug — stamped onto every spawned container via --label so
// cleanupOrphans only reaps containers from this install, not peers.
export const INSTALL_SLUG = getInstallSlug(PROJECT_ROOT);
export const CONTAINER_INSTALL_LABEL = `nanoclaw-install=${INSTALL_SLUG}`;
export const CONTAINER_TIMEOUT = parseInt(process.env.CONTAINER_TIMEOUT || '1800000', 10);
export const CONTAINER_MAX_OUTPUT_SIZE = parseInt(process.env.CONTAINER_MAX_OUTPUT_SIZE || '10485760', 10); // 10MB default
export const ONECLI_URL = process.env.ONECLI_URL || envConfig.ONECLI_URL;
export const ONECLI_API_KEY = process.env.ONECLI_API_KEY || envConfig.ONECLI_API_KEY;
export const MAX_MESSAGES_PER_PROMPT = Math.max(1, parseInt(process.env.MAX_MESSAGES_PER_PROMPT || '10', 10) || 10);
export const IDLE_TIMEOUT = parseInt(process.env.IDLE_TIMEOUT || '1800000', 10); // 30min default — how long to keep container alive after last result
export const MAX_CONCURRENT_CONTAINERS = Math.max(1, parseInt(process.env.MAX_CONCURRENT_CONTAINERS || '5', 10) || 5);

// Self-upgrade: periodic poll for upstream commits on the current branch's
// tracking remote. When the local checkout is strictly behind upstream and
// fast-forwardable, the host shells out to `make deploy` via
// `systemd-run --user --no-block` so the deploy survives the parent's restart.
// Linux-only (Makefile uses `systemctl --user`).
export const SELF_UPGRADE_INTERVAL_MS = Math.max(
  60_000,
  parseInt(process.env.NANOCLAW_SELF_UPGRADE_INTERVAL_MS || '600000', 10) || 600_000,
);
export const SELF_UPGRADE_REMOTE = process.env.NANOCLAW_SELF_UPGRADE_REMOTE || 'origin';

// PR-review: a host-side scan for open PRs the review bot hasn't reviewed yet,
// invoked by `ncl pr-review run` (typically from system cron). The "needs
// review?" check is pure GitHub REST (no AI tokens); the agent is only woken
// when a PR actually needs review. No env vars required — the reviewer agent
// group is auto-discovered from whichever group has a GitHub App identity.
// Set PR_REVIEW_AGENT_GROUP_ID to override when multiple apps are configured.
// See src/modules/pr-review/ and docs/pr-review.md for the crontab recipe.
export const PR_REVIEW_AGENT_GROUP_ID =
  process.env.PR_REVIEW_AGENT_GROUP_ID || envConfig.PR_REVIEW_AGENT_GROUP_ID || null;
// How long after dispatching a PR before it may be re-dispatched if the bot's
// review still hasn't landed (covers an agent run that errored out).
export const PR_REVIEW_COOLDOWN_MS = Math.max(
  60_000,
  parseInt(process.env.PR_REVIEW_COOLDOWN_MS || envConfig.PR_REVIEW_COOLDOWN_MS || '1800000', 10) || 1_800_000,
);
// Messaging-group id where the review bot announces "review requested" and
// "review complete" status updates. When set, dispatches are anchored to a
// session bound to this group so the agent's reply flows back as the
// completion update; when unset, dispatch falls back to the silent
// agent-shared session (original behaviour). Typically the operator's
// shared agents chat (e.g. a Telegram group with the review bot).
export const PR_REVIEW_STATUS_MESSAGING_GROUP_ID =
  process.env.PR_REVIEW_STATUS_MESSAGING_GROUP_ID || envConfig.PR_REVIEW_STATUS_MESSAGING_GROUP_ID || null;

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function buildTriggerPattern(trigger: string): RegExp {
  return new RegExp(`^${escapeRegex(trigger.trim())}\\b`, 'i');
}

export const DEFAULT_TRIGGER = `@${ASSISTANT_NAME}`;

export function getTriggerPattern(trigger?: string): RegExp {
  const normalizedTrigger = trigger?.trim();
  return buildTriggerPattern(normalizedTrigger || DEFAULT_TRIGGER);
}

export const TRIGGER_PATTERN = buildTriggerPattern(DEFAULT_TRIGGER);

// Timezone for scheduled tasks, message formatting, etc.
// Validates each candidate is a real IANA identifier before accepting.
function resolveConfigTimezone(): string {
  const candidates = [process.env.TZ, envConfig.TZ, Intl.DateTimeFormat().resolvedOptions().timeZone];
  for (const tz of candidates) {
    if (tz && isValidTimezone(tz)) return tz;
  }
  return 'UTC';
}
export const TIMEZONE = resolveConfigTimezone();
