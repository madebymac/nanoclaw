/**
 * Channel-account identity helpers.
 *
 * Single-instance multi-bot is modelled by giving each standalone bot its own
 * `channel_type` value of the form `<family>#<slug>` (e.g. `telegram#andy`).
 * The whole pipeline (registry, messaging_groups, router, delivery, session
 * routing) already keys on the opaque `channel_type` string, so encoding the
 * account into it makes `(channel_type, platform_id)` unique per bot with no
 * schema-wide rewrite.
 *
 * A handful of places need the channel FAMILY rather than the per-bot account:
 *   - user-id namespacing (a person is the same human across every bot, so
 *     their id stays `telegram:<handle>`, not `telegram#andy:<handle>`),
 *   - any platform-family behaviour switch.
 * Those call `channelFamily()`. Everything else treats `channel_type` opaquely.
 *
 * The separator is `#` deliberately: `platform_id` uses `:` (`telegram:<chatId>`),
 * so `#` can never collide with a platform id, and a legacy single-bot
 * `channel_type` of `telegram` (no `#`) is its own family — fully backward
 * compatible.
 */

export const CHANNEL_ACCOUNT_SEPARATOR = '#';

/** The platform family for a channel_type value. `telegram#andy` → `telegram`. */
export function channelFamily(channelType: string): string {
  const idx = channelType.indexOf(CHANNEL_ACCOUNT_SEPARATOR);
  return idx === -1 ? channelType : channelType.slice(0, idx);
}

/** The per-bot account slug, or null for a legacy/default (family-only) channel_type. */
export function channelAccountSlug(channelType: string): string | null {
  const idx = channelType.indexOf(CHANNEL_ACCOUNT_SEPARATOR);
  return idx === -1 ? null : channelType.slice(idx + 1);
}

/** Compose a channel_type from a family and optional account slug. */
export function channelType(family: string, slug?: string | null): string {
  return slug ? `${family}${CHANNEL_ACCOUNT_SEPARATOR}${slug}` : family;
}

const SLUG_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/;

/** Validate an account slug — same charset rules as agent folders / ids. */
export function isValidAccountSlug(slug: string): boolean {
  return SLUG_RE.test(slug);
}
