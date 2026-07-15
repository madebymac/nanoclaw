import { afterEach, describe, expect, it } from 'bun:test';

import {
  AUTO_ROUTE_DEFAULT_MODEL,
  AUTO_ROUTE_HEAVY_MODEL,
  HEAVY_ROUTE_COOLDOWN_MS,
  extractRoutableText,
  isHeavyRouteDisabled,
  markHeavyRouteFailure,
  resetHeavyRouteCooldown,
  resolveAutoModel,
} from './model-routing.js';

/** Wrap text the way formatter.ts does for a single chat message. */
function envelope(text: string): string {
  const escaped = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  return (
    '<context timezone="Europe/London" />\n' +
    `<message id="42" from="telegram:general" sender="Matty" time="Tue 15 Jul, 09:30">${escaped}</message>`
  );
}

afterEach(() => {
  resetHeavyRouteCooldown();
});

describe('extractRoutableText', () => {
  it('strips the formatter envelope down to the message text', () => {
    expect(extractRoutableText(envelope('hello there'))).toBe('hello there');
  });

  it('unescapes XML entities from the formatter', () => {
    expect(extractRoutableText(envelope('a < b && c > "d"'))).toBe('a < b && c > "d"');
  });

  it('keeps quoted-message context text but drops its markup', () => {
    const prompt =
      '<context timezone="UTC" />\n' +
      '<message id="1" sender="A" time="t">\n' +
      '  <quoted_message from="B">original question</quoted_message>\n' +
      'my reply</message>';
    expect(extractRoutableText(prompt)).toBe('original question my reply');
  });
});

describe('resolveAutoModel', () => {
  it('routes short conversational turns to the default model', () => {
    expect(resolveAutoModel(envelope('hello, how are you today?'))).toBe(AUTO_ROUTE_DEFAULT_MODEL);
  });

  it('routes code-keyword turns to the heavy model', () => {
    expect(resolveAutoModel(envelope('please fix the login bug'))).toBe(AUTO_ROUTE_HEAVY_MODEL);
    expect(resolveAutoModel(envelope('write a script for this'))).toBe(AUTO_ROUTE_HEAVY_MODEL);
    expect(resolveAutoModel(envelope('can you patch that regression'))).toBe(AUTO_ROUTE_HEAVY_MODEL);
  });

  it('routes long message text to the heavy model', () => {
    expect(resolveAutoModel(envelope('word '.repeat(120)))).toBe(AUTO_ROUTE_HEAVY_MODEL);
  });

  it('ignores envelope ballast when measuring length (July 2026 regression)', () => {
    // A short conversational message whose FORMATTED prompt is well over the
    // char threshold must still route to the default model. Routing on the
    // raw prompt is what sent every turn to Opus and silenced the agents.
    const prompt =
      '<context timezone="Europe/London" />\n' +
      '<messages>\n' +
      '<message id="101" from="telegram:general" sender="Matty MacLean-Bennett" time="Tue 15 Jul, 09:30" reply_to="97">\n' +
      '  <quoted_message from="Andy">ok</quoted_message>\n' +
      'sounds good</message>\n' +
      '<message id="102" from="telegram:general" sender="Matty MacLean-Bennett" time="Tue 15 Jul, 09:31">thanks</message>\n' +
      '<message id="103" from="telegram:general" sender="Andy the Agent" time="Tue 15 Jul, 09:32" reply_to="102">\n' +
      '  <quoted_message from="Matty MacLean-Bennett">thanks</quoted_message>\n' +
      'no problem</message>\n' +
      '</messages>';
    expect(prompt.length).toBeGreaterThan(400);
    expect(resolveAutoModel(prompt)).toBe(AUTO_ROUTE_DEFAULT_MODEL);
  });

  it('does not treat envelope attribute words as routing keywords', () => {
    // "sender", "time", "reply_to" etc. must not be visible to the keyword
    // regex; only the message content counts.
    expect(resolveAutoModel(envelope('ok'))).toBe(AUTO_ROUTE_DEFAULT_MODEL);
  });
});

describe('heavy-route cooldown', () => {
  it('falls back to the default model while cooling down', () => {
    const now = 1_000_000;
    markHeavyRouteFailure(now);
    expect(isHeavyRouteDisabled(now)).toBe(true);
    expect(resolveAutoModel(envelope('please fix the login bug'), now)).toBe(AUTO_ROUTE_DEFAULT_MODEL);
  });

  it('restores heavy routing after the cooldown expires', () => {
    const now = 1_000_000;
    markHeavyRouteFailure(now);
    const later = now + HEAVY_ROUTE_COOLDOWN_MS + 1;
    expect(isHeavyRouteDisabled(later)).toBe(false);
    expect(resolveAutoModel(envelope('please fix the login bug'), later)).toBe(AUTO_ROUTE_HEAVY_MODEL);
  });

  it('does not affect conversational turns', () => {
    const now = 1_000_000;
    markHeavyRouteFailure(now);
    expect(resolveAutoModel(envelope('good morning!'), now)).toBe(AUTO_ROUTE_DEFAULT_MODEL);
  });
});
