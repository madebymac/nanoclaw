/**
 * Channel adapter registry.
 *
 * Channels self-register on import. The host calls initChannelAdapters() at startup
 * to instantiate and set up all registered adapters.
 */
import type { ChannelAdapter, ChannelRegistration, ChannelSetup } from './adapter.js';
import { log } from '../log.js';

const SETUP_RETRY_DELAYS_MS = [2000, 5000, 10000];

/** Duck-type check — adapters that throw an Error with `name === 'NetworkError'`
 * (Chat SDK's `@chat-adapter/shared.NetworkError` and similar) get a retry on
 * setup. Avoids depending on `@chat-adapter/shared` at trunk level. */
function isNetworkError(err: unknown): err is Error {
  return err instanceof Error && err.name === 'NetworkError';
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const registry = new Map<string, ChannelRegistration>();
const activeAdapters = new Map<string, ChannelAdapter>();

// Captured from initChannelAdapters so live (restart-free) adds can set up a
// new adapter with the same host wiring (onInbound/onAction/etc.) the
// startup-time adapters got. Null until the host has initialized channels.
let hostSetupFn: ((adapter: ChannelAdapter) => ChannelSetup) | null = null;

/** Register a channel adapter factory. Called by channel modules on import. */
export function registerChannelAdapter(name: string, registration: ChannelRegistration): void {
  registry.set(name, registration);
}

/** Look up a registration by channel name/family (used for live add). */
export function getChannelRegistration(name: string): ChannelRegistration | undefined {
  return registry.get(name);
}

/** Get a live adapter by channel type. */
export function getChannelAdapter(channelType: string): ChannelAdapter | undefined {
  return activeAdapters.get(channelType);
}

/** Get all active adapters. */
export function getActiveAdapters(): ChannelAdapter[] {
  return [...activeAdapters.values()];
}

/** Get all registered channel names. */
export function getRegisteredChannelNames(): string[] {
  return [...registry.keys()];
}

/** Get container config for a channel (used by container-runner for additional mounts/env). */
export function getChannelContainerConfig(name: string): ChannelRegistration['containerConfig'] {
  return registry.get(name)?.containerConfig;
}

/** Set up a single adapter (with NetworkError retry) and register it. */
async function startOneAdapter(
  name: string,
  adapter: ChannelAdapter,
  setupFn: (adapter: ChannelAdapter) => ChannelSetup,
): Promise<void> {
  const setup = setupFn(adapter);
  // Transient network failures during adapter init (e.g. Telegram deleteWebhook
  // hitting a DNS hiccup at boot) would otherwise leave the channel permanently
  // dead until manual restart. Retry only on NetworkError so misconfigs (bad
  // tokens, etc.) still fail fast.
  let attempt = 0;
  while (true) {
    try {
      await adapter.setup(setup);
      break;
    } catch (err) {
      if (isNetworkError(err) && attempt < SETUP_RETRY_DELAYS_MS.length) {
        const delay = SETUP_RETRY_DELAYS_MS[attempt]!;
        log.warn('Channel adapter setup failed with network error, retrying', {
          channel: name,
          type: adapter.channelType,
          attempt: attempt + 1,
          delayMs: delay,
          err: err.message,
        });
        await sleep(delay);
        attempt += 1;
        continue;
      }
      throw err;
    }
  }
  activeAdapters.set(adapter.channelType, adapter);
  log.info('Channel adapter started', { channel: name, type: adapter.channelType });
}

/**
 * Instantiate and set up all registered channel adapters.
 * Skips registrations that return null (no credentials configured).
 *
 * A registration may produce MULTIPLE adapters (single-instance multi-bot — one
 * Telegram bot per agent). Each is set up and registered under its own
 * `channelType` key, and each is isolated: a bad token on one bot logs and is
 * skipped without taking down its siblings.
 */
export async function initChannelAdapters(setupFn: (adapter: ChannelAdapter) => ChannelSetup): Promise<void> {
  hostSetupFn = setupFn;
  for (const [name, registration] of registry) {
    let produced: ChannelAdapter | ChannelAdapter[] | null;
    try {
      produced = await registration.factory();
    } catch (err) {
      log.error('Channel adapter factory threw', { channel: name, err });
      continue;
    }
    if (!produced || (Array.isArray(produced) && produced.length === 0)) {
      log.warn('Channel credentials missing, skipping', { channel: name });
      continue;
    }

    const adapters = Array.isArray(produced) ? produced : [produced];
    for (const adapter of adapters) {
      try {
        await startOneAdapter(name, adapter, setupFn);
      } catch (err) {
        log.error('Failed to start channel adapter', { channel: name, type: adapter.channelType, err });
      }
    }
  }
}

/**
 * Start (or restart) a single adapter live — no host restart. Used when an
 * operator adds or re-tokenizes a channel account via `ncl`. If an adapter is
 * already active on the same channel_type it is torn down first, so this is
 * also the "rotate token" path. Throws if channels haven't been initialized
 * yet (host still booting) or if setup fails — callers decide whether to
 * surface a "restart to retry" hint.
 */
export async function startAdapterLive(adapter: ChannelAdapter): Promise<void> {
  if (!hostSetupFn) {
    throw new Error('channel adapters not initialized yet — cannot add live; restart the host');
  }
  if (activeAdapters.has(adapter.channelType)) {
    await stopAdapterLive(adapter.channelType);
  }
  await startOneAdapter(`live:${adapter.channelType}`, adapter, hostSetupFn);
}

/** Tear down and deregister a single active adapter by channel_type. No-op if absent. */
export async function stopAdapterLive(channelType: string): Promise<void> {
  const adapter = activeAdapters.get(channelType);
  if (!adapter) return;
  try {
    await adapter.teardown();
  } catch (err) {
    log.warn('Failed to tear down adapter on live stop', { channelType, err });
  }
  activeAdapters.delete(channelType);
  log.info('Channel adapter stopped (live)', { channelType });
}

/** Tear down all active adapters. */
export async function teardownChannelAdapters(): Promise<void> {
  for (const [name, adapter] of activeAdapters) {
    try {
      await adapter.teardown();
      log.info('Channel adapter stopped', { channel: name });
    } catch (err) {
      log.error('Failed to stop channel adapter', { channel: name, err });
    }
  }
  activeAdapters.clear();
}
