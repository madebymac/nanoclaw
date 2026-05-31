import { createChannelAccount, getChannelAccount, updateChannelAccount } from '../../db/channel-accounts.js';
import { channelType as composeChannelType, isValidAccountSlug } from '../../channels/channel-family.js';
import { getAgentGroup } from '../../db/agent-groups.js';
import { registerResource } from '../crud.js';

/**
 * `channel-accounts` — standalone bot identities. Each account is one bot
 * (e.g. one Telegram @handle) bound to an agent group; its `id` IS the
 * `channel_type` the pipeline routes on (`<family>#<slug>`). The bot token is a
 * host-side secret: it is write-only via this resource (never echoed by
 * list/get) and is never injected into a container.
 *
 * Adding a bot is: `channel-accounts create` → restart the host (adapters are
 * instantiated at startup) → pair the chat from the bot's DM. On pairing the
 * chat auto-wires to the bound agent.
 */
registerResource({
  name: 'channel-account',
  plural: 'channel-accounts',
  table: 'channel_accounts',
  description:
    'A standalone bot identity (e.g. one Telegram bot @handle) bound to an agent group. The id is the channel_type the bot routes on (<family>#<slug>). Bot tokens are write-only and never shown. Restart the host after create so the adapter starts.',
  idColumn: 'id',
  scopeField: 'agent_group_id',
  // bot_token is deliberately omitted — it must never be echoed back.
  columns: [
    {
      name: 'id',
      type: 'string',
      description: 'channel_type value, e.g. telegram#andy. Composed from family + slug.',
      generated: true,
    },
    { name: 'family', type: 'string', description: 'Channel family, e.g. "telegram".' },
    { name: 'label', type: 'string', description: 'Human label / bot @username.', updatable: true },
    {
      name: 'agent_group_id',
      type: 'string',
      description: 'Agent group this bot is bound to. References agent_groups.id.',
      updatable: true,
    },
    { name: 'created_at', type: 'string', description: 'Auto-set.', generated: true },
  ],
  operations: { list: 'open', get: 'open', update: 'approval', delete: 'approval' },
  customOperations: {
    create: {
      access: 'approval',
      description:
        'Register a bot. --slug <name> --bot-token <token> [--family telegram] [--label <text>] [--agent-group-id <id>]. Restart the host afterwards to start the bot.',
      handler: async (args) => {
        const family = ((args.family as string) || 'telegram').toLowerCase();
        const slug = args.slug as string;
        const botToken = args.bot_token as string;
        const label = (args.label as string) ?? null;
        const agentGroupId = (args.agent_group_id as string) ?? null;
        if (!slug) throw new Error('--slug is required (e.g. --slug andy)');
        if (!isValidAccountSlug(slug)) {
          throw new Error('--slug must match [a-z0-9][a-z0-9_-]{0,31} (lowercase, start with letter/digit)');
        }
        if (!botToken) throw new Error('--bot-token is required');
        if (agentGroupId && !getAgentGroup(agentGroupId)) {
          throw new Error(`agent group not found: ${agentGroupId}`);
        }
        const id = composeChannelType(family, slug);
        if (getChannelAccount(id)) throw new Error(`channel account already exists: ${id}`);
        createChannelAccount({
          id,
          family,
          label,
          agent_group_id: agentGroupId,
          bot_token: botToken,
          created_at: new Date().toISOString(),
        });
        // Never return the token.
        return { id, family, label, agent_group_id: agentGroupId, restart_required: true };
      },
    },
    'set-token': {
      access: 'approval',
      description: 'Replace a bot token. --id <channel_type> --bot-token <token>. Restart the host afterwards.',
      handler: async (args) => {
        const id = args.id as string;
        const botToken = args.bot_token as string;
        if (!id) throw new Error('--id is required');
        if (!botToken) throw new Error('--bot-token is required');
        if (!getChannelAccount(id)) throw new Error(`channel account not found: ${id}`);
        updateChannelAccount(id, { bot_token: botToken });
        return { id, updated: true, restart_required: true };
      },
    },
  },
});
