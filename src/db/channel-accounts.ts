import { channelFamily, channelType as composeChannelType } from '../channels/channel-family.js';
import { getDb, hasTable } from './connection.js';

/**
 * A standalone bot identity. `id` IS the channel_type the rest of the pipeline
 * routes on (e.g. `telegram#andy`). `bot_token` is a host-side secret used to
 * run the adapter — it is never injected into a container.
 */
export interface ChannelAccount {
  id: string;
  family: string;
  label: string | null;
  agent_group_id: string | null;
  bot_token: string | null;
  created_at: string;
}

/** Guarded: the table only exists once migration 016 has run. */
function tableReady(): boolean {
  return hasTable(getDb(), 'channel_accounts');
}

export function createChannelAccount(account: ChannelAccount): void {
  getDb()
    .prepare(
      `INSERT INTO channel_accounts (id, family, label, agent_group_id, bot_token, created_at)
       VALUES (@id, @family, @label, @agent_group_id, @bot_token, @created_at)`,
    )
    .run(account);
}

export function getChannelAccount(id: string): ChannelAccount | undefined {
  if (!tableReady()) return undefined;
  return getDb().prepare('SELECT * FROM channel_accounts WHERE id = ?').get(id) as ChannelAccount | undefined;
}

/** All accounts for a family (e.g. every Telegram bot). Empty when the table is absent. */
export function getChannelAccountsByFamily(family: string): ChannelAccount[] {
  if (!tableReady()) return [];
  return getDb()
    .prepare('SELECT * FROM channel_accounts WHERE family = ? ORDER BY created_at')
    .all(family) as ChannelAccount[];
}

export function getAllChannelAccounts(): ChannelAccount[] {
  if (!tableReady()) return [];
  return getDb().prepare('SELECT * FROM channel_accounts ORDER BY family, created_at').all() as ChannelAccount[];
}

export function updateChannelAccount(
  id: string,
  updates: Partial<Pick<ChannelAccount, 'label' | 'agent_group_id' | 'bot_token'>>,
): void {
  const fields: string[] = [];
  const values: Record<string, unknown> = { id };
  for (const [key, value] of Object.entries(updates)) {
    if (value !== undefined) {
      fields.push(`${key} = @${key}`);
      values[key] = value;
    }
  }
  if (fields.length === 0) return;
  getDb()
    .prepare(`UPDATE channel_accounts SET ${fields.join(', ')} WHERE id = @id`)
    .run(values);
}

export function deleteChannelAccount(id: string): void {
  getDb().prepare('DELETE FROM channel_accounts WHERE id = ?').run(id);
}

/**
 * The channel_type a family adapter should listen on when no DB accounts exist
 * but a legacy single-bot token is configured in `.env`. Kept so existing
 * single-bot installs keep working unchanged after the migration.
 */
export function legacyChannelType(family: string): string {
  return composeChannelType(family);
}

export { channelFamily };
