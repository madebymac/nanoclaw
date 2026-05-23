import { describe, expect, it } from 'vitest';

import { decideUpgrade } from './self-upgrade.js';

const A = 'aaaaaaa1111111111111111111111111111aaaaa';
const B = 'bbbbbbb2222222222222222222222222222bbbbb';

describe('decideUpgrade', () => {
  it('skips when working tree is dirty, even if upstream advanced', () => {
    expect(decideUpgrade({ localHead: A, upstreamHead: B, isFastForward: true, workingTreeDirty: true })).toEqual({
      action: 'skip',
      reason: 'working-tree-dirty',
    });
  });

  it('skips when local matches upstream', () => {
    expect(decideUpgrade({ localHead: A, upstreamHead: A, isFastForward: true, workingTreeDirty: false })).toEqual({
      action: 'skip',
      reason: 'up-to-date',
    });
  });

  it('skips when fork has diverged (not fast-forwardable)', () => {
    expect(
      decideUpgrade({
        localHead: A,
        upstreamHead: B,
        isFastForward: false,
        workingTreeDirty: false,
      }),
    ).toEqual({ action: 'skip', reason: 'not-fast-forward' });
  });

  it('triggers when local is strictly behind a fast-forwardable upstream', () => {
    expect(
      decideUpgrade({
        localHead: A,
        upstreamHead: B,
        isFastForward: true,
        workingTreeDirty: false,
      }),
    ).toEqual({ action: 'upgrade', from: A, to: B });
  });
});
