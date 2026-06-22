import { describe, expect, it, vi } from 'vitest';

import {
  fixProxyGatewayPort,
  GH_TOKEN_LIFETIME_MS,
  GH_TOKEN_REFRESH_THRESHOLD_MS,
  maybeRefreshGithubToken,
  resolveProviderName,
} from './container-runner.js';

describe('resolveProviderName', () => {
  it('prefers session over container config', () => {
    expect(resolveProviderName('codex', 'claude')).toBe('codex');
  });

  it('falls back to container config when session is null', () => {
    expect(resolveProviderName(null, 'opencode')).toBe('opencode');
  });

  it('defaults to claude when nothing is set', () => {
    expect(resolveProviderName(null, undefined)).toBe('claude');
  });

  it('lowercases the resolved name', () => {
    expect(resolveProviderName('CODEX', null)).toBe('codex');
    expect(resolveProviderName(null, 'Claude')).toBe('claude');
  });

  it('treats empty string as unset (falls through)', () => {
    expect(resolveProviderName('', 'opencode')).toBe('opencode');
    expect(resolveProviderName(null, '')).toBe('claude');
  });
});

describe('fixProxyGatewayPort', () => {
  it('rewrites :10255 → app_port+1 for the review instance', () => {
    const args = ['-e', 'HTTPS_PROXY=http://x:tok@host.docker.internal:10255'];
    fixProxyGatewayPort(args, 'http://172.17.0.1:10354/');
    expect(args[1]).toBe('HTTPS_PROXY=http://x:tok@host.docker.internal:10355');
  });

  it('rewrites :10255 → app_port+1 for the general instance', () => {
    const args = ['-e', 'HTTPS_PROXY=http://x:tok@host.docker.internal:10255'];
    fixProxyGatewayPort(args, 'http://172.17.0.1:10454');
    expect(args[1]).toBe('HTTPS_PROXY=http://x:tok@host.docker.internal:10455');
  });

  it('rewrites all four proxy key casings in a single pass', () => {
    const args = [
      '-e',
      'HTTPS_PROXY=http://x:tok@host.docker.internal:10255',
      '--name',
      'something',
      '-e',
      'HTTP_PROXY=http://x:tok@host.docker.internal:10255',
      '-e',
      'https_proxy=http://x:tok@host.docker.internal:10255',
      '-e',
      'http_proxy=http://x:tok@host.docker.internal:10255',
    ];
    fixProxyGatewayPort(args, 'http://172.17.0.1:10354');
    expect(args[1]).toBe('HTTPS_PROXY=http://x:tok@host.docker.internal:10355');
    expect(args[5]).toBe('HTTP_PROXY=http://x:tok@host.docker.internal:10355');
    expect(args[7]).toBe('https_proxy=http://x:tok@host.docker.internal:10355');
    expect(args[9]).toBe('http_proxy=http://x:tok@host.docker.internal:10355');
  });

  it('no-op for single-instance (app port 10254 → expected proxy port 10255)', () => {
    const before = ['-e', 'HTTPS_PROXY=http://x:tok@host.docker.internal:10255'];
    const args = [...before];
    fixProxyGatewayPort(args, 'http://127.0.0.1:10254');
    expect(args).toEqual(before);
  });

  it('does not touch :10255-looking sequences embedded mid-path or in query', () => {
    const args = ['-e', 'HTTPS_PROXY=http://x:tok@host.docker.internal:10255/v1/10255-thing?n=10255'];
    fixProxyGatewayPort(args, 'http://172.17.0.1:10354');
    // Only the port boundary should match; the path and query literal stay put.
    expect(args[1]).toBe('HTTPS_PROXY=http://x:tok@host.docker.internal:10355/v1/10255-thing?n=10255');
  });

  it('ignores -e args whose key is not a recognized proxy env var', () => {
    const args = ['-e', 'FOO_PROXY=http://x:tok@host.docker.internal:10255', '-e', 'NOT_A_PROXY=:10255'];
    fixProxyGatewayPort(args, 'http://172.17.0.1:10354');
    expect(args[1]).toBe('FOO_PROXY=http://x:tok@host.docker.internal:10255');
    expect(args[3]).toBe('NOT_A_PROXY=:10255');
  });

  it('no-op when ONECLI_URL is unparseable', () => {
    const before = ['-e', 'HTTPS_PROXY=http://x:tok@host.docker.internal:10255'];
    const args = [...before];
    fixProxyGatewayPort(args, 'not-a-url');
    expect(args).toEqual(before);
  });

  it('no-op when ONECLI_URL has no port', () => {
    const before = ['-e', 'HTTPS_PROXY=http://x:tok@host.docker.internal:10255'];
    const args = [...before];
    fixProxyGatewayPort(args, 'http://example.com/');
    expect(args).toEqual(before);
  });

  it('does not touch args from the OneCLI `-e KEY VALUE` (space-separated) shape', () => {
    // OneCLI today emits `-e KEY=VALUE`. If it ever switches to space-
    // separated args this function should no-op (and warn) rather than
    // misinterpret `VALUE` as a key.
    const before = ['-e', 'HTTPS_PROXY', 'http://x:tok@host.docker.internal:10255'];
    const args = [...before];
    fixProxyGatewayPort(args, 'http://172.17.0.1:10354');
    expect(args).toEqual(before);
  });
});

describe('GH_TOKEN refresh constants', () => {
  it('exports the correct lifetime and threshold values', () => {
    expect(GH_TOKEN_LIFETIME_MS).toBe(60 * 60 * 1000);
    expect(GH_TOKEN_REFRESH_THRESHOLD_MS).toBe(5 * 60 * 1000);
  });

  it('refresh window starts at 55 minutes after mint', () => {
    const refreshWindowMs = GH_TOKEN_LIFETIME_MS - GH_TOKEN_REFRESH_THRESHOLD_MS;
    expect(refreshWindowMs).toBe(55 * 60 * 1000);
  });
});

describe('maybeRefreshGithubToken', () => {
  it('is a no-op when no active container matches the sessionId', () => {
    // No container has been spawned in this test process, so the activeContainers
    // Map is empty. The function must not throw.
    expect(() => {
      maybeRefreshGithubToken('agent-group-123', 'session-999-does-not-exist');
    }).not.toThrow();
  });

  it('is callable from the host-sweep import path (smoke test)', () => {
    // Verify the function is exported and importable so the sweep can call it.
    expect(typeof maybeRefreshGithubToken).toBe('function');
  });
});
