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
  /** Index of this block within the accumulated text, starting at 0. */
  index: number;
  to: string;
  body: string;
}

export interface OpenBlock {
  /**
   * Index of this open block within the accumulated text. Equals the number
   * of already-closed blocks before it (closed blocks always precede the
   * trailing open block).
   */
  index: number;
  to: string;
  /** Current partial body, *not* trimmed — character count drives throttle decisions. */
  body: string;
}

const MESSAGE_RE = /<message\s+to="([^"]+)"\s*>([\s\S]*?)<\/message>/g;
const OPEN_BLOCK_RE = /<message\s+to="([^"]+)"\s*>([\s\S]*)$/;
const CLOSE_TAG = '</message>';

/**
 * Stateful extractor that tracks how many complete <message> blocks have
 * already been returned. Each call returns only newly-closed blocks, with
 * their position index in the full text so callers can correlate against
 * the final `result` pass.
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
          out.push({ index: idx, to: match[1], body: match[2].trim() });
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

/**
 * Find the trailing unclosed `<message to="…">` block, if any. Stage 2b uses
 * this to drive mid-block streaming: the body is the partial text we want to
 * mirror to the user via `stream_edit`. Returns null when the tail is plain
 * scratchpad, an unwrapped fragment, or sits between two closed blocks.
 *
 * `closedCount` is the index the trailing block would take once it closes —
 * pass `streamExtractor.count()` after running `extractNewlyClosed` so the
 * returned `index` lines up with what `dispatchResultText` and the
 * early-dispatched set use.
 */
export function detectOpenBlock(text: string, closedCount: number): OpenBlock | null {
  const lastClose = text.lastIndexOf(CLOSE_TAG);
  const tail = lastClose >= 0 ? text.slice(lastClose + CLOSE_TAG.length) : text;
  const m = OPEN_BLOCK_RE.exec(tail);
  if (!m) return null;
  return { index: closedCount, to: m[1], body: m[2] };
}
