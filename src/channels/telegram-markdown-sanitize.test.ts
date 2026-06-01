import { describe, it, expect } from 'vitest';
import { sanitizeTelegramLegacyMarkdown } from './telegram-markdown-sanitize.js';

describe('sanitizeTelegramLegacyMarkdown', () => {
  it('downgrades CommonMark **bold** to legacy *bold*', () => {
    expect(sanitizeTelegramLegacyMarkdown('**Host path**')).toBe('*Host path*');
  });

  it('downgrades CommonMark __bold__ to legacy _italic_', () => {
    expect(sanitizeTelegramLegacyMarkdown('__label__')).toBe('_label_');
  });

  it('leaves balanced legacy *bold* and _italic_ alone', () => {
    expect(sanitizeTelegramLegacyMarkdown('a *b* c _d_ e')).toBe('a *b* c _d_ e');
  });

  it('preserves inline code spans untouched', () => {
    const input = 'see `file_name.py` and `**not bold**` here';
    expect(sanitizeTelegramLegacyMarkdown(input)).toBe(input);
  });

  it('preserves fenced code blocks untouched', () => {
    const input = '```\nfoo_bar **baz**\n```';
    expect(sanitizeTelegramLegacyMarkdown(input)).toBe(input);
  });

  it('strips formatting chars on odd delimiter count (unbalanced *)', () => {
    expect(sanitizeTelegramLegacyMarkdown('a * b *c*')).toBe('a  b c');
  });

  it('strips formatting chars on odd delimiter count (unbalanced _)', () => {
    expect(sanitizeTelegramLegacyMarkdown('file_name has _one italic_')).toBe('filename has one italic');
  });

  it('strips brackets when unbalanced', () => {
    expect(sanitizeTelegramLegacyMarkdown('see [docs here')).toBe('see docs here');
  });

  it('leaves matched brackets (e.g. links) alone when counts balance', () => {
    const input = 'see [docs](https://example.com) for more';
    expect(sanitizeTelegramLegacyMarkdown(input)).toBe(input);
  });

  it('fixes the real failing message', () => {
    const input =
      'Sure! What do you want to mount, and where should it appear inside the container?\n\n' +
      '- **Host path** (on your machine): e.g. `~/projects/webapp`\n' +
      '- **Container path**: e.g. `workspace/webapp`\n' +
      '- **Read-only or read-write?**';
    const out = sanitizeTelegramLegacyMarkdown(input);
    expect(out).not.toContain('**');
    expect(out).toContain('*Host path*');
    expect(out).toContain('`~/projects/webapp`');
    expect((out.match(/\*/g) ?? []).length % 2).toBe(0);
  });

  it('is a no-op on empty string', () => {
    expect(sanitizeTelegramLegacyMarkdown('')).toBe('');
  });

  it('replaces dash list bullets with • so the adapter does not re-emit `*` markers', () => {
    expect(sanitizeTelegramLegacyMarkdown('- one\n- two')).toBe('• one\n• two');
  });

  it('preserves indented list structure', () => {
    expect(sanitizeTelegramLegacyMarkdown('  - nested')).toBe('  • nested');
  });

  it('flattens Markdown horizontal rules (---, ***, ___)', () => {
    const input = 'before\n---\n***\n___\nafter';
    expect(sanitizeTelegramLegacyMarkdown(input)).toBe('before\n⎯⎯⎯\n⎯⎯⎯\n⎯⎯⎯\nafter');
  });

  it('leaves horizontal rules inside code blocks alone', () => {
    const input = '```\n---\n```';
    expect(sanitizeTelegramLegacyMarkdown(input)).toBe(input);
  });

  it('strips emphasis that wraps an inline-code span (Telegram cannot nest entities)', () => {
    // Telegram rejects `*...`code`...*` with "can't parse entities" and drops
    // the message. Degrade to plain text, keep the code span intact.
    const out = sanitizeTelegramLegacyMarkdown('**set `NO_PROXY=a,b` in config**');
    expect(out).toBe('set `NO_PROXY=a,b` in config');
  });

  it('strips emphasis wrapping code even when the code holds a literal * (odd count)', () => {
    const out = sanitizeTelegramLegacyMarkdown("**use `--noproxy '*'` here**");
    expect(out).toBe("use `--noproxy '*'` here");
  });

  it('leaves sibling code + emphasis intact (no false positive)', () => {
    const input = 'see `file_name` and _this_ here';
    expect(sanitizeTelegramLegacyMarkdown(input)).toBe(input);
  });

  it('produces balanced delimiters for the real dropped reply', () => {
    // Verbatim shape of the message Telegram rejected at byte offset 236.
    const input =
      'Good question:\n\n' +
      "1. **My notes say to use `--noproxy '*'`** — see `CLAUDE.local.md`.\n\n" +
      '2. **The fix: set `NO_PROXY=api.github.com,github.com` as an env var.** Works at the OS level.';
    const out = sanitizeTelegramLegacyMarkdown(input);
    expect(out).not.toContain('**');
    // Code spans (and their literal *) survive untouched.
    expect(out).toContain("`--noproxy '*'`");
    expect(out).toContain('`NO_PROXY=api.github.com,github.com`');
    // Outside code spans, no emphasis delimiters remain — so Telegram has no
    // entity to choke on. (The only surviving `*` is the literal inside code.)
    const outsideCode = out.replace(/`[^`\n]*`/g, '');
    expect(outsideCode).not.toMatch(/[*_]/);
  });
});
