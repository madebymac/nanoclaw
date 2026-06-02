import Database from 'better-sqlite3';
import fs from 'fs';
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';

import { bridgeGroupMessageToCoResidentAgents } from './group-bridge.js';
import { createDestination } from './db/agent-destinations.js';
import { initTestDb, closeDb, runMigrations, createAgentGroup } from '../../db/index.js';
import { createMessagingGroup, createMessagingGroupAgent } from '../../db/messaging-groups.js';
import { createSession } from '../../db/sessions.js';
import { initSessionFolder, inboundDbPath } from '../../session-manager.js';
import type { MessagingGroup, MessagingGroupAgent, Session } from '../../types.js';

vi.mock('../../container-runner.js', () => ({
  wakeContainer: vi.fn().mockResolvedValue(undefined),
  isContainerRunning: vi.fn().mockReturnValue(false),
  getActiveContainerCount: vi.fn().mockReturnValue(0),
  killContainer: vi.fn(),
}));

vi.mock('../../config.js', async () => {
  const actual = await vi.importActual('../../config.js');
  return { ...actual, DATA_DIR: '/tmp/nanoclaw-test-a2a-bridge' };
});

import { wakeContainer } from '../../container-runner.js';

const TEST_DIR = '/tmp/nanoclaw-test-a2a-bridge';
const CHAT = 'telegram:-100999'; // negative id ⇒ a Telegram group
const USER_DM = 'telegram:42'; // a private chat id, shared across both bots

const GENERAL = 'ag-general';
const REVIEW = 'ag-review';

function now(): string {
  return new Date().toISOString();
}

function readInbound(agentGroupId: string, sessionId: string) {
  const db = new Database(inboundDbPath(agentGroupId, sessionId), { readonly: true });
  const rows = db
    .prepare('SELECT platform_id, channel_type, content, trigger AS trig, source_session_id FROM messages_in ORDER BY seq')
    .all() as Array<{
    platform_id: string | null;
    channel_type: string | null;
    content: string;
    trig: number;
    source_session_id: string | null;
  }>;
  db.close();
  return rows;
}

function session(id: string, agentGroupId: string, messagingGroupId: string): Session {
  return {
    id,
    agent_group_id: agentGroupId,
    messaging_group_id: messagingGroupId,
    thread_id: null,
    agent_provider: null,
    status: 'active',
    container_status: 'stopped',
    last_active: null,
    created_at: now(),
  };
}

function groupMg(id: string, channelType: string, isGroup: number, platformId = CHAT): MessagingGroup {
  return {
    id,
    channel_type: channelType,
    platform_id: platformId,
    name: 'Agents',
    is_group: isGroup,
    unknown_sender_policy: 'strict',
    created_at: now(),
  };
}

function wiring(
  id: string,
  messagingGroupId: string,
  agentGroupId: string,
  pattern: string,
  ignoredPolicy: 'drop' | 'accumulate' = 'drop',
): MessagingGroupAgent {
  return {
    id,
    messaging_group_id: messagingGroupId,
    agent_group_id: agentGroupId,
    engage_mode: 'pattern',
    engage_pattern: pattern,
    sender_scope: 'all',
    ignored_message_policy: ignoredPolicy,
    session_mode: 'shared',
    priority: 0,
    created_at: now(),
  };
}

/**
 * Two agents (general + review) share ONE Telegram group, modelled as two
 * messaging groups with the same platform_id but each bot's channel_type.
 * general's session emits the outbound; we assert review receives a bridged
 * copy (or not), per its engagement wiring.
 */
