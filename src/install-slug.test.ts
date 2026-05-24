import { describe, expect, it } from 'vitest';

import { getContainerImageBase, getInstallSlug, getLaunchdLabel, getSystemdUnit } from './install-slug.js';

describe('install-slug instance discriminator', () => {
  const root = '/home/user/nanoclaw';

  it('different instances on the same checkout produce different slugs', () => {
    const review = getInstallSlug(root, 'review');
    const general = getInstallSlug(root, 'general');
    expect(review).not.toBe(general);
  });

  it('empty instance equals the legacy single-install slug (back-compat)', () => {
    // The legacy slug was sha1(projectRoot)[:8] with no instance suffix.
    // Single-install callers (NCL_INSTANCE unset) must keep that exact
    // value so existing systemd units / plists / container labels keep
    // resolving after this PR.
    expect(getInstallSlug(root, '')).toBe(getInstallSlug(root));
  });

  it('container image base is per-checkout only, NOT instance-scoped', () => {
    // Two instances on the same checkout share one built image; one
    // `./container/build.sh` serves both. If this invariant ever
    // changes, deploy times double.
    expect(getContainerImageBase(root)).toBe('nanoclaw-agent-v2-' + getInstallSlug(root, ''));
    // Image base ignores any NCL_INSTANCE — the helper signature doesn't
    // even accept an instance arg.
  });

  it('systemd unit + launchd label change with instance', () => {
    expect(getSystemdUnit(root, 'review')).not.toBe(getSystemdUnit(root, 'general'));
    expect(getLaunchdLabel(root, 'review')).not.toBe(getLaunchdLabel(root, 'general'));
    // And single-install equals the legacy name.
    expect(getSystemdUnit(root, '')).toBe(getSystemdUnit(root));
    expect(getLaunchdLabel(root, '')).toBe(getLaunchdLabel(root));
  });

  it('bash Makefile slug formula matches the TS helper (hash pinned)', () => {
    // Cross-language contract: the Makefile, install-slug.sh, and this TS
    // helper must all compute sha1("<projectRoot>:<instance>")[:8] (or
    // sha1(projectRoot)[:8] when instance is empty) for the SAME 8 hex
    // chars. Hardcoded reference values below were generated via:
    //   printf '/abs:foo' | sha1sum | cut -c1-8   →  6d93cda5
    //   printf '/abs'     | sha1sum | cut -c1-8   →  f2be0907
    // If the TS side ever changes input formatting (separator, order,
    // trailing newline) these will trip — and so will the bash/Makefile
    // mirror, since their reference hashes were computed the same way.
    expect(getInstallSlug('/abs', 'foo')).toBe('6d93cda5');
    expect(getInstallSlug('/abs', '')).toBe('f2be0907');
    expect(getInstallSlug('/abs')).toBe('f2be0907');
  });
});
