/**
 * Telegram channel adapter (v2) — uses Chat SDK bridge, with a pairing
 * interceptor wrapped around onInbound to verify chat ownership before
 * registration. See telegram-pairing.ts for the why.
 *
 * Single-instance multi-bot: this factory produces ONE adapter per Telegram
 * `channel_account` row, each running its own bot token and listening on its
 * own `channel_type` (`telegram#<slug>`). That is how an operator gets a
 * standalone @handle per agent without running multiple host processes. If no
 * accounts are configured in the DB but a legacy `TELEGRAM_BOT_TOKEN` is set in
 * `.env`, a single default bot is started on `channel_type='telegram'` so
 * existing single-bot installs keep working unchanged.
 */
import { createTelegramAdapter } from '@chat-adapter/telegram';

import { ENV_FILE_PATH } from '../config.js';
import { readEnvFile } from '../env.js';
import { log } from '../log.js';
import { getChannelAccountsByFamily, legacyChannelType } from '../db/channel-accounts.js';
import {
  createMessagingGroup,
  createMessagingGroupAgent,
  getMessagingGroupAgents,
  getMessagingGroupByPlatform,
  updateMessagingGroup,
} from '../db/messaging-groups.js';
import { getAgentGroup } from '../db/agent-groups.js';
import { grantRole, hasAnyOwner } from '../modules/permissions/db/user-roles.js';
import { upsertUser } from '../modules/permissions/db/users.js';
import { createChatSdkBridge, type ReplyContext } from './chat-sdk-bridge.js';
import { sanitizeTelegramLegacyMarkdown } from './telegram-markdown-sanitize.js';
import { registerChannelAdapter } from './channel-registry.js';
import type { ChannelAccountSpec, ChannelAdapter, ChannelSetup, InboundMessage } from './adapter.js';
import { tryConsume } from './telegram-pairing.js';

const TELEGRAM_FAMILY = 'telegram';

/**
 * Retry a one-shot operation that can fail on transient network errors at
 * cold-start (DNS hiccups, brief upstream outages). Exponential backoff capped
 * at 5 attempts — if the network is truly down we surface it instead of
 * hanging the service indefinitely.
 */
async function withRetry<T>(fn: () => Promise<T>, label: string, maxAttempts = 5): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (attempt === maxAttempts) break;
      const delay = Math.min(16000, 1000 * 2 ** (attempt - 1));
      log.warn('Telegram setup failed, retrying', { label, attempt, delayMs: delay, err });
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw lastErr;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function extractReplyContext(raw: Record<string, any>): ReplyContext | null {
  if (!raw.reply_to_message) return null;
  const reply = raw.reply_to_message;
  return {
    text: reply.text || reply.caption || '',
    sender: reply.from?.first_name || reply.from?.username || 'Unknown',
  };
}

/** Look up the bot username via Telegram getMe. Cached after first call. */
async function fetchBotUsername(token: string): Promise<string | null> {
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/getMe`);
    const json = (await res.json()) as { ok: boolean; result?: { username?: string } };
    return json.ok ? (json.result?.username ?? null) : null;
  } catch (err) {
    log.warn('Telegram getMe failed', { err });
    return null;
  }
}

function isGroupPlatformId(platformId: string): boolean {
  // platformId is "telegram:<chatId>". Negative chat IDs are groups/channels.
  const id = platformId.split(':').pop() ?? '';
  return id.startsWith('-');
}

interface InboundFields {
  text: string;
  authorUserId: string | null;
}

function readInboundFields(message: InboundMessage): InboundFields {
  if (message.kind !== 'chat-sdk' || !message.content || typeof message.content !== 'object') {
    return { text: '', authorUserId: null };
  }
  const c = message.content as { text?: string; author?: { userId?: string } };
  return { text: c.text ?? '', authorUserId: c.author?.userId ?? null };
}

/**
 * Send a one-shot confirmation back to the paired chat. Best-effort — failures
 * are logged but never propagated, so a Telegram outage can't undo a successful
 * pairing or trigger the interceptor's fail-open path.
 */
async function sendPairingConfirmation(token: string, platformId: string): Promise<void> {
  const chatId = platformId.split(':').slice(1).join(':');
  if (!chatId) return;
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text: 'Pairing success! Head back to the NanoClaw installer to finish setup.',
      }),
    });
    if (!res.ok) {
      log.warn('Telegram pairing confirmation non-OK', { status: res.status });
    }
  } catch (err) {
    log.warn('Telegram pairing confirmation failed', { err });
  }
}

/**
 * Auto-wire a freshly-paired chat to the bot's bound agent group. This is what
 * makes "register a bot for an agent, then DM it" work end to end: the channel
 * account carries the agent binding, so on pairing we create the
 * messaging_group_agents row with the same defaults the manual wiring flow uses
 * (DMs respond to everything; groups are mention-only). No-op when the account
 * isn't bound to an agent, the agent group is gone, or a wiring already exists.
 */
function autoWireToAgent(messagingGroupId: string, isGroup: boolean, agentGroupId: string | null): void {
  if (!agentGroupId) return;
  try {
    if (!getAgentGroup(agentGroupId)) {
      log.warn('Channel account bound to missing agent group; skipping auto-wire', { agentGroupId });
      return;
    }
    if (getMessagingGroupAgents(messagingGroupId).length > 0) return;
    createMessagingGroupAgent({
      id: `mga-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      messaging_group_id: messagingGroupId,
      agent_group_id: agentGroupId,
      engage_mode: isGroup ? 'mention' : 'pattern',
      engage_pattern: isGroup ? null : '.',
      sender_scope: 'all',
      ignored_message_policy: 'drop',
      session_mode: 'shared',
      priority: 0,
      created_at: new Date().toISOString(),
    });
    log.info('Auto-wired paired chat to bound agent', { messagingGroupId, agentGroupId });
  } catch (err) {
    log.error('Auto-wire to bound agent failed', { messagingGroupId, agentGroupId, err });
  }
}

