import { describe, expect, it } from 'vitest';

import {
  getContainerImageBase,
  getDefaultContainerImage,
  getInstallSlug,
  getLaunchdLabel,
  getSystemdUnit,
} from './install-slug.js';

describe('install-slug per-checkout identifiers', () => {
  const root = '/home/user/nanoclaw';

  it('slug is deterministic per checkout path', () => {
    expect(getInstallSlug(root)).toBe(getInstallSlug(root));
    expect(getInstallSlug('/a')).not.toBe(getInstallSlug('/b'));
  });

  it('container image base derives from the per-checkout slug', () => {
    expect(getContainerImageBase(root)).toBe('nanoclaw-agent-v2-' + getInstallSlug(root));
    expect(getDefaultContainerImage(root)).toBe(getContainerImageBase(root) + ':latest');
  });

  it('systemd unit + launchd label derive from the per-checkout slug', () => {
    expect(getSystemdUnit(root)).toBe('nanoclaw-v2-' + getInstallSlug(root));
    expect(getLaunchdLabel(root)).toBe('com.nanoclaw-v2-' + getInstallSlug(root));
    expect(getSystemdUnit('/a')).not.toBe(getSystemdUnit('/b'));
    expect(getLaunchdLabel('/a')).not.toBe(getLaunchdLabel('/b'));
  });

  it('bash Makefile slug formula matches the TS helper (hash pinned)', () => {
    // Cross-language contract: the Makefile and this TS helper must both
    // compute sha1("<projectRoot>")[:8] for the SAME 8 hex chars. The
    // hardcoded reference value below was generated via:
    //   printf '/abs' | sha1sum | cut -c1-8   →  f2be0907
    // If the TS side ever changes input formatting (trailing newline, etc.)
    // this will trip — and so will the bash/Makefile mirror, since its
    // reference hash was computed the same way.
    expect(getInstallSlug('/abs')).toBe('f2be0907');
  });
});
