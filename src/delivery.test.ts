/**
 * Delivery race tests.
 *
 * The active poll (1s, running sessions) and the sweep poll (60s, all
 * active sessions) both call deliverSessionMessages. A running session
 * sits in both result sets, so the two timer chains can race on the same
 * outbound row — read-undelivered → call channel API → markDelivered. The
 * INSERT OR IGNORE in markDelivered makes the DB write idempotent, but
 * the channel API has already fired twice → user sees the message twice.
 */
import Database from 'better-sqlite3';
import fs from 'fs';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('./container-runner.js', () => ({
  wakeContainer: vi.fn().mockResolvedValue(undefined),
  isContainerRunning: vi.fn().mockReturnValue(false),
  killContainer: vi.fn(),
  buildAgentGroupImage: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('./config.js', async () => {
  const actual = await vi.importActual<typeof import('./config.js')>('./config.js');
  return { ...actual, DATA_DIR: '/tmp/nanoclaw-test-delivery' };
});

const TEST_DIR = '/tmp/nanoclaw-test-delivery';

import {
  initTestDb,
  closeDb,
  runMigrations,
  createAgentGroup,
  createMessagingGroup,
  createMessagingGroupAgent,
} from './db/index.js';
import { getDeliveredIds } from './db/session-db.js';
import { resolveSession, outboundDbPath, openInboundDb } from './session-manager.js';
import { deliverSessionMessages, setDeliveryAdapter } from './delivery.js';

function now(): string {
  return new Date().toISOString();
}

function seedAgentAndChannel(): void {
  createAgentGroup({
    id: 'ag-1',
    name: 'Test Agent',
    folder: 'test-agent',
    agent_provider: null,
      onecli_instance_id: null,
    created_at: now(),
  });
  createMessagingGroup({
    id: 'mg-1',
    channel_type: 'telegram',
    platform_id: 'telegram:123',
    name: 'Test Chat',
    is_group: 0,
    unknown_sender_policy: 'public',
    created_at: now(),
  });
}

function insertOutbound(agentGroupId: string, sessionId: string, msgId: string): void {
  const db = new Database(outboundDbPath(agentGroupId, sessionId));
  db.prepare(
    `INSERT INTO messages_out (id, timestamp, kind, platform_id, channel_type, content)
     VALUES (?, datetime('now'), 'chat', 'telegram:123', 'telegram', ?)`,
  ).run(msgId, JSON.stringify({ text: 'hello' }));
  db.close();
}

function insertOutboundContent(
  agentGroupId: string,
  sessionId: string,
  msgId: string,
  content: Record<string, unknown>,
  timestamp?: string,
): void {
  const db = new Database(outboundDbPath(agentGroupId, sessionId));
  db.prepare(
    `INSERT INTO messages_out (id, timestamp, kind, platform_id, channel_type, content)
     VALUES (?, ?, 'chat', 'telegram:123', 'telegram', ?)`,
  ).run(msgId, timestamp ?? new Date().toISOString(), JSON.stringify(content));
  db.close();
}

beforeEach(() => {
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
  fs.mkdirSync(TEST_DIR, { recursive: true });
  const db = initTestDb();
  runMigrations(db);
});

afterEach(() => {
  closeDb();
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
});

describe('deliverSessionMessages — concurrent invocations', () => {
  it('delivers a message exactly once when active and sweep polls overlap', async () => {
    seedAgentAndChannel();
    const { session } = resolveSession('ag-1', 'mg-1', null, 'shared');
    insertOutbound('ag-1', session.id, 'out-1');

    const calls: string[] = [];
    setDeliveryAdapter({
      async deliver(_channelType, _platformId, _threadId, _kind, content) {
        calls.push(content);
        // Hold long enough that the second concurrent caller can race the
        // read-undelivered → markDelivered window.
        await new Promise((r) => setTimeout(r, 100));
        return 'plat-msg-1';
      },
    });

    // Two concurrent calls — simulating active (1s) and sweep (60s) polls
    // hitting the same running session at the same moment.
    await Promise.all([deliverSessionMessages(session), deliverSessionMessages(session)]);

    expect(calls).toHaveLength(1);
  });

  it('still delivers on a subsequent call after the first finishes', async () => {
    seedAgentAndChannel();
    const { session } = resolveSession('ag-1', 'mg-1', null, 'shared');
    insertOutbound('ag-1', session.id, 'out-first');

    const calls: string[] = [];
    setDeliveryAdapter({
      async deliver(_channelType, _platformId, _threadId, _kind, content) {
        calls.push(content);
        return 'plat-msg-id';
      },
    });

    await deliverSessionMessages(session);
    expect(calls).toHaveLength(1);

    // Insert a second outbound message and deliver again — the lock from
    // the first call must have been released.
    insertOutbound('ag-1', session.id, 'out-second');
    await deliverSessionMessages(session);
    expect(calls).toHaveLength(2);
  });

  it('does not re-deliver when retried after a successful send (cleanup-after-send safety)', async () => {
    // If something post-send throws (e.g. outbox cleanup), the message has
    // still landed on the user's screen — the catch path must not trigger
    // a re-send. We simulate by having the adapter succeed on the first
    // call and recording how many times it's invoked across two attempts.
    seedAgentAndChannel();
    const { session } = resolveSession('ag-1', 'mg-1', null, 'shared');
    insertOutbound('ag-1', session.id, 'out-once');

    let callCount = 0;
    setDeliveryAdapter({
      async deliver() {
        callCount++;
        return 'plat-msg-id';
      },
    });

    await deliverSessionMessages(session);
    // Re-invoke — should be idempotent because the message is now in the
    // delivered table; the channel adapter must not be called again.
    await deliverSessionMessages(session);

    expect(callCount).toBe(1);
  });
});

describe('deliverSessionMessages — retry and permanent failure', () => {
  it('retries on adapter failure and marks failed after MAX_DELIVERY_ATTEMPTS (3)', async () => {
    seedAgentAndChannel();
    const { session } = resolveSession('ag-1', 'mg-1', null, 'shared');
    insertOutbound('ag-1', session.id, 'out-flaky');

    let callCount = 0;
    setDeliveryAdapter({
      async deliver() {
        callCount++;
        throw new Error('network timeout');
      },
    });

    // Attempt 1
    await deliverSessionMessages(session);
    expect(callCount).toBe(1);

    // Attempt 2
    await deliverSessionMessages(session);
    expect(callCount).toBe(2);

    // Attempt 3 — should mark as permanently failed
    await deliverSessionMessages(session);
    expect(callCount).toBe(3);

    // Attempt 4 — message is now in delivered (as failed), adapter not called
    await deliverSessionMessages(session);
    expect(callCount).toBe(3);

    // Verify the message is in the delivered table with 'failed' status
    const inDb = openInboundDb('ag-1', session.id);
    const delivered = getDeliveredIds(inDb);
    inDb.close();
    expect(delivered.has('out-flaky')).toBe(true);
  });

  it('clears attempt counter on successful delivery', async () => {
    seedAgentAndChannel();
    const { session } = resolveSession('ag-1', 'mg-1', null, 'shared');
    insertOutbound('ag-1', session.id, 'out-retry-ok');

    let callCount = 0;
    setDeliveryAdapter({
      async deliver() {
        callCount++;
        if (callCount === 1) throw new Error('transient');
        return 'plat-ok';
      },
    });

    // Attempt 1 — fails
    await deliverSessionMessages(session);
    expect(callCount).toBe(1);

    // Attempt 2 — succeeds
    await deliverSessionMessages(session);
    expect(callCount).toBe(2);

    // Attempt 3 — not called, message already delivered
    await deliverSessionMessages(session);
    expect(callCount).toBe(2);
  });
});

describe('deliverSessionMessages — stream_edit resolution', () => {
  it('rewrites stream_edit to edit op using platform_message_id from the delivered table', async () => {
    seedAgentAndChannel();
    const { session } = resolveSession('ag-1', 'mg-1', null, 'shared');

    // First: the original send that the stream_edit will target.
    insertOutboundContent('ag-1', session.id, 'out-orig', { text: 'partial' }, '2026-01-01T00:00:00Z');
    // Second: a stream_edit referencing the original by messages_out.id.
    insertOutboundContent(
      'ag-1',
      session.id,
      'out-edit-1',
      { operation: 'stream_edit', targetMessageOutId: 'out-orig', text: 'partial more' },
      '2026-01-01T00:00:01Z',
    );

    const calls: Array<{ kind: string; content: string }> = [];
    setDeliveryAdapter({
      async deliver(_ct, _pid, _tid, kind, content) {
        calls.push({ kind, content });
        return 'plat-msg-from-original';
      },
    });

    await deliverSessionMessages(session);

    expect(calls).toHaveLength(2);
    // First call is the original send, second is the rewritten edit.
    const editPayload = JSON.parse(calls[1].content);
    expect(editPayload).toEqual({
      operation: 'edit',
      messageId: 'plat-msg-from-original',
      text: 'partial more',
    });
  });

  it('retries stream_edit when the target has not been delivered yet, then succeeds once it lands', async () => {
    seedAgentAndChannel();
    const { session } = resolveSession('ag-1', 'mg-1', null, 'shared');

    // Only the stream_edit row exists initially — its target hasn't even
    // been written, so the resolver will throw and the row will sit in the
    // retry queue.
    insertOutboundContent(
      'ag-1',
      session.id,
      'out-edit-orphan',
      { operation: 'stream_edit', targetMessageOutId: 'out-late', text: 'edited' },
      '2026-01-01T00:00:05Z',
    );

    const calls: Array<string> = [];
    setDeliveryAdapter({
      async deliver(_ct, _pid, _tid, _kind, content) {
        calls.push(content);
        return 'plat-late';
      },
    });

    // First attempt — stream_edit throws because the target isn't there.
    await deliverSessionMessages(session);
    expect(calls).toHaveLength(0);

    // Target arrives.
    insertOutboundContent('ag-1', session.id, 'out-late', { text: 'arrived' }, '2026-01-01T00:00:02Z');

    await deliverSessionMessages(session);

    // Target sent, then stream_edit resolved and sent as an edit.
    expect(calls).toHaveLength(2);
    const edit = JSON.parse(calls[1]);
    expect(edit).toMatchObject({ operation: 'edit', messageId: 'plat-late', text: 'edited' });
  });

  it('coalesces superseded stream_edit rows — only the latest hits the adapter', async () => {
    seedAgentAndChannel();
    const { session } = resolveSession('ag-1', 'mg-1', null, 'shared');

    insertOutboundContent('ag-1', session.id, 'out-orig', { text: 'p1' }, '2026-01-01T00:00:00Z');
    // Three stream_edit rows pointing at the same target — only the last
    // should reach the adapter.
    insertOutboundContent(
      'ag-1',
      session.id,
      'edit-a',
      { operation: 'stream_edit', targetMessageOutId: 'out-orig', text: 'p1 p2' },
      '2026-01-01T00:00:01Z',
    );
    insertOutboundContent(
      'ag-1',
      session.id,
      'edit-b',
      { operation: 'stream_edit', targetMessageOutId: 'out-orig', text: 'p1 p2 p3' },
      '2026-01-01T00:00:02Z',
    );
    insertOutboundContent(
      'ag-1',
      session.id,
      'edit-c',
      { operation: 'stream_edit', targetMessageOutId: 'out-orig', text: 'p1 p2 p3 p4' },
      '2026-01-01T00:00:03Z',
    );

    const calls: string[] = [];
    setDeliveryAdapter({
      async deliver(_ct, _pid, _tid, _kind, content) {
        calls.push(content);
        return 'plat-orig';
      },
    });

    await deliverSessionMessages(session);

    // Original send + one edit (the newest).
    expect(calls).toHaveLength(2);
    const editPayload = JSON.parse(calls[1]);
    expect(editPayload.text).toBe('p1 p2 p3 p4');

    // Earlier edits should be marked delivered (coalesced) so they don't
    // resurface on a subsequent drain.
    const inDb = openInboundDb('ag-1', session.id);
    const delivered = getDeliveredIds(inDb);
    inDb.close();
    expect(delivered.has('edit-a')).toBe(true);
    expect(delivered.has('edit-b')).toBe(true);
    expect(delivered.has('edit-c')).toBe(true);

    // Re-drain should be a no-op.
    await deliverSessionMessages(session);
    expect(calls).toHaveLength(2);
  });

  it('fails fast on stream_edit whose target has permanently failed', async () => {
    seedAgentAndChannel();
    const { session } = resolveSession('ag-1', 'mg-1', null, 'shared');

    // Target that will permanently fail (adapter always throws).
    insertOutboundContent('ag-1', session.id, 'out-bad', { text: 'oops' }, '2026-01-01T00:00:00Z');

    let targetCalls = 0;
    setDeliveryAdapter({
      async deliver() {
        targetCalls++;
        throw new Error('persistent failure');
      },
    });

    // Burn the 3 retries to mark out-bad failed.
    await deliverSessionMessages(session);
    await deliverSessionMessages(session);
    await deliverSessionMessages(session);
    expect(targetCalls).toBe(3);

    // Now an edit referencing the failed target arrives.
    insertOutboundContent(
      'ag-1',
      session.id,
      'edit-doomed',
      { operation: 'stream_edit', targetMessageOutId: 'out-bad', text: 'too late' },
      '2026-01-01T00:00:10Z',
    );

    // Swap to a counting adapter so we can prove the edit never hits it.
    let editCalls = 0;
    setDeliveryAdapter({
      async deliver() {
        editCalls++;
        return 'plat';
      },
    });

    await deliverSessionMessages(session);
    expect(editCalls).toBe(0);

    // edit-doomed should now be in delivered (as failed), not pending retries.
    const inDb = openInboundDb('ag-1', session.id);
    const delivered = getDeliveredIds(inDb);
    inDb.close();
    expect(delivered.has('edit-doomed')).toBe(true);

    // Second drain is a no-op — confirms it's not re-attempted.
    await deliverSessionMessages(session);
    expect(editCalls).toBe(0);
  });
});

describe('deliverSessionMessages — permission check', () => {
  it('rejects delivery to an unauthorized channel destination', async () => {
    seedAgentAndChannel();

    // Create a second messaging group that the agent is NOT wired to
    createMessagingGroup({
      id: 'mg-2',
      channel_type: 'discord',
      platform_id: 'discord:456',
      name: 'Unauthorized Chat',
      is_group: 0,
      unknown_sender_policy: 'public',
      created_at: now(),
    });

    // Session is on mg-1 (telegram)
    const { session } = resolveSession('ag-1', 'mg-1', null, 'shared');

    // Insert an outbound message targeting mg-2 (discord) — not the origin chat
    const outDb = new Database(outboundDbPath('ag-1', session.id));
    outDb
      .prepare(
        `INSERT INTO messages_out (id, timestamp, kind, platform_id, channel_type, content)
       VALUES (?, datetime('now'), 'chat', 'discord:456', 'discord', ?)`,
      )
      .run('out-unauth', JSON.stringify({ text: 'sneaky' }));
    outDb.close();

    const calls: string[] = [];
    setDeliveryAdapter({
      async deliver(_ct, _pid, _tid, _kind, content) {
        calls.push(content);
        return 'plat-msg';
      },
    });

    // Deliver 3 times to exhaust retries
    await deliverSessionMessages(session);
    await deliverSessionMessages(session);
    await deliverSessionMessages(session);

    // Adapter never called — permission check throws before reaching it
    expect(calls).toHaveLength(0);

    // Message is marked as permanently failed
    const inDb = openInboundDb('ag-1', session.id);
    const delivered = getDeliveredIds(inDb);
    inDb.close();
    expect(delivered.has('out-unauth')).toBe(true);
  });
});