/**
 * Build an onInbound interceptor that consumes pairing codes before they
 * reach the router. On match: records the chat (under THIS bot's channel_type)
 * + its paired user, optionally auto-wires the chat to the bot's bound agent,
 * promotes the user to owner if the instance has no owner yet, and
 * short-circuits. On miss: forwards to the host.
 *
 * `chanType` is the per-bot channel_type (`telegram#<slug>` or legacy
 * `telegram`); the paired USER is always namespaced by the family (`telegram:`)
 * so a person's identity and roles are stable across every bot.
 */
function createPairingInterceptor(
  botUsernamePromise: Promise<string | null>,
  hostOnInbound: ChannelSetup['onInbound'],
  token: string,
  chanType: string,
  agentGroupId: string | null,
): ChannelSetup['onInbound'] {
  return async (platformId, threadId, message) => {
    try {
      const botUsername = await botUsernamePromise;
      if (!botUsername) {
        hostOnInbound(platformId, threadId, message);
        return;
      }
      const { text, authorUserId } = readInboundFields(message);
      if (!text) {
        hostOnInbound(platformId, threadId, message);
        return;
      }
      const consumed = await tryConsume({
        text,
        botUsername,
        platformId,
        isGroup: isGroupPlatformId(platformId),
        adminUserId: authorUserId,
      });
      if (!consumed) {
        hostOnInbound(platformId, threadId, message);
        return;
      }
      // Pairing matched — record the chat and short-circuit so the
      // code-bearing message never reaches an agent. Privilege is now a
      // property of the paired user, not the chat: upsert the user, and if
      // this instance has no owner yet, promote them to owner.
      const isGroup = consumed.consumed!.isGroup;
      const existing = getMessagingGroupByPlatform(chanType, platformId);
      let messagingGroupId: string;
      if (existing) {
        messagingGroupId = existing.id;
        updateMessagingGroup(existing.id, { is_group: isGroup ? 1 : 0 });
      } else {
        messagingGroupId = `mg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        createMessagingGroup({
          id: messagingGroupId,
          channel_type: chanType,
          platform_id: platformId,
          name: consumed.consumed!.name,
          is_group: isGroup ? 1 : 0,
          unknown_sender_policy: 'strict',
          created_at: new Date().toISOString(),
        });
      }

      // Bind the chat to the bot's agent so DMing the bot just works.
      autoWireToAgent(messagingGroupId, isGroup, agentGroupId);

      const pairedUserId = `${TELEGRAM_FAMILY}:${consumed.consumed!.adminUserId}`;
      upsertUser({
        id: pairedUserId,
        kind: TELEGRAM_FAMILY,
        display_name: null,
        created_at: new Date().toISOString(),
      });

      let promotedToOwner = false;
      if (!hasAnyOwner()) {
        grantRole({
          user_id: pairedUserId,
          role: 'owner',
          agent_group_id: null,
          granted_by: null,
          granted_at: new Date().toISOString(),
        });
        promotedToOwner = true;
      }

      log.info('Telegram pairing accepted — chat registered', {
        channelType: chanType,
        platformId,
        pairedUser: pairedUserId,
        promotedToOwner,
        intent: consumed.intent,
      });

      await sendPairingConfirmation(token, platformId);
    } catch (err) {
      log.error('Telegram pairing interceptor error', { err });
      // Fail open: pass through so a pairing bug doesn't break normal traffic.
      hostOnInbound(platformId, threadId, message);
    }
  };
}

interface TelegramBot {
  channelType: string;
  token: string;
  agentGroupId: string | null;
}

interface BuildOptions {
  /** When false, bridge.setup is attempted once (no retry) — used for live add. */
  retrySetup?: boolean;
}

/** Build a single Telegram adapter for one bot identity. */
function buildTelegramAdapter(bot: TelegramBot, opts: BuildOptions = {}): ChannelAdapter {
  const { channelType: chanType, token, agentGroupId } = bot;
  // Live (interactive) add fails fast; startup retries through transient blips.
  const setupAttempts = opts.retrySetup === false ? 1 : 5;
  const telegramAdapter = createTelegramAdapter({
    botToken: token,
    mode: 'polling',
  });
  const bridge = createChatSdkBridge({
    adapter: telegramAdapter,
    concurrency: 'concurrent',
    extractReplyContext,
    supportsThreads: false,
    transformOutboundText: sanitizeTelegramLegacyMarkdown,
    maxTextLength: 4000,
  });

  const botUsernamePromise = fetchBotUsername(token);

  const wrapped: ChannelAdapter = {
    ...bridge,
    // Each bot listens on its own channel_type so the registry, router, and
    // delivery resolve the right bot for inbound + outbound. The bridge would
    // otherwise default both to the shared SDK adapter name ('telegram').
    name: chanType,
    channelType: chanType,
    resolveChannelName: async (platformId: string) => {
      const chatId = platformId.split(':').slice(1).join(':');
      if (!chatId) return null;
      try {
        const res = await fetch(`https://api.telegram.org/bot${token}/getChat`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ chat_id: chatId }),
        });
        const data = (await res.json()) as { ok?: boolean; result?: { title?: string } };
        return data.ok ? (data.result?.title ?? null) : null;
      } catch {
        return null;
      }
    },
    async setup(hostConfig: ChannelSetup) {
      const intercepted: ChannelSetup = {
        ...hostConfig,
        onInbound: createPairingInterceptor(botUsernamePromise, hostConfig.onInbound, token, chanType, agentGroupId),
      };
      return withRetry(() => bridge.setup(intercepted), `bridge.setup(${chanType})`, setupAttempts);
    },
  };
  return wrapped;
}

