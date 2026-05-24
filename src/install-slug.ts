/**
 * Per-checkout install identifiers. Lets two NanoClaw installs coexist on
 * one host without clobbering each other's service registration or the
 * shared `nanoclaw-agent:latest` docker image tag.
 *
 * Slug is sha1(projectRoot)[:8] — deterministic per checkout path, stable
 * across re-runs, unique enough across installs.
 *
 * Multi-instance: when `NCL_INSTANCE` is set, the slug used for unit names,
 * service labels, and the container-install label mixes the instance name
 * into the hash so two instances running from the same checkout produce
 * distinct systemd units, plists, and orphan-sweep label scopes. The
 * container image base is intentionally NOT instance-scoped — both
 * instances run the same built image, so they share a tag and a build.
 */
import { createHash } from 'crypto';

import { readInstanceName } from './instance-name.js';

function resolveInstance(instance?: string): string {
  if (instance !== undefined) return instance;
  // Reads + validates process.env.NCL_INSTANCE. Throws on invalid values
  // so they can't reach the slug hash, plist label, or systemd unit name.
  return readInstanceName();
}

export function getInstallSlug(projectRoot: string = process.cwd(), instance?: string): string {
  const inst = resolveInstance(instance);
  const input = inst ? `${projectRoot}:${inst}` : projectRoot;
  return createHash('sha1').update(input).digest('hex').slice(0, 8);
}

/** launchd Label + plist basename. e.g. `com.nanoclaw-v2-ab12cd34`. */
export function getLaunchdLabel(projectRoot?: string, instance?: string): string {
  return `com.nanoclaw-v2-${getInstallSlug(projectRoot, instance)}`;
}

/** systemd unit name (no .service suffix). e.g. `nanoclaw-v2-ab12cd34`. */
export function getSystemdUnit(projectRoot?: string, instance?: string): string {
  return `nanoclaw-v2-${getInstallSlug(projectRoot, instance)}`;
}

/**
 * Docker image base (no tag). e.g. `nanoclaw-agent-v2-ab12cd34`.
 * Per-checkout only — instances on the same checkout share one image.
 */
export function getContainerImageBase(projectRoot?: string): string {
  return `nanoclaw-agent-v2-${getInstallSlug(projectRoot, '')}`;
}

/** Default full container image reference with `:latest` tag. */
export function getDefaultContainerImage(projectRoot?: string): string {
  return `${getContainerImageBase(projectRoot)}:latest`;
}
