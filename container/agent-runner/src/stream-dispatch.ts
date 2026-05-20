/**
 * Streaming dispatcher for assistant text.
 *
 * The agent wraps output in <message to="name">...</message> blocks. When the
 * SDK streams text, we can dispatch each fully-closed block immediately —
 * before the `result` event arrives — so a multi-message response (or a
 * text-then-tool-use turn) reaches the user as soon as each block closes.
 *
 * This does NOT stream partial text inside a still-open block. That requires
 * edit-on-existing-message support in the host delivery path and channel
 * adapters; tracked separately. See docs/streaming-replies.md.
 *
 * The extractor is stateful per turn: `extractNewlyClosed(text)` is called
 * with the accumulated assistant text and returns only the blocks that
 * closed since the previous call.
 */

export interface ExtractedBlock {
  to: string;
  body: string;
}

const MESSAGE_RE = /<message\s+to="([^"]+)"\s*>([\s\S]*?)<\/message>/g;

/**
 * Stateful extractor that tracks how many complete <message> blocks have
 * already been returned. Each call returns only newly-closed blocks.
 *
 * Closed-only: a block whose opening tag has appeared but whose closing tag
 * hasn't yet is not returned. The blocks dispatched here must be identical
 * to what `dispatchResultText` would extract from the final `result` text,
 * so we never send a half-finished message.
 */
export function createStreamExtractor(): {
  extractNewlyClosed(text: string): ExtractedBlock[];
  count(): number;
} {
  let alreadyReturned = 0;
  return {
    extractNewlyClosed(text: string): ExtractedBlock[] {
      const out: ExtractedBlock[] = [];
      let idx = 0;
      MESSAGE_RE.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = MESSAGE_RE.exec(text)) !== null) {
        if (idx >= alreadyReturned) {
          out.push({ to: match[1], body: match[2].trim() });
        }
        idx++;
      }
      alreadyReturned = idx;
      return out;
    },
    count(): number {
      return alreadyReturned;
    },
  };
}