/**
 * Resolve the set of Telegram bots to start. Prefers DB channel accounts (one
 * bot per agent); falls back to a single legacy bot from `TELEGRAM_BOT_TOKEN`
 * when no accounts exist, so single-bot installs keep working.
 */
function resolveTelegramBots(): TelegramBot[] {
  const accounts = getChannelAccountsByFamily(TELEGRAM_FAMILY).filter((a) => a.bot_token);
  const bots: TelegramBot[] = accounts.map((a) => ({
    channelType: a.id,
    token: a.bot_token!,
    agentGroupId: a.agent_group_id,
  }));

  // Keep a legacy single-bot `.env` TELEGRAM_BOT_TOKEN working even AFTER
  // channel accounts are added, so an existing install doesn't silently lose
  // its original bot the moment a second one is created. Skipped only when the
  // same token is already represented by an account — two pollers on one bot
  // token would conflict at Telegram's getUpdates. Migrate the legacy bot into
  // an account when convenient; until then it runs on channel_type 'telegram'.
  const env = readEnvFile(['TELEGRAM_BOT_TOKEN'], ENV_FILE_PATH);
  const legacyToken = env.TELEGRAM_BOT_TOKEN;
  if (legacyToken && !bots.some((b) => b.token === legacyToken)) {
    bots.push({ channelType: legacyChannelType(TELEGRAM_FAMILY), token: legacyToken, agentGroupId: null });
  }
  return bots;
}

/** Turn a channel_account into a bot spec, or null if it has no token. */
function accountToBot(account: ChannelAccountSpec): TelegramBot | null {
  if (!account.bot_token) return null;
  return { channelType: account.id, token: account.bot_token, agentGroupId: account.agent_group_id };
}

registerChannelAdapter(TELEGRAM_FAMILY, {
  factory: () => {
    const bots = resolveTelegramBots();
    if (bots.length === 0) return null;
    return bots.map((bot) => buildTelegramAdapter(bot));
  },
  // Live (restart-free) add: build one adapter for a single newly-created
  // Telegram channel account. `fastFail` (interactive add) disables the
  // bridge.setup retry so the operator's ncl call returns promptly.
  buildAccountAdapter: (account, opts) => {
    const bot = accountToBot(account);
    return bot ? buildTelegramAdapter(bot, { retrySetup: !opts?.fastFail }) : null;
  },
});
