import { describe, expect, test } from 'bun:test';

import { createStreamExtractor } from './stream-dispatch.js';

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
