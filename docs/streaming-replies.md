# Streaming replies

Tracks GH issue #4. Goal: drop perceived latency from ~10–16s (full container
turn time) to ~1–2s for simple replies by flushing partial output to the
channel as Claude generates it, instead of writing a single `messages_out`
row at the end of the turn.

## Status

This is being delivered in stages. Stages 1 and 2a are shipped; 2a is dead
code (the host recognises `stream_edit` rows) until 2b adds the container-
side writer that emits them.

| Stage | What | Status |
|-------|------|--------|
| 1 | Provider `partial` event; early-dispatch of *closed* `<message>` blocks before the `result` event arrives | shipped |
| 2a | Host-side `stream_edit` recognition: resolve `targetMessageOutId` via `delivered` table → `edit` op; coalesce superseded edits | shipped (dead code until 2b) |
| 2b | Container writer: per-destination throttled `stream_edit` flushes while the trailing `<message>` block is still open | designed, not implemented |
| 3 | Per-channel rate limiting (Telegram = 1 edit/sec/chat); adapter `supportsEdits` flag and fallback for adapters without edit support | designed, not implemented |

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

## Stage 2a — host-side resolver (shipped, dead code today)

The host already recognises a new content op:

```json
{ "operation": "stream_edit", "targetMessageOutId": "msg-…", "text": "…" }
```

Unlike `operation: "edit"` (which requires a known `platform_message_id`
at write time), `stream_edit` references the original `messages_out.id`.
`src/delivery.ts` resolves it to a platform message ID via the `delivered`
table at delivery time (`getDeliveredPlatformId`), then rewrites the
payload into a regular `edit` op the channel adapter already understands.
If the target hasn't been delivered yet, delivery throws and the row sits
in the existing 3-attempt retry path — no new state.

The drain pass also coalesces superseded `stream_edit` rows: if several
target the same `messages_out.id` in a single pass, only the newest hits
the adapter — the earlier ones are marked delivered without a send. Every
edit is a full replacement, so superseded ones would just waste budget
against the per-chat rate limit.

Nothing writes `stream_edit` rows yet — Stage 2b adds the container-side
writer.

## Stage 2b — container writer (design)

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

**Host** (Stage 3 — not yet implemented)

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
`container/agent-runner/src/stream-dispatch.test.ts`. Stage 2a has host
delivery tests at `src/delivery.test.ts` covering resolve, retry-then-
succeed once the target lands, and coalescing of superseded edits. End-to-
end testing requires `NANOCLAW_STREAM_REPLIES=1` plus the container writer
(Stage 2b) plus a channel adapter, which lives on the `channels` branch.
