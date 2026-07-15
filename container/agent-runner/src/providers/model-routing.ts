const AUTO_ROUTE_SONNET = 'claude-sonnet-4-6';
const AUTO_ROUTE_OPUS = 'claude-opus-4-7';
const AUTO_ROUTE_CHAR_THRESHOLD = 400;
// Imperative verbs that suggest substantial coding/analysis work
const AUTO_ROUTE_COMPLEX_RE =
  /\b(implement|debug|analyz|refactor|migrat|creat|build|deploy|review|explain|optimiz|perform|diagnos|investigat|audits?|generat|scaffold|write|cod(e|ing)|test|fix|patch)/i;

export const AUTO_ROUTE_DEFAULT_MODEL = AUTO_ROUTE_SONNET;
export const AUTO_ROUTE_HEAVY_MODEL = AUTO_ROUTE_OPUS;

/**
 * Strip the XML envelope that formatter.ts wraps around inbound messages
 * (<context/>, <messages>, <message ...>, <task>, <quoted_message>, ...) and
 * unescape entities, so routing decisions measure the actual message content.
 *
 * Routing on the raw formatted prompt is what broke agents in July 2026: the
 * envelope's attribute ballast pushed nearly every turn past the char
 * threshold, so every turn routed to the heavy model regardless of content.
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

// When the heavy model fails repeatedly at the API layer (entitlement, rate
// limits, outage), the provider marks the heavy route as failing and routing
// falls back to the default model until the cooldown expires. This keeps a
// broken heavy tier from silencing the agent entirely.
export const HEAVY_ROUTE_COOLDOWN_MS = 15 * 60_000;

let heavyRouteCooldownUntil = 0;

export function markHeavyRouteFailure(now: number = Date.now()): void {
  heavyRouteCooldownUntil = now + HEAVY_ROUTE_COOLDOWN_MS;
}

export function isHeavyRouteDisabled(now: number = Date.now()): boolean {
  return now < heavyRouteCooldownUntil;
}

/** Test helper — clears any active heavy-route cooldown. */
export function resetHeavyRouteCooldown(): void {
  heavyRouteCooldownUntil = 0;
}

/**
 * Resolve 'auto' model to a concrete model ID based on the message content
 * extracted from the formatted prompt. Conversational turns go to Sonnet;
 * code-heavy or long turns go to Opus — unless the heavy route is cooling
 * down after repeated API failures, in which case everything goes to Sonnet.
 */
export function resolveAutoModel(prompt: string, now: number = Date.now()): string {
  const text = extractRoutableText(prompt);
  const isHeavy = text.length >= AUTO_ROUTE_CHAR_THRESHOLD || AUTO_ROUTE_COMPLEX_RE.test(text);
  if (!isHeavy || isHeavyRouteDisabled(now)) return AUTO_ROUTE_DEFAULT_MODEL;
  return AUTO_ROUTE_HEAVY_MODEL;
}
