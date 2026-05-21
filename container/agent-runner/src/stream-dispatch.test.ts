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

  test('extract returns trailing open block', () => {
    const ex = createStreamExtractor();
    const r = ex.extract('<message to="alice">hello wor');
    expect(r.newlyClosed).toEqual([]);
    expect(r.trailing).toEqual({ index: 0, to: 'alice', partialBody: 'hello wor' });
  });

  test('extract returns trailing after closed blocks', () => {
    const ex = createStreamExtractor();
    const r = ex.extract('<message to="alice">done</message><message to="bob">in pro');
    expect(r.newlyClosed).toEqual([{ index: 0, to: 'alice', body: 'done' }]);
    expect(r.trailing).toEqual({ index: 1, to: 'bob', partialBody: 'in pro' });
  });

  test('extract: trailing disappears once closed', () => {
    const ex = createStreamExtractor();
    let r = ex.extract('<message to="alice">part');
    expect(r.trailing).toEqual({ index: 0, to: 'alice', partialBody: 'part' });
    r = ex.extract('<message to="alice">partial done</message>');
    expect(r.newlyClosed).toEqual([{ index: 0, to: 'alice', body: 'partial done' }]);
    expect(r.trailing).toBeNull();
  });

  test('extract: text before open tag is not trailing', () => {
    const ex = createStreamExtractor();
    const r = ex.extract('<message to="a">done</message>  thinking out loud  ');
    expect(r.newlyClosed).toEqual([{ index: 0, to: 'a', body: 'done' }]);
    expect(r.trailing).toBeNull();
  });

  test('extract: partial open tag (no closing >) is not yet a trailing block', () => {
    const ex = createStreamExtractor();
    const r = ex.extract('thinking… <message to="a');
    expect(r.newlyClosed).toEqual([]);
    expect(r.trailing).toBeNull();
  });

  test('extract: trailing block index increments past prior closed blocks', () => {
    const ex = createStreamExtractor();
    ex.extract('<message to="a">first</message>');
    const r = ex.extract('<message to="a">first</message><message to="b">');
    expect(r.newlyClosed).toEqual([]);
    expect(r.trailing).toEqual({ index: 1, to: 'b', partialBody: '' });
  });
});
