/**
 * Matty channel — lets the Matty app on the same host talk to an agent over a
 * Unix socket, e.g. for food estimates from its Describe tab.
 *
 * Same shape as the CLI channel, with its own socket (`data/matty.sock`) and
 * platform id so it never evicts a terminal chat or shares its session.
 * Access control is the filesystem: the socket is chmod 0600, so only the
 * owner (the user Matty runs as) can connect. No network port, no token.
 *
 * Wire format: one JSON object per line.
 *
 *   Client → server:  { "text": "message" }
 *   Server → client:  { "text": "agent reply" }
 *
 * Replies go to the connection that most recently sent a message. The agent
 * may answer late or more than once, so correlating a reply with its request
 * is the client's job (Matty puts an id in the prompt and checks it comes
 * back). deliver() no-ops when nobody is connected; the outbound row is
 * already persisted.
 *
 * Wiring (once): a messaging group `matty` / `app` with
 * `--unknown-sender-policy public` (the socket permissions already gate who
 * can send), wired to a dedicated agent group with `--engage-mode pattern
 * --engage-pattern .`.
 */
import fs from 'fs';
import net from 'net';
import path from 'path';

import { DATA_DIR } from '../config.js';
import { log } from '../log.js';
import type { ChannelAdapter, ChannelSetup, OutboundMessage } from './adapter.js';
import { registerChannelAdapter } from './channel-registry.js';

export const MATTY_PLATFORM_ID = 'app';

export function mattySocketPath(): string {
  return path.join(DATA_DIR, 'matty.sock');
}

export function createMattyAdapter(sock: string = mattySocketPath()): ChannelAdapter {
  let server: net.Server | null = null;
  let client: net.Socket | null = null;

  function handleConnection(socket: net.Socket, config: ChannelSetup): void {
    let buffer = '';
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      let idx: number;
      while ((idx = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, idx).trim();
        buffer = buffer.slice(idx + 1);
        if (line) void handleLine(socket, line, config);
      }
    });
    socket.on('close', () => {
      if (client === socket) client = null;
    });
    socket.on('error', (err) => log.warn('Matty client socket error', { err }));
  }

  async function handleLine(socket: net.Socket, line: string, config: ChannelSetup): Promise<void> {
    let payload: { text?: unknown };
    try {
      payload = JSON.parse(line);
    } catch {
      log.warn('Matty: ignoring non-JSON line from client');
      return;
    }
    if (typeof payload.text !== 'string' || payload.text.length === 0) return;

    client = socket;
    try {
      await config.onInbound(MATTY_PLATFORM_ID, null, {
        id: `matty-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        kind: 'chat',
        timestamp: new Date().toISOString(),
        content: { text: payload.text, sender: 'matty', senderId: `matty:${MATTY_PLATFORM_ID}` },
      });
    } catch (err) {
      log.error('Matty: onInbound threw', { err });
    }
  }

  return {
    name: 'matty',
    channelType: 'matty',
    supportsThreads: false,

    async setup(config: ChannelSetup): Promise<void> {
      // A crashed run can leave the socket file behind, and bind refuses an existing path.
      try {
        fs.unlinkSync(sock);
      } catch (err) {
        const e = err as NodeJS.ErrnoException;
        if (e.code !== 'ENOENT') log.warn('Failed to unlink stale Matty socket (will try to bind anyway)', { sock, err });
      }

      server = net.createServer((socket) => handleConnection(socket, config));
      await new Promise<void>((resolve, reject) => {
        server!.once('error', reject);
        server!.listen(sock, () => {
          try {
            fs.chmodSync(sock, 0o600);
          } catch (err) {
            log.warn('Failed to chmod Matty socket (continuing)', { sock, err });
          }
          log.info('Matty channel listening', { sock });
          resolve();
        });
      });
    },

    async teardown(): Promise<void> {
      if (client) {
        try {
          client.end();
        } catch {
          // best-effort
        }
        client = null;
      }
      if (server) {
        await new Promise<void>((resolve) => server!.close(() => resolve()));
        server = null;
      }
      try {
        fs.unlinkSync(sock);
      } catch {
        // best-effort
      }
    },

    isConnected(): boolean {
      return server !== null;
    },

    async deliver(platformId, _threadId, message: OutboundMessage): Promise<string | undefined> {
      if (platformId !== MATTY_PLATFORM_ID || !client) return undefined;
      const text = extractText(message);
      if (text === null) return undefined;
      try {
        client.write(JSON.stringify({ text }) + '\n');
      } catch (err) {
        log.warn('Failed to write to Matty client', { err });
      }
      return undefined;
    },
  };
}

function extractText(message: OutboundMessage): string | null {
  const content = message.content as Record<string, unknown> | string | undefined;
  if (typeof content === 'string') return content;
  if (content && typeof content === 'object' && typeof content.text === 'string') return content.text;
  return null;
}

registerChannelAdapter('matty', { factory: () => createMattyAdapter() });
