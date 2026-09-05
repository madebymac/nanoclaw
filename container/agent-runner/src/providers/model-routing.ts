const AUTO_ROUTE_HAIKU = 'claude-haiku-4-5-20251001';
const AUTO_ROUTE_SONNET = 'claude-sonnet-4-6';
const AUTO_ROUTE_CHAR_THRESHOLD = 400;
// Imperative verbs that suggest substantial coding/analysis work
const AUTO_ROUTE_COMPLEX_RE =
  /\b(implement|debug|analyz|refactor|migrat|creat|build|deploy|review|explain|optimiz|perform|diagnos|investigat|audits?|generat|scaffold)/i;

export const AUTO_ROUTE_SIMPLE_MODEL = AUTO_ROUTE_HAIKU;
export const AUTO_ROUTE_COMPLEX_MODEL = AUTO_ROUTE_SONNET;

/**
 * Model used whenever a group's container config leaves `model` unset. Pinned
 * explicitly rather than passing `undefined` through to the SDK, which would
 * otherwise fall back to whatever the underlying Claude Code CLI defaults to
 * — a value that can drift (e.g. a CLI-level settings.json pinning Opus)
 * independent of anything nanoclaw controls.
 */
export const DEFAULT_MODEL = AUTO_ROUTE_SONNET;

/**
 * Strip the XML envelope that formatter.ts wraps around inbound messages
 * (`<context/>`, `<messages>`, `<message …>`, `<task>`, `<quoted_message>`)
 * and unescape entities, so routing measures the actual message content.
 *
 * This is load-bearing for cost. `resolveAutoModel` used to run against the
 * raw formatted prompt, which meant the envelope counted toward the char
 * threshold: three one-word chat messages formatted into a batch come to
 * ~415 characters of mostly `sender=`/`time=`/`reply_to=` ballast, tipping a
 * trivial turn over the 400-char line. Harmless while the tiers were
 * Haiku/Sonnet; in July 2026 the tiers were briefly re-pointed at
 * Sonnet/Opus and the same bug routed essentially all traffic — including
 * "ok" and "thanks" — to the most expensive model, at up to the full
 * 165k-token auto-compact window per turn. Route on content, not envelope.
 */
export function extractRoutableText(prompt: string): string {
  return prompt
    .replace(/<[^>]*>/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Resolve 'auto' model to a concrete model ID based on the message content
 * extracted from the formatted prompt. Short, conversational prompts go to
 * Haiku; anything requiring deeper reasoning or substantial code work goes
 * to Sonnet.
 */
export function resolveAutoModel(prompt: string): string {
  const text = extractRoutableText(prompt);
  const isSimple = text.length < AUTO_ROUTE_CHAR_THRESHOLD && !AUTO_ROUTE_COMPLEX_RE.test(text);
  return isSimple ? AUTO_ROUTE_HAIKU : AUTO_ROUTE_SONNET;
}
