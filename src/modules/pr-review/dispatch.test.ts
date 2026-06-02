import Database from 'better-sqlite3';
import fs from 'fs';
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';

import { dispatchReview } from './dispatch.js';
import { initTestDb, closeDb, runMigrations, createAgentGroup } from '../../db/index.js';
import { createSession } from '../../db/sessions.js';
import { initSessionFolder, inboundDbPath } from '../../session-manager.js';
import type { Session } from '../../types.js';

vi.mock('../../container-runner.js', () => ({
  wakeContainer: vi.fn().mockResolvedValue(undefined),
  isContainerRunning: vi.fn().mockReturnValue(false),
  getActiveContainerCount: vi.fn().mockReturnValue(0),
  killContainer: vi.fn(),
}));

vi.mock('../../config.js', async () => {
  const actual = await vi.importActual('../../config.js');
  return { ...actual, DATA_DIR: '/tmp/nanoclaw-test-pr-review' };
});

import { wakeContainer } from '../../container-runner.js';

const TEST_DIR = '/tmp/nanoclaw-test-pr-review';
const AGENT = 'ag-review';

function readInbound(agentGroupId: string, sessionId: string) {
  const db = new Database(inboundDbPath(agentGroupId, sessionId), { readonly: true });
  const rows = db
    .prepare('SELECT kind, platform_id, channel_type, content, trigger AS trig FROM messages_in ORDER BY seq')
    .all() as Array<{ kind: string; platform_id: string | null; channel_type: string | null; content: string; trig: number }>;
  db.close();
  return rows;
}

describe('dispatchReview', () => {
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

  it('injects a review task into the agent session and wakes the container', async () => {
    createAgentGroup({ id: AGENT, name: 'review', folder: 'review', agent_provider: null, created_at: new Date().toISOString() });
    const sess: Session = {
      id: 'sess-review',
      agent_group_id: AGENT,
      messaging_group_id: null,
      thread_id: null,
      agent_provider: null,
      status: 'active',
      container_status: 'stopped',
      last_active: null,
      created_at: new Date().toISOString(),
    };
    createSession(sess);
    initSessionFolder(AGENT, sess.id);

    await dispatchReview(AGENT, {
      fullName: 'acme/widgets',
      number: 42,
      title: 'Add the thing',
      author: 'octocat',
      htmlUrl: 'https://github.com/acme/widgets/pull/42',
    });

    const rows = readInbound(AGENT, sess.id);
    expect(rows).toHaveLength(1);
    expect(rows[0].kind).toBe('task');
    expect(rows[0].trig).toBe(1);
    expect(rows[0].platform_id).toBeNull();
    expect(rows[0].channel_type).toBeNull();
    const content = JSON.parse(rows[0].content);
    expect(content.source).toBe('pr-review-cron');
    expect(content.prompt).toContain('acme/widgets');
    expect(content.prompt).toContain('#42');
    expect(content.prompt).toContain('https://github.com/acme/widgets/pull/42');
    expect(wakeContainer).toHaveBeenCalledTimes(1);
  });
});
