import fs from 'fs';
import net from 'net';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ChannelAdapter, ChannelSetup, InboundMessage } from './adapter.js';
import { createMattyAdapter } from './matty.js';

let dir: string;
let sock: string;
let adapter: ChannelAdapter;
let inbound: { platformId: string; threadId: string | null; message: InboundMessage }[];

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-matty-'));
  sock = path.join(dir, 'matty.sock');
  inbound = [];
  adapter = createMattyAdapter(sock);
  const setup: ChannelSetup = {
    onInbound: (platformId: string, threadId: string | null, message: InboundMessage) => {
      inbound.push({ platformId, threadId, message });
    },
    onInboundEvent: vi.fn(),
    onMetadata: vi.fn(),
    onAction: vi.fn(),
  };
  await adapter.setup(setup);
});

afterEach(async () => {
  await adapter.teardown();
  fs.rmSync(dir, { recursive: true, force: true });
});

const connect = () =>
  new Promise<net.Socket>((resolve) => {
    const s = net.connect(sock, () => resolve(s));
  });
const nextLine = (s: net.Socket) =>
  new Promise<string>((resolve) => {
    let buf = '';
    s.on('data', (d) => {
      buf += d.toString();
      if (buf.includes('\n')) resolve(buf.slice(0, buf.indexOf('\n')));
    });
  });
const until = async (cond: () => boolean) => {
  for (let i = 0; i < 100 && !cond(); i++) await new Promise((r) => setTimeout(r, 10));
};

describe('matty channel', () => {
  it('is owner-only', () => {
    expect(fs.statSync(sock).mode & 0o777).toBe(0o600);
    expect(adapter.isConnected()).toBe(true);
  });

  it('hands a line to the router as a message from the matty app', async () => {
    const c = await connect();
    c.write(JSON.stringify({ text: 'two eggs' }) + '\n');
    await until(() => inbound.length > 0);
    expect(inbound[0]!.platformId).toBe('app');
    expect(inbound[0]!.threadId).toBeNull();
    expect(inbound[0]!.message.content).toEqual({ text: 'two eggs', sender: 'matty', senderId: 'matty:app' });
    c.destroy();
  });

  it('ignores junk and empty messages', async () => {
    const c = await connect();
    c.write('not json\n' + JSON.stringify({ text: '' }) + '\n' + JSON.stringify({ nope: 1 }) + '\n' + JSON.stringify({ text: 'ok' }) + '\n');
    await until(() => inbound.length > 0);
    expect(inbound).toHaveLength(1);
    c.destroy();
  });

  it('sends replies to the connection that last wrote, for its own platform only', async () => {
    const c = await connect();
    c.write(JSON.stringify({ text: 'hi' }) + '\n');
    await until(() => inbound.length > 0);
    const line = nextLine(c);
    await adapter.deliver('elsewhere', null, { kind: 'chat', content: { text: 'wrong place' } });
    await adapter.deliver('app', null, { kind: 'chat', content: { text: 'hello' } });
    expect(JSON.parse(await line)).toEqual({ text: 'hello' });
    c.destroy();
  });

  it('drops a reply when nobody is connected', async () => {
    await expect(adapter.deliver('app', null, { kind: 'chat', content: { text: 'late' } })).resolves.toBeUndefined();
  });

  it('removes its socket on teardown', async () => {
    await adapter.teardown();
    expect(fs.existsSync(sock)).toBe(false);
  });
});
