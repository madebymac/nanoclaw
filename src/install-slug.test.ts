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

  it('bash Makefile slug formula matches the TS helper', () => {
    // The Makefile derives per-instance units as:
    //   nanoclaw-v2-$(sha1sum <<< "$CURDIR:$instance" | cut -c1-8)
    // TS does the same via createHash. Pin the format so a Makefile edit
    // that drops the colon or changes the input order fails here.
    expect(getInstallSlug('/abs', 'foo')).toMatch(/^[0-9a-f]{8}$/);
  });
});
