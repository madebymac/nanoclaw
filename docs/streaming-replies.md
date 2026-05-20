# Streaming replies

Tracks GH issue #4. Goal: drop perceived latency from ~10–16s (full container
turn time) to ~1–2s for simple replies by flushing partial output to the
channel as Claude generates it, instead of writing a single `messages_out`
row at the end of the turn.

## Status

This is being delivered in stages. The current branch ships **Stage 1**.

| Stage | What | Status |
|-------|------|--------|
| 1 | Provider `partial` event; early-dispatch of *closed* `<message>` blocks before the `result` event arrives | shipped |
| 2 | Mid-block streaming via edit-on-existing-message + adapter `supportsEdits` flag + host-side seq→platform_id resolution | designed, not implemented |
| 3 | Per-channel rate limiting (Telegram = 1 edit/sec/chat); fallback to one-shot for adapters without edit support | designed, not implemented |

## Stage 1 — closed-block early dispatch

**What changes:** when streaming is enabled, the agent runner dispatches each
`<message to="…">…</message>` block as soon as its closing tag arrives in the
streamed assistant text, rather than waiting for the SDK's final `result`
event. The `result` pass then skips the prefix of blocks already sent.

**Where the win comes from:**

- Multi-message turns (e.g. an agent sending `<message to="alice">` followed
  by `<message to="bob">`) — the first message reaches the channel as soon
  as it closes, before the second is even composed.
- Text-then-tool-use turns — a `<message>` block that closes before a slow
  tool call (e.g. WebFetch, Bash) gets delivered immediately instead of
  waiting for the tool to return and the `result` event to fire.

**What it does NOT solve:** a single short reply (`hello` → `hi there!`) still
arrives in one shot because the `<message>` block doesn't close until the
whole reply is generated. The ~1–2s headline win requires Stage 2.

### Implementation

- `container/agent-runner/src/providers/types.ts` — new `ProviderEvent`
  variant: `{ type: 'partial'; text: string }`. `text` is the full
  accumulated assistant text so far for the current turn (not a delta).
- `container/agent-runner/src/providers/claude.ts` — the SDK message loop
  now handles `message.type === 'assistant'`, concatenates its `text`
  content blocks into a turn-scoped accumulator, and emits `partial`.
  Reset on `init`.
- `container/agent-runner/src/stream-dispatch.ts` — `createStreamExtractor()`
  returns a stateful extractor that, given the accumulated text, returns
  only the `<message>` blocks that have *closed* since the previous call.
- `container/agent-runner/src/poll-loop.ts` — gated by
  `NANOCLAW_STREAM_REPLIES=1`. On `partial`, run the extractor and dispatch
  newly-closed blocks via the same `sendToDestination` path the result-event
  handler uses. Track *successfully dispatched* block indices in a set and
  pass it to `dispatchResultText`, which skips only those indices on the
  result pass. Blocks with unknown destinations stay unset, so the result
  pass scratchpad-logs them and the unwrapped-output nudge still fires when
  no block resolved. The extractor and the dispatched-index set reset on
  every `init` event (e.g. PreCompact mid-stream).

### Enabling

Set on the host environment before spawning containers:

```
NANOCLAW_STREAM_REPLIES=1
```

The env var propagates into the container via `container-runner.ts`'s
existing `--env` passthrough (uses the host process env). Default off so
this is a no-op until an operator opts in.

### Correctness notes

- The streamed text is parsed with the *same* `<message>` regex as
  `dispatchResultText`, so the set of blocks dispatched early is exactly the
  prefix of what the final `result` pass would extract. No risk of a block
  appearing partially in chat and then differently at end-of-turn.
- Scratchpad text between blocks is only logged on the `result` pass (when
  the full text is known). Streaming-path scratchpad lookups would
  duplicate-log every poll; the existing behavior is preserved.
- If `findByName` fails on a streamed block (unknown destination), it is
  logged and deferred — the `result` pass will see the same unknown
  destination and account for it then.
- Each `<message>` block is still a separate `messages_out` row, so
  delivery, retries, and the `delivered` table behave exactly as today.

## Stage 2 — mid-block streaming (design)

**Schema**

`messages_out.content` gains a new operation:

```json
{ "operation": "stream_edit", "targetMessageOutId": "msg-…", "text": "…" }
```

Unlike `operation: "edit"` (which requires a known `platform_message_id` at
write time), `stream_edit` references the original `messages_out.id`. The
host resolves it to a platform message ID via the `delivered` table at
delivery time. If the original hasn't been delivered yet, the host defers
the chunk and retries on the next drain — same retry loop, no new state.

**Container**

Per active destination (keyed by `channel_type|platform_id|thread_id`):

1. First closed block in a streaming turn → ordinary send (no change).
2. While the trailing block is *open*, on each `partial` event:
   - Throttle to a minimum interval per destination (default 1500ms; per-
     channel override in container config to respect e.g. Telegram's
     1-edit/sec/chat limit).
   - Write a `stream_edit` row targeting the most recent open block's
     `messages_out.id`, with the latest accumulated text.
3. Block closes → flush one final `stream_edit` with the closed text, then
   reset the per-destination state for the next block.

**Host**

`src/delivery.ts`:

- Recognize `content.operation === 'stream_edit'`. Look up
  `delivered.platform_message_id` for `content.targetMessageOutId`. If
  missing → throw to retry path (existing 3-attempt backoff). If found →
  build an `edit` op with the resolved platform ID and dispatch as today.
- Coalesce: when multiple undelivered `stream_edit` rows for the same
  target are queued, deliver only the latest. (Telegram and most chat
  APIs treat each edit as a full replacement; superseded edits are
  wasted requests.)

`src/channels/adapter.ts`:

- Add `supportsEdits?: boolean` (default `true`; explicit `false` for
  channels that can't edit, e.g. SMTP-style adapters).
- Delivery skips `stream_edit` rows for adapters without edit support;
  the final block-close `stream_edit` still becomes a one-shot send
  through the `result` path because Stage 1 dispatches the closed block
  via `sendToDestination`.

**Fallback**

Adapters without edit support get Stage 1 behavior only. The user sees
the final block when it closes; intermediate `stream_edit` rows are
dropped at delivery time and the `delivered` row is marked with a
sentinel status (`skipped_no_edit_support`) for observability.

## Testing

Stage 1 has unit tests for the extractor at
`container/agent-runner/src/stream-dispatch.test.ts`. End-to-end testing
requires `NANOCLAW_STREAM_REPLIES=1` plus a channel adapter, which lives on
the `channels` branch — verify there before relying on the behavior.
