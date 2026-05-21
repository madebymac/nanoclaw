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

/**
 * The currently-open (unclosed) <message> block at the tail of the
 * accumulated text, if any. Its `index` is the position it WILL occupy
 * once it closes — i.e. one past the highest closed-block index seen.
 */
export interface TrailingBlock {
  index: number;
  to: string;
  partialBody: string;
}

export interface ExtractionResult {
  /** Blocks that closed since the previous call. */
  newlyClosed: ExtractedBlock[];
  /** Currently-open trailing block, or null if none. */
  trailing: TrailingBlock | null;
}

const CLOSED_BLOCK_RE = /<message\s+to="([^"]+)"\s*>([\s\S]*?)<\/message>/g;
const OPEN_BLOCK_RE = /<message\s+to="([^"]+)"\s*>([\s\S]*)$/;

/**
 * Stateful extractor for the streaming dispatch path.
 *
 * - `extract(text)` returns newly-closed `<message>` blocks (with index)
 *   plus the trailing open block, if one is currently in progress.
 * - The "trailing open block" is the prefix of text after the last
 *   `</message>` that starts with a fresh `<message to="…">` opening tag
 *   whose closer hasn't arrived yet.
 *
 * Closed blocks dispatched here are identical to what `dispatchResultText`
 * would extract from the final `result` text, so we never send a
 * half-finished closed message. Trailing partials are explicitly partial
 * and the caller is responsible for writing them as editable rows.
 */
export function createStreamExtractor(): {
  extract(text: string): ExtractionResult;
  /** Test helper: backward-compatible newly-closed-only path. */
  extractNewlyClosed(text: string): ExtractedBlock[];
  count(): number;
} {
  let alreadyReturned = 0;

  function extract(text: string): ExtractionResult {
    const newlyClosed: ExtractedBlock[] = [];
    let idx = 0;
    let lastCloseEnd = 0;
    CLOSED_BLOCK_RE.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = CLOSED_BLOCK_RE.exec(text)) !== null) {
      if (idx >= alreadyReturned) {
        newlyClosed.push({ index: idx, to: match[1], body: match[2].trim() });
      }
      idx++;
      lastCloseEnd = CLOSED_BLOCK_RE.lastIndex;
    }
    alreadyReturned = idx;

    // Anything after the last </message> may contain an open <message>.
    const tail = text.slice(lastCloseEnd);
    const openMatch = OPEN_BLOCK_RE.exec(tail);
    const trailing: TrailingBlock | null = openMatch
      ? {
          index: idx,
          to: openMatch[1],
          // Don't trim — leading/trailing whitespace is meaningful while
          // the model is still typing. Caller trims for display.
          partialBody: openMatch[2],
        }
      : null;

    return { newlyClosed, trailing };
  }

  return {
    extract,
    extractNewlyClosed(text: string): ExtractedBlock[] {
      return extract(text).newlyClosed;
    },
    count(): number {
      return alreadyReturned;
    },
  };
}
