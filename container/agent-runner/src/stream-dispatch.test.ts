import { describe, expect, test } from 'bun:test';

import { createStreamExtractor, detectOpenBlock } from './stream-dispatch.js';

describe('createStreamExtractor', () => {
  test('returns no blocks when none are closed yet', () => {
    const ex = createStreamExtractor();
    expect(ex.extractNewlyClosed('<message to="user">hello wor')).toEqual([]);
    expect(ex.count()).toBe(0);
  });

  test('returns a block once it closes', () => {
    const ex = createStreamExtractor();
    expect(ex.extractNewlyClosed('<message to="user">hello')).toEqual([]);
    const out = ex.extractNewlyClosed('<message to="user">hello</message>');
    expect(out).toEqual([{ index: 0, to: 'user', body: 'hello' }]);
    expect(ex.count()).toBe(1);
  });

  test('returns only newly-closed blocks across calls', () => {
    const ex = createStreamExtractor();
    expect(
      ex.extractNewlyClosed('<message to="user">first</message><message to="user">second</message>'),
    ).toEqual([
      { index: 0, to: 'user', body: 'first' },
      { index: 1, to: 'user', body: 'second' },
    ]);
    expect(ex.extractNewlyClosed('<message to="user">first</message><message to="user">second</message>')).toEqual([]);
    const out = ex.extractNewlyClosed(
      '<message to="user">first</message><message to="user">second</message><message to="user">third</message>',
    );
    expect(out).toEqual([{ index: 2, to: 'user', body: 'third' }]);
  });

  test('ignores partial trailing block but still returns earlier closed ones', () => {
    const ex = createStreamExtractor();
    const out = ex.extractNewlyClosed('<message to="a">done</message><message to="b">in prog');
    expect(out).toEqual([{ index: 0, to: 'a', body: 'done' }]);
    expect(ex.count()).toBe(1);
  });

  test('trims block body whitespace', () => {
    const ex = createStreamExtractor();
    const out = ex.extractNewlyClosed('<message to="user">\n  hello  \n</message>');
    expect(out).toEqual([{ index: 0, to: 'user', body: 'hello' }]);
  });

  test('handles multiple destinations', () => {
    const ex = createStreamExtractor();
    const out = ex.extractNewlyClosed(
      'noise <message to="alice">hi</message> noise <message to="bob">there</message>',
    );
    expect(out).toEqual([
      { index: 0, to: 'alice', body: 'hi' },
      { index: 1, to: 'bob', body: 'there' },
    ]);
  });
});

describe('detectOpenBlock', () => {
  test('returns null for plain scratchpad', () => {
    expect(detectOpenBlock('thinking out loud', 0)).toBeNull();
  });

  test('returns the trailing open block when no blocks have closed', () => {
    expect(detectOpenBlock('<message to="user">hello wor', 0)).toEqual({
      index: 0,
      to: 'user',
      body: 'hello wor',
    });
  });

  test('returns null when the only block has already closed', () => {
    expect(detectOpenBlock('<message to="user">done</message>', 1)).toBeNull();
  });

  test('returns the open block after one or more closed blocks, with correct index', () => {
    const text = '<message to="alice">hi</message> aside <message to="bob">in prog';
    expect(detectOpenBlock(text, 1)).toEqual({ index: 1, to: 'bob', body: 'in prog' });
  });

  test('preserves untrimmed body so callers can throttle on real char delta', () => {
    expect(detectOpenBlock('<message to="user">\n  hello  ', 0)).toEqual({
      index: 0,
      to: 'user',
      body: '\n  hello  ',
    });
  });
});
