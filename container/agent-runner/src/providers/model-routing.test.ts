import { describe, expect, it } from 'bun:test';
import { extractRoutableText, resolveAutoModel } from './model-routing.js';

const HAIKU = 'claude-haiku-4-5-20251001';
const SONNET = 'claude-sonnet-4-6';

/** Wrap text the way formatter.ts wraps a single inbound chat message. */
function envelope(text: string): string {
  const escaped = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  return (
    '<context timezone="Europe/London" />\n' +
    `<message id="42" from="telegram:general" sender="Matty" time="Tue 15 Jul, 09:30">${escaped}</message>`
  );
}

describe('extractRoutableText', () => {
  it('strips the formatter envelope down to the message text', () => {
    expect(extractRoutableText(envelope('hello there'))).toBe('hello there');
  });

  it('unescapes XML entities from the formatter', () => {
    expect(extractRoutableText(envelope('a < b && c > "d"'))).toBe('a < b && c > "d"');
  });

  it('keeps quoted-message text but drops its markup', () => {
    const prompt =
      '<context timezone="UTC" />\n' +
      '<message id="1" sender="A" time="t">\n' +
      '  <quoted_message from="B">original question</quoted_message>\n' +
      'my reply</message>';
    expect(extractRoutableText(prompt)).toBe('original question my reply');
  });
});

describe('resolveAutoModel', () => {
  it('returns Haiku for a short greeting', () => {
    expect(resolveAutoModel(envelope('Hello, how are you?'))).toBe(HAIKU);
  });

  it('returns Haiku for a short conversational question', () => {
    expect(resolveAutoModel(envelope('What time is it in Tokyo?'))).toBe(HAIKU);
  });

  it('returns Sonnet for the "review" keyword', () => {
    expect(resolveAutoModel(envelope('Can you review this code?'))).toBe(SONNET);
  });

  it('returns Sonnet for the "implement" keyword', () => {
    expect(resolveAutoModel(envelope('Implement a rate limiter'))).toBe(SONNET);
  });

  it('returns Sonnet when the message text itself exceeds the threshold', () => {
    expect(resolveAutoModel(envelope('a'.repeat(401)))).toBe(SONNET);
  });

  it('returns Haiku for a short prompt with no complex keywords', () => {
    expect(resolveAutoModel(envelope('What is 2 + 2?'))).toBe(HAIKU);
  });

  it('returns Sonnet for "debug" keyword regardless of length', () => {
    expect(resolveAutoModel(envelope('debug this'))).toBe(SONNET);
  });

  it('returns Sonnet for stem matches (analyz/creat/migrat/optimiz/generat)', () => {
    expect(resolveAutoModel(envelope('analyze this'))).toBe(SONNET);
    expect(resolveAutoModel(envelope('create a function'))).toBe(SONNET);
    expect(resolveAutoModel(envelope('migrate the database'))).toBe(SONNET);
    expect(resolveAutoModel(envelope('optimize this query'))).toBe(SONNET);
    expect(resolveAutoModel(envelope('generate a report'))).toBe(SONNET);
  });

  // The July 2026 cost regression: routing ran against the raw formatted
  // prompt, so envelope ballast counted toward the 400-char threshold and a
  // batch of trivial chat messages routed to the expensive tier.
  it('ignores envelope ballast when measuring length', () => {
    const prompt =
      '<context timezone="Europe/London" />\n' +
      '<messages>\n' +
      '<message id="101" from="telegram:general" sender="Matty MacLean-Bennett" time="Tue 15 Jul, 09:35">morning</message>\n' +
      '<message id="102" from="telegram:general" sender="Matty MacLean-Bennett" time="Tue 15 Jul, 09:36">you around?</message>\n' +
      '<message id="103" from="telegram:general" sender="Andy the Agent" time="Tue 15 Jul, 09:37" reply_to="102">yep</message>\n' +
      '</messages>';
    expect(prompt.length).toBeGreaterThan(400);
    expect(resolveAutoModel(prompt)).toBe(HAIKU);
  });

  it('does not treat envelope attribute words as routing keywords', () => {
    // A sender literally named "Review Bot" must not force the complex tier.
    const prompt =
      '<context timezone="UTC" />\n' +
      '<message id="7" from="telegram:general" sender="Review Bot" time="Tue 15 Jul, 09:30">ok</message>';
    expect(resolveAutoModel(prompt)).toBe(HAIKU);
  });
});
