import { describe, it, expect } from 'vitest';

import { channelAccountSlug, channelFamily, channelType, isValidAccountSlug } from './channel-family.js';

describe('channel-family', () => {
  it('extracts the family from an account-scoped channel_type', () => {
    expect(channelFamily('telegram#andy')).toBe('telegram');
    expect(channelFamily('telegram#bot_2')).toBe('telegram');
  });

  it('treats a legacy family-only channel_type as its own family', () => {
    expect(channelFamily('telegram')).toBe('telegram');
    expect(channelFamily('slack')).toBe('slack');
  });

  it('extracts the account slug, or null when family-only', () => {
    expect(channelAccountSlug('telegram#andy')).toBe('andy');
    expect(channelAccountSlug('telegram')).toBeNull();
  });

  it('composes channel_type from family + optional slug', () => {
    expect(channelType('telegram', 'andy')).toBe('telegram#andy');
    expect(channelType('telegram')).toBe('telegram');
    expect(channelType('telegram', null)).toBe('telegram');
  });

  it('round-trips compose → family/slug', () => {
    const ct = channelType('telegram', 'andy');
    expect(channelFamily(ct)).toBe('telegram');
    expect(channelAccountSlug(ct)).toBe('andy');
  });

  it('does not collide with platform_id colon namespacing', () => {
    // platform_id uses ':' (telegram:<chatId>); the account separator is '#'
    // so a family-only channel_type can never be mistaken for a platform id.
    expect(channelFamily('telegram')).toBe('telegram');
    expect(channelAccountSlug('telegram')).toBeNull();
  });

  it('validates account slugs', () => {
    expect(isValidAccountSlug('andy')).toBe(true);
    expect(isValidAccountSlug('bot-2')).toBe(true);
    expect(isValidAccountSlug('a_b')).toBe(true);
    expect(isValidAccountSlug('-bad')).toBe(false);
    expect(isValidAccountSlug('Bad')).toBe(false);
    expect(isValidAccountSlug('has space')).toBe(false);
    expect(isValidAccountSlug('')).toBe(false);
  });
});
