const AUTO_ROUTE_HAIKU = 'claude-haiku-4-5-20251001';
const AUTO_ROUTE_SONNET = 'claude-sonnet-4-6';
const AUTO_ROUTE_CHAR_THRESHOLD = 400;
// Imperative verbs that suggest substantial coding/analysis work
const AUTO_ROUTE_COMPLEX_RE =
  /\b(implement|debug|analyz|refactor|migrat|creat|build|deploy|review|explain|optimiz|perform|diagnos|investigat|audits?|generat|scaffold)/i;

/**
 * Resolve 'auto' model to a concrete model ID based on prompt characteristics.
 * Short, conversational prompts go to Haiku; anything requiring deeper reasoning
 * or substantial code work goes to Sonnet.
 */
export function resolveAutoModel(prompt: string): string {
  const isSimple = prompt.length < AUTO_ROUTE_CHAR_THRESHOLD && !AUTO_ROUTE_COMPLEX_RE.test(prompt);
  return isSimple ? AUTO_ROUTE_HAIKU : AUTO_ROUTE_SONNET;
}
