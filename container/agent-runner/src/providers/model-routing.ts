const AUTO_ROUTE_SONNET = 'claude-sonnet-4-6';
const AUTO_ROUTE_OPUS = 'claude-opus-4-7';
const AUTO_ROUTE_CHAR_THRESHOLD = 400;
// Imperative verbs that suggest substantial coding/analysis work
const AUTO_ROUTE_COMPLEX_RE =
  /\b(implement|debug|analyz|refactor|migrat|creat|build|deploy|review|explain|optimiz|perform|diagnos|investigat|audits?|generat|scaffold|write|cod(e|ing)|test|fix|patch)/i;

/**
 * Resolve 'auto' model to a concrete model ID based on prompt characteristics.
 * Conversational prompts go to Sonnet; anything requiring substantial code work
 * or deeper reasoning goes to Opus.
 */
export function resolveAutoModel(prompt: string): string {
  const isCodeHeavy = prompt.length >= AUTO_ROUTE_CHAR_THRESHOLD || AUTO_ROUTE_COMPLEX_RE.test(prompt);
  return isCodeHeavy ? AUTO_ROUTE_OPUS : AUTO_ROUTE_SONNET;
}
