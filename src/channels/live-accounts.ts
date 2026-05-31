/**
 * Live (restart-free) channel-account lifecycle.
 *
 * Bridges the `channel_accounts` store and the in-process adapter registry so
 * `ncl channel-accounts create/set-token/delete` take effect immediately — the
 * new bot starts polling without a host restart. The `ncl` handlers run inside
 * the host process (socket-server dispatch), so they can reach the live
 * registry directly.
 */
import type { ChannelAccount } from '../db/channel-accounts.js';
import { channelFamily } from './channel-family.js';
import { getChannelRegistration, startAdapterLive, stopAdapterLive } from './channel-registry.js';
import { log } from '../log.js';

export interface LiveStartResult {
  started: boolean;
  /** Operator-facing hint when the bot couldn't be started live. */
  reason?: string;
}

/**
 * Start (or restart, for a token rotation) a channel account's bot live.
 * Best-effort: the account row is the source of truth and is already
 * persisted; a failure here just means the bot needs a host restart to come
 * online, which the returned reason explains.
 */
export async function startChannelAccountLive(account: ChannelAccount): Promise<LiveStartResult> {
  const family = account.family || channelFamily(account.id);
  const registration = getChannelRegistration(family);
  if (!registration?.buildAccountAdapter) {
    return {
      started: false,
      reason: `channel family '${family}' has no live-add support — restart the host to activate`,
    };
  }

  let adapter;
  try {
    adapter = registration.buildAccountAdapter({
      id: account.id,
      family,
      label: account.label,
      agent_group_id: account.agent_group_id,
      bot_token: account.bot_token,
    });
  } catch (err) {
    log.error('buildAccountAdapter threw during live add', { id: account.id, err });
    return { started: false, reason: 'adapter build failed — restart the host to activate' };
  }
  if (!adapter) {
    return { started: false, reason: 'account has no credentials — not started' };
  }

  try {
    await startAdapterLive(adapter);
    log.info('Channel account started live', { id: account.id, family });
    return { started: true };
  } catch (err) {
    log.error('Live channel-account start failed', { id: account.id, err });
    return { started: false, reason: 'adapter setup failed — restart the host to retry' };
  }
}

/** Stop and deregister a channel account's bot live. */
export async function stopChannelAccountLive(channelType: string): Promise<void> {
  await stopAdapterLive(channelType);
}