describe('bridgeGroupMessageToCoResidentAgents', () => {
  let genSess: Session;
  let revSess: Session;

  function setup(reviewPattern: string, reviewPolicy: 'drop' | 'accumulate' = 'drop'): void {
    createAgentGroup({ id: GENERAL, name: 'general', folder: 'general', agent_provider: null, created_at: now() });
    createAgentGroup({ id: REVIEW, name: 'review', folder: 'review', agent_provider: null, created_at: now() });

    createMessagingGroup(groupMg('mg-gen', 'telegram#general', 1));
    createMessagingGroup(groupMg('mg-rev', 'telegram#review', 1));
    createMessagingGroupAgent(wiring('w-gen', 'mg-gen', GENERAL, '@general|@[Aa]ll'));
    createMessagingGroupAgent(wiring('w-rev', 'mg-rev', REVIEW, reviewPattern, reviewPolicy));

    // review knows general by the local name "general"
    createDestination({ agent_group_id: REVIEW, local_name: 'general', target_type: 'agent', target_id: GENERAL, created_at: now() });

    genSess = session('sess-gen', GENERAL, 'mg-gen');
    revSess = session('sess-rev', REVIEW, 'mg-rev');
    createSession(genSess);
    createSession(revSess);
    initSessionFolder(GENERAL, genSess.id);
    initSessionFolder(REVIEW, revSess.id);
  }

  beforeEach(() => {
    if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
    fs.mkdirSync(TEST_DIR, { recursive: true });
    const db = initTestDb();
    runMigrations(db);
    vi.mocked(wakeContainer).mockClear();
  });

  afterEach(() => {
    closeDb();
    if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
  });

  it('bridges a mentioning post into the co-resident peer and wakes it', async () => {
    setup('@review|@[Aa]ll');
    await bridgeGroupMessageToCoResidentAgents(
      {
        id: 'msg-1',
        kind: 'chat',
        channel_type: 'telegram#general',
        platform_id: CHAT,
        content: JSON.stringify({ text: '@review can you look at PR #63?' }),
      },
      genSess,
    );

    const rows = readInbound(REVIEW, revSess.id);
    expect(rows).toHaveLength(1);
    // Addressed from review's OWN view of the group so a reply re-enters the group.
    expect(rows[0].channel_type).toBe('telegram#review');
    expect(rows[0].platform_id).toBe(CHAT);
    expect(rows[0].trig).toBe(1);
    expect(rows[0].source_session_id).toBe('sess-gen');
    const content = JSON.parse(rows[0].content);
    expect(content.text).toBe('@review can you look at PR #63?');
    expect(content.sender).toBe('general'); // review's local name for the sender
    expect(wakeContainer).toHaveBeenCalledTimes(1);
  });

  it('does not bridge or wake when the peer\'s pattern does not match and policy is drop', async () => {
    setup('@review|@[Aa]ll', 'drop');
    await bridgeGroupMessageToCoResidentAgents(
      {
        id: 'msg-2',
        kind: 'chat',
        channel_type: 'telegram#general',
        platform_id: CHAT,
        content: JSON.stringify({ text: 'thanks everyone, wrapping up' }),
      },
      genSess,
    );

    expect(readInbound(REVIEW, revSess.id)).toHaveLength(0);
    expect(wakeContainer).not.toHaveBeenCalled();
  });

  it('stores non-engaging posts as silent context (trigger=0, no wake) when policy is accumulate', async () => {
    setup('@review|@[Aa]ll', 'accumulate');
    await bridgeGroupMessageToCoResidentAgents(
      {
        id: 'msg-3',
        kind: 'chat',
        channel_type: 'telegram#general',
        platform_id: CHAT,
        content: JSON.stringify({ text: 'just an FYI, no mention here' }),
      },
      genSess,
    );

    const rows = readInbound(REVIEW, revSess.id);
    expect(rows).toHaveLength(1);
    expect(rows[0].trig).toBe(0);
    expect(wakeContainer).not.toHaveBeenCalled();
  });

  it('never bridges a message back to the sending agent', async () => {
    setup('@review|@[Aa]ll');
    await bridgeGroupMessageToCoResidentAgents(
      {
        id: 'msg-4',
        kind: 'chat',
        channel_type: 'telegram#general',
        platform_id: CHAT,
        content: JSON.stringify({ text: '@all status update' }),
      },
      genSess,
    );

    // The sender's own session must not receive its own post.
    expect(readInbound(GENERAL, genSess.id)).toHaveLength(0);
    // review (which @all matches) still gets it.
    expect(readInbound(REVIEW, revSess.id)).toHaveLength(1);
  });

  it('does not bridge per-bot DMs that merely share a platform_id', async () => {
    // Two DMs (is_group=0) collide on the user's id but are separate chats.
    createAgentGroup({ id: GENERAL, name: 'general', folder: 'general', agent_provider: null, created_at: now() });
    createAgentGroup({ id: REVIEW, name: 'review', folder: 'review', agent_provider: null, created_at: now() });
    createMessagingGroup(groupMg('dm-gen', 'telegram#general', 0, USER_DM));
    createMessagingGroup(groupMg('dm-rev', 'telegram#review', 0, USER_DM));
    createMessagingGroupAgent(wiring('wd-gen', 'dm-gen', GENERAL, '@general|@[Aa]ll'));
    createMessagingGroupAgent(wiring('wd-rev', 'dm-rev', REVIEW, '@review|@[Aa]ll'));
    const gDm = session('sess-gen-dm', GENERAL, 'dm-gen');
    const rDm = session('sess-rev-dm', REVIEW, 'dm-rev');
    createSession(gDm);
    createSession(rDm);
    initSessionFolder(GENERAL, gDm.id);
    initSessionFolder(REVIEW, rDm.id);

    await bridgeGroupMessageToCoResidentAgents(
      {
        id: 'msg-5',
        kind: 'chat',
        channel_type: 'telegram#general',
        platform_id: USER_DM,
        content: JSON.stringify({ text: '@review hello' }),
      },
      gDm,
    );

    expect(readInbound(REVIEW, rDm.id)).toHaveLength(0);
    expect(wakeContainer).not.toHaveBeenCalled();
  });

  it('skips stream/edit operations and empty text', async () => {
    setup('@review|@[Aa]ll');
    await bridgeGroupMessageToCoResidentAgents(
      {
        id: 'msg-6',
        kind: 'chat',
        channel_type: 'telegram#general',
        platform_id: CHAT,
        content: JSON.stringify({ operation: 'stream_edit', targetMessageOutId: 'x', text: '@review partial' }),
      },
      genSess,
    );
    expect(readInbound(REVIEW, revSess.id)).toHaveLength(0);
  });
});
