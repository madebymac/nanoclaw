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
| 2 | Mid-block streaming via `stream_edit` content op + host-side resolution through the `delivered` table | shipped |
| 3 | Channel-adapter `supportsEdits` capability flag + no-edit fallback (drop intermediate edits, deliver only final) | not implemented |

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

## Stage 2 — mid-block streaming

Ships in the same branch as Stage 1's follow-up PR. Gated by a second
opt-in env var **on top of** `NANOCLAW_STREAM_REPLIES`:

```
NANOCLAW_STREAM_REPLIES=1          # required (Stage 1 baseline)
NANOCLAW_STREAM_PARTIAL_BLOCKS=1   # enable Stage 2 mid-block streaming
NANOCLAW_STREAM_THROTTLE_MS=1500   # optional, default 1500 (Telegram-safe)
```

### Schema

`messages_out.content` gains a new operation, written by the container
and consumed by the host at delivery time:

```json
{ "operation": "stream_edit", "targetMessageOutId": "msg-…", "text": "…" }
```

Unlike `operation: "edit"` (which requires a known `platform_message_id`
at write time), `stream_edit` references the *original* `messages_out.id`.
The host resolves it to a platform message ID via the `delivered` table
at delivery time. No schema migration — `content` is opaque TEXT.

### Container

When `NANOCLAW_STREAM_PARTIAL_BLOCKS=1`, the streaming extractor reports
the trailing open `<message>` block in addition to newly-closed blocks
(`stream-dispatch.ts:extract`). `poll-loop.ts` maintains a single
`TrailingStreamState` per turn (only ever one trailing block at a time —
the stream grows at the tail):

1. First time we see a trailing block with a non-empty body, write a
   normal `messages_out` row (`{ text: body }`) and remember its
   `messages_out.id` + body + flush time.
2. On each subsequent `partial` event, if the body changed AND the
   throttle window has elapsed, write a `stream_edit` row targeting the
   remembered id.
3. When the block closes (next `partial` or the final `result`),
   write one final `stream_edit` with the closed body, then clear state.

The closed-block path from Stage 1 detects "this index was the streaming
slot" and skips the new-row dispatch — the final `stream_edit` is
authoritative.

### Host

`src/delivery.ts` recognizes `content.operation === 'stream_edit'`:

- Looks up `delivered.platform_message_id` for `content.targetMessageOutId`.
- **Target not yet delivered** → throws `DeferredDeliveryError`. The
  delivery loop catches this specifically and leaves the row pending
  *without* burning a retry attempt. Next poll tick tries again.
- **Target delivered** → rewrites content to
  `{ operation: 'edit', messageId: <resolved>, text }` and hands to the
  channel adapter, which already understands `edit`.
- **Target failed** → throws a regular Error. The normal retry/give-up
  path marks this stream_edit row failed too (the platform message it
  was meant to update never existed).

### Correctness notes

- The throttle is per turn, not per process — re-resets on `init`.
  PreCompact mid-stream gets a fresh state machine.
- If the trailing block's destination is unknown to the agent group,
  nothing is written and state stays null; the closed-block path will
  scratchpad-log it as today.
- A safety fallback in the result handler writes a final `stream_edit`
  even when the trailing block "never closed" (e.g. the agent stopped
  mid-tag). The user sees the last streamed body rather than a stale
  partial.

### What's intentionally not in this stage

- **Adapter capability negotiation.** Adapters without
  `editMessage` support will silently no-op the rewritten edits; the
  user sees a partial-truncated initial message. Operators must only
  enable `NANOCLAW_STREAM_PARTIAL_BLOCKS=1` on installs whose channels
  support edits (Telegram does; Slack/Discord/Matrix do; Resend/SMTP
  don't). Stage 3 will add the `supportsEdits` flag and a fallback that
  drops intermediate edits and replays the final body as a fresh row.
- **Edit coalescing in the delivery drain.** With a 1.5s throttle and
  per-1s poll, at most ~1 pending `stream_edit` per target per drain in
  practice. Coalescing is a follow-up if it becomes a problem.

## Stage 3 — channel capability + fallback (design)

When implemented:

- `src/channels/adapter.ts` gains `supportsEdits?: boolean` (default
  `true` for backwards compatibility).
- `src/delivery.ts` checks the adapter's flag before resolving
  `stream_edit`. If `false`:
  - Drop intermediate edits silently (mark delivered with status
    `skipped_no_edit_support` or similar).
  - When the *final* edit lands (detectable via a `final: true` flag
    on the `stream_edit` content or by being the last edit before the
    `result`), deliver it as a fresh text message instead of an edit,
    so the user sees the complete body once.
- The container can also opt out of streaming entirely for channels
  whose adapter declares no edit support, once that capability is
  surfaced through the destination registry.

## Testing

Stage 1 has unit tests for the extractor at
`container/agent-runner/src/stream-dispatch.test.ts`. End-to-end testing
requires `NANOCLAW_STREAM_REPLIES=1` plus a channel adapter, which lives on
the `channels` branch — verify there before relying on the behavior.
