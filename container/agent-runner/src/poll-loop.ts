import { findByName, getAllDestinations, type DestinationEntry } from './destinations.js';
import { getPendingMessages, markProcessing, markCompleted, type MessageInRow } from './db/messages-in.js';
import { writeMessageOut } from './db/messages-out.js';
import { getInboundDb, touchHeartbeat, clearStaleProcessingAcks } from './db/connection.js';
import { clearContinuation, migrateLegacyContinuation, setContinuation } from './db/session-state.js';
import { clearCurrentInReplyTo, setCurrentInReplyTo } from './current-batch.js';
import {
  formatMessages,
  extractRouting,
  categorizeMessage,
  isClearCommand,
  isRunnerCommand,
  stripInternalTags,
  type RoutingContext,
} from './formatter.js';
import type { AgentProvider, AgentQuery, ProviderEvent } from './providers/types.js';
import { createStreamExtractor, type ExtractedBlock, type TrailingBlock } from './stream-dispatch.js';

const STREAM_REPLIES = process.env.NANOCLAW_STREAM_REPLIES === '1';
/** Stage 2: stream the trailing open <message> block via stream_edit rows. */
const STREAM_PARTIAL_BLOCKS = process.env.NANOCLAW_STREAM_PARTIAL_BLOCKS === '1';
/**
 * Minimum gap between successive stream_edit writes for the same trailing
 * block. Default sized for Telegram's 1 edit/sec/chat rate limit with a
 * small safety margin. Override with NANOCLAW_STREAM_THROTTLE_MS.
 */
const STREAM_THROTTLE_MS = (() => {
  const raw = Number(process.env.NANOCLAW_STREAM_THROTTLE_MS);
  return Number.isFinite(raw) && raw >= 0 ? raw : 1500;
})();

const POLL_INTERVAL_MS = 1000;
const ACTIVE_POLL_INTERVAL_MS = 500;

function log(msg: string): void {
  console.error(`[poll-loop] ${msg}`);
}

function generateId(): string {
  return `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export interface PollLoopConfig {
  provider: AgentProvider;
  /**
   * Name of the provider (e.g. "claude", "codex", "opencode"). Used to key
   * the stored continuation per-provider so flipping providers doesn't
   * resurrect a stale id from a different backend.
   */
  providerName: string;
  cwd: string;
  systemContext?: {
    instructions?: string;
  };
}

/**
 * Main poll loop. Runs indefinitely until the process is killed.
 *
 * 1. Poll messages_in for pending rows
 * 2. Format into prompt, call provider.query()
 * 3. While query active: continue polling, push new messages via provider.push()
 * 4. On result: write messages_out
 * 5. Mark messages completed
 * 6. Loop
 */
export async function runPollLoop(config: PollLoopConfig): Promise<void> {
  // Resume the agent's prior session from a previous container run if one
  // was persisted. The continuation is opaque to the poll-loop — the
  // provider decides how to use it (Claude resumes a .jsonl transcript,
  // other providers may reload a thread ID, etc.). Keyed per-provider so
  // a Codex thread id never gets handed to Claude or vice versa.
  let continuation: string | undefined = migrateLegacyContinuation(config.providerName);

  if (continuation) {
    log(`Resuming agent session ${continuation}`);
  }

  // Clear leftover 'processing' acks from a previous crashed container.
  // This lets the new container re-process those messages.
  clearStaleProcessingAcks();

  let pollCount = 0;
  let isFirstPoll = true;
  while (true) {
    // Skip system messages — they're responses for MCP tools (e.g., ask_user_question)
    const messages = getPendingMessages(isFirstPoll).filter((m) => m.kind !== 'system');
    isFirstPoll = false;
    pollCount++;

    // Periodic heartbeat so we know the loop is alive
    if (pollCount % 30 === 0) {
      log(`Poll heartbeat (${pollCount} iterations, ${messages.length} pending)`);
    }

    if (messages.length === 0) {
      await sleep(POLL_INTERVAL_MS);
      continue;
    }

    // Accumulate gate: if the batch contains only trigger=0 rows
    // (context-only, router-stored under ignored_message_policy='accumulate'),
    // don't wake the agent. Leave them `pending` — they'll ride along the
    // next time a real trigger=1 message lands via this same getPendingMessages
    // query. Without this gate, a warm container keeps processing
    // (and potentially responding to) every accumulate-only batch, defeating
    // the "store as context, don't engage" contract. Host-side countDueMessages
    // gates the same way for wake-from-cold (see src/db/session-db.ts).
    if (!messages.some((m) => m.trigger === 1)) {
      await sleep(POLL_INTERVAL_MS);
      continue;
    }

    const ids = messages.map((m) => m.id);
    markProcessing(ids);

    const routing = extractRouting(messages);

    // Command handling: the host router gates filtered and unauthorized
    // admin commands before they reach the container. The only command
    // the runner handles directly is /clear (session reset).
    const normalMessages: MessageInRow[] = [];
    const commandIds: string[] = [];

    for (const msg of messages) {
      if ((msg.kind === 'chat' || msg.kind === 'chat-sdk') && isClearCommand(msg)) {
        log('Clearing session (resetting continuation)');
        continuation = undefined;
        clearContinuation(config.providerName);
        writeMessageOut({
          id: generateId(),
          kind: 'chat',
          platform_id: routing.platformId,
          channel_type: routing.channelType,
          thread_id: routing.threadId,
          content: JSON.stringify({ text: 'Session cleared.' }),
        });
        commandIds.push(msg.id);
        continue;
      }
      normalMessages.push(msg);
    }

    if (commandIds.length > 0) {
      markCompleted(commandIds);
    }

    if (normalMessages.length === 0) {
      const remainingIds = ids.filter((id) => !commandIds.includes(id));
      if (remainingIds.length > 0) markCompleted(remainingIds);
      log(`All ${messages.length} message(s) were commands, skipping query`);
      continue;
    }

    // Pre-task scripts: for any task rows with a `script`, run it before the
    // provider call. Scripts returning wakeAgent=false (or erroring) gate
    // their own task row only — surviving messages still go to the agent.
    // Without the scheduling module, the marker block is empty, `keep`
    // falls back to `normalMessages`, and no gating happens.
    let keep: MessageInRow[] = normalMessages;
    let skipped: string[] = [];
    // MODULE-HOOK:scheduling-pre-task:start
    const { applyPreTaskScripts } = await import('./scheduling/task-script.js');
    const preTask = await applyPreTaskScripts(normalMessages);
    keep = preTask.keep;
    skipped = preTask.skipped;
    if (skipped.length > 0) {
      markCompleted(skipped);
      log(`Pre-task script skipped ${skipped.length} task(s): ${skipped.join(', ')}`);
    }
    // MODULE-HOOK:scheduling-pre-task:end

    if (keep.length === 0) {
      log(`All ${normalMessages.length} non-command message(s) gated by script, skipping query`);
      continue;
    }

    // Format messages: passthrough commands get raw text (only if the
    // provider natively handles slash commands), others get XML.
    const prompt = formatMessagesWithCommands(keep, config.provider.supportsNativeSlashCommands);

    log(`Processing ${keep.length} message(s), kinds: ${[...new Set(keep.map((m) => m.kind))].join(',')}`);

    const query = config.provider.query({
      prompt,
      continuation,
      cwd: config.cwd,
      systemContext: config.systemContext,
    });

    // Process the query while concurrently polling for new messages
    const skippedSet = new Set(skipped);
    const processingIds = ids.filter((id) => !commandIds.includes(id) && !skippedSet.has(id));
    // Publish the batch's in_reply_to so MCP tools (send_message, send_file)
    // can stamp it on outbound rows — needed for a2a return-path routing.
    setCurrentInReplyTo(routing.inReplyTo);
    try {
      const result = await processQuery(query, routing, processingIds, config.providerName);
      if (result.continuation && result.continuation !== continuation) {
        continuation = result.continuation;
        setContinuation(config.providerName, continuation);
      }
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      log(`Query error: ${errMsg}`);

      // Stale/corrupt continuation recovery: ask the provider whether
      // this error means the stored continuation is unusable, and clear
      // it so the next attempt starts fresh.
      if (continuation && config.provider.isSessionInvalid(err)) {
        log(`Stale session detected (${continuation}) — clearing for next retry`);
        continuation = undefined;
        clearContinuation(config.providerName);
      }

      // Write error response so the user knows something went wrong
      writeMessageOut({
        id: generateId(),
        kind: 'chat',
        platform_id: routing.platformId,
        channel_type: routing.channelType,
        thread_id: routing.threadId,
        content: JSON.stringify({ text: `Error: ${errMsg}` }),
      });
    } finally {
      clearCurrentInReplyTo();
    }

    // Ensure completed even if processQuery ended without a result event
    // (e.g. stream closed unexpectedly).
    markCompleted(processingIds);
    log(`Completed ${ids.length} message(s)`);
  }
}

/**
 * Format messages, handling passthrough commands differently.
 * When the provider handles slash commands natively (Claude Code),
 * passthrough commands are sent raw (no XML wrapping) so the SDK can
 * dispatch them. Otherwise they fall through to standard XML formatting.
 */
function formatMessagesWithCommands(messages: MessageInRow[], nativeSlashCommands: boolean): string {
  const parts: string[] = [];
  const normalBatch: MessageInRow[] = [];

  for (const msg of messages) {
    if (nativeSlashCommands && (msg.kind === 'chat' || msg.kind === 'chat-sdk')) {
      const cmdInfo = categorizeMessage(msg);
      if (cmdInfo.category === 'passthrough' || cmdInfo.category === 'admin') {
        // Flush normal batch first
        if (normalBatch.length > 0) {
          parts.push(formatMessages(normalBatch));
          normalBatch.length = 0;
        }
        // Pass raw command text (no XML wrapping) — SDK handles it natively
        parts.push(cmdInfo.text);
        continue;
      }
    }
    normalBatch.push(msg);
  }

  if (normalBatch.length > 0) {
    parts.push(formatMessages(normalBatch));
  }

  return parts.join('\n\n');
}

interface QueryResult {
  continuation?: string;
}

async function processQuery(
  query: AgentQuery,
  routing: RoutingContext,
  initialBatchIds: string[],
  providerName: string,
): Promise<QueryResult> {
  let queryContinuation: string | undefined;
  let done = false;
  let unwrappedNudged = false;

  // Concurrent polling: push follow-ups into the active query as they arrive.
  // We do NOT force-end the stream on silence — keeping the query open avoids
  // re-spawning the SDK subprocess (~few seconds) and re-loading the .jsonl
  // transcript on every turn. The Anthropic prompt cache is server-side with
  // a 5-min TTL keyed on prefix hash, so stream lifecycle does NOT affect
  // cache lifetime — close+reopen within 5 min still gets cache hits.
  // Stream liveness is decided host-side via the heartbeat file + processing
  // claim age (see src/host-sweep.ts); if something is truly stuck, the host
  // will kill the container and messages get reset to pending.
  let pollInFlight = false;
  let endedForCommand = false;

  // Early-dispatch state: when streaming is enabled, dispatch <message>
  // blocks as soon as they close, and tell the final `result` pass which
  // block indices it should skip (vs. re-send / scratchpad-log). We track
  // by index rather than count so that an unknown-destination block at
  // position N — which the stream path can't send — still hits the
  // result-pass scratchpad and unwrapped-output nudge logic.
  // Reset on each `init` (e.g. PreCompact starts a fresh turn).
  let streamExtractor = STREAM_REPLIES ? createStreamExtractor() : null;
  let earlyDispatched: Set<number> = new Set();
  // Stage 2 streaming state for the trailing open <message> block. At most
  // one trailing block is in flight at any moment (it's the tail of the
  // accumulated text). When the block closes, we issue a final stream_edit
  // and clear the slot; the closed-block dispatch path skips it because
  // its index is already in earlyDispatched.
  let trailingStream: TrailingStreamState | null = null;
  const pollHandle = setInterval(() => {
    if (done || pollInFlight || endedForCommand) return;
    pollInFlight = true;

    void (async () => {
      try {
        const pending = getPendingMessages();

        // Slash commands need a fresh query: /clear resets the SDK's
        // resume id (fixed at sdkQuery() time); admin/passthrough commands
        // (/compact, /cost, …) only dispatch when they're the first input
        // of a query — pushed mid-stream they arrive as plain text and
        // the SDK never runs them. End the stream and leave the rows
        // pending; the outer loop handles them on next iteration via the
        // canonical command path + formatMessagesWithCommands.
        if (pending.some((m) => isRunnerCommand(m))) {
          log('Pending slash command — ending stream so outer loop can process');
          endedForCommand = true;
          query.end();
          return;
        }

        // Skip system messages (MCP tool responses).
        // Thread routing is the router's concern — if a message landed in this
        // session, the agent should see it. Per-thread sessions already isolate
        // threads into separate containers; shared sessions intentionally merge
        // everything. Filtering on thread_id here caused deadlocks when the
        // initial batch and follow-ups had mismatched thread_ids (e.g. a
        // host-generated welcome trigger with null thread vs a Discord DM reply).
        const newMessages = pending.filter((m) => m.kind !== 'system');
        if (newMessages.length === 0) return;

        const newIds = newMessages.map((m) => m.id);
        markProcessing(newIds);

        // Run pre-task scripts on follow-ups too — without this, a task that
        // arrives during an active query (e.g. a */10 monitoring cron) bypasses
        // its script gate and always wakes the agent, defeating the gate.
        // Mirrors the initial-batch hook above.
        let keep = newMessages;
        let skipped: string[] = [];
        // MODULE-HOOK:scheduling-pre-task-followup:start
        const { applyPreTaskScripts } = await import('./scheduling/task-script.js');
        const preTask = await applyPreTaskScripts(newMessages);
        keep = preTask.keep;
        skipped = preTask.skipped;
        if (skipped.length > 0) {
          markCompleted(skipped);
          log(`Pre-task script skipped ${skipped.length} follow-up task(s): ${skipped.join(', ')}`);
        }
        // MODULE-HOOK:scheduling-pre-task-followup:end

        if (keep.length === 0) return;
        // Re-check done — the outer query may have finished while the script
        // was awaited. Pushing into a closed stream is wasted work; the
        // claimed messages get released by the host's processing-claim sweep.
        if (done) return;

        const keptIds = keep.map((m) => m.id);
        const prompt = formatMessages(keep);
        log(`Pushing ${keep.length} follow-up message(s) into active query`);
        unwrappedNudged = false;
        query.push(prompt);
        markCompleted(keptIds);
      } catch (err) {
        // Without this catch the rejection escapes the void IIFE and Node
        // terminates the container on unhandled-rejection. The initial-batch
        // path is wrapped by processQuery's outer try/catch; the follow-up
        // path is not, so it needs its own.
        const errMsg = err instanceof Error ? err.message : String(err);
        log(`Follow-up poll error: ${errMsg}`);
      } finally {
        pollInFlight = false;
      }
    })();
  }, ACTIVE_POLL_INTERVAL_MS);

  try {
    for await (const event of query.events) {
      handleEvent(event, routing);
      touchHeartbeat();

      if (event.type === 'partial' && streamExtractor) {
        const { newlyClosed, trailing } = streamExtractor.extract(event.text);
        // Closed-block dispatch (Stage 1). If a block index matches the
        // currently-streaming trailing slot, treat the close as the
        // final stream_edit and skip the new-row path.
        for (const block of newlyClosed) {
          if (trailingStream && block.index === trailingStream.index) {
            finalizeTrailingStream(trailingStream, block.body);
            earlyDispatched.add(block.index);
            trailingStream = null;
            continue;
          }
          if (dispatchBlock(block, routing)) earlyDispatched.add(block.index);
        }
        // Trailing partial: optionally stream via stream_edit (Stage 2).
        if (STREAM_PARTIAL_BLOCKS) {
          trailingStream = advanceTrailingStream(trailingStream, trailing, routing);
        }
      } else if (event.type === 'init') {
        queryContinuation = event.continuation;
        // Fresh turn — drop any streaming state from a prior segment
        // (e.g. PreCompact emits a new init mid-stream).
        if (STREAM_REPLIES) {
          streamExtractor = createStreamExtractor();
          earlyDispatched = new Set();
          trailingStream = null;
        }
        // Persist immediately so a mid-turn container crash still lets the
        // next wake resume the conversation. Without this, the session id
        // was only written after the full stream completed — if the
        // container died between `init` and `result`, the SDK session was
        // effectively orphaned and the next message started a blank
        // Claude session with no prior context.
        setContinuation(providerName, event.continuation);
      } else if (event.type === 'result') {
        // A result — with or without text — means the turn is done. Mark
        // the initial batch completed now so the host sweep doesn't see
        // stale 'processing' claims while the query stays open for
        // follow-up pushes. The agent may have responded via MCP
        // (send_message) mid-turn, or the message may not need a response
        // at all — either way the turn is finished.
        markCompleted(initialBatchIds);
        if (event.text) {
          // If we were streaming a trailing block and the final `result`
          // text now contains it as a closed block, finalize it via
          // stream_edit and mark its index dispatched so dispatchResultText
          // skips it. Without this the closed-block path would re-send the
          // same text as a fresh row.
          if (trailingStream) {
            const closedBody = findClosedBlockBody(event.text, trailingStream.index);
            if (closedBody !== null) {
              finalizeTrailingStream(trailingStream, closedBody);
              earlyDispatched.add(trailingStream.index);
            } else {
              // The trailing block never closed (e.g. agent stopped without
              // closing the tag). Best effort: finalize with whatever was
              // streamed so the user isn't left with a stale partial.
              finalizeTrailingStream(trailingStream, trailingStream.lastBody);
              earlyDispatched.add(trailingStream.index);
            }
            trailingStream = null;
          }
          const { hasUnwrapped } = dispatchResultText(event.text, routing, earlyDispatched);
          // earlyDispatched is consumed; reset for any subsequent turn that
          // reuses this processQuery invocation (currently none, but the
          // explicit reset keeps state contained to the turn that produced it).
          earlyDispatched = new Set();
          if (streamExtractor) streamExtractor = createStreamExtractor();
          if (hasUnwrapped && !unwrappedNudged) {
            unwrappedNudged = true;
            const destinations = getAllDestinations();
            const names = destinations.map((d) => d.name).join(', ');
            query.push(
              `<system>Your response was not delivered — it was not wrapped in <message to="name">...</message> blocks. ` +
                `All output must be wrapped: use <message to="name"> for content to send, or <internal> for scratchpad. ` +
                `Your destinations: ${names}. ` +
                `Please re-send your response with the correct wrapping.</system>`,
            );
          }
        }
      }
    }
  } finally {
    done = true;
    clearInterval(pollHandle);
  }

  return { continuation: queryContinuation };
}

function handleEvent(event: ProviderEvent, _routing: RoutingContext): void {
  switch (event.type) {
    case 'init':
      log(`Session: ${event.continuation}`);
      break;
    case 'result':
      log(`Result: ${event.text ? event.text.slice(0, 200) : '(empty)'}`);
      break;
    case 'error':
      log(
        `Error: ${event.message} (retryable: ${event.retryable}${event.classification ? `, ${event.classification}` : ''})`,
      );
      break;
    case 'progress':
      log(`Progress: ${event.message}`);
      break;
  }
}

/**
 * Parse the agent's final text for <message to="name">...</message> blocks
 * and dispatch each one to its resolved destination. Text outside of blocks
 * (including <internal>...</internal>) is scratchpad — logged but not sent.
 *
 * The agent must always wrap output in <message to="name">...</message>
 * blocks, even with a single destination. Bare text is scratchpad only.
 */
function dispatchResultText(
  text: string,
  routing: RoutingContext,
  alreadyDispatched: ReadonlySet<number> = new Set(),
): { sent: number; hasUnwrapped: boolean } {
  const MESSAGE_RE = /<message\s+to="([^"]+)"\s*>([\s\S]*?)<\/message>/g;

  let match: RegExpExecArray | null;
  let sent = 0;
  let blockIdx = 0;
  let lastIndex = 0;
  const scratchpadParts: string[] = [];

  while ((match = MESSAGE_RE.exec(text)) !== null) {
    if (match.index > lastIndex) {
      scratchpadParts.push(text.slice(lastIndex, match.index));
    }
    const toName = match[1];
    const body = match[2].trim();
    lastIndex = MESSAGE_RE.lastIndex;
    const currentIdx = blockIdx++;

    // Already sent in the streaming early-dispatch path.
    if (alreadyDispatched.has(currentIdx)) {
      sent++;
      continue;
    }

    const dest = findByName(toName);
    if (!dest) {
      log(`Unknown destination in <message to="${toName}">, dropping block`);
      scratchpadParts.push(`[dropped: unknown destination "${toName}"] ${body}`);
      continue;
    }
    sendToDestination(dest, body, routing);
    sent++;
  }
  if (lastIndex < text.length) {
    scratchpadParts.push(text.slice(lastIndex));
  }

  const scratchpad = stripInternalTags(scratchpadParts.join(''));

  if (scratchpad) {
    log(`[scratchpad] ${scratchpad.slice(0, 500)}${scratchpad.length > 500 ? '…' : ''}`);
  }

  const hasUnwrapped = sent === 0 && !!scratchpad;
  if (hasUnwrapped) {
    log(`WARNING: agent output had no <message to="..."> blocks — nothing was sent`);
  }
  return { sent, hasUnwrapped };
}

/**
 * Per-destination state for an in-flight trailing <message> block being
 * streamed via stream_edit rows. Only one trailing block exists at a time
 * because the stream always grows at the tail.
 */
interface TrailingStreamState {
  /** Index this block occupies in the accumulated text. */
  index: number;
  /** Destination name from the opening `<message to="…">` tag. */
  to: string;
  /**
   * `messages_out.id` of the initial row sent for this block. The host
   * resolves this to a platform_message_id via the `delivered` table at
   * delivery time and edits that platform message in place.
   */
  messageOutId: string;
  /** Last body actually flushed to outbound.db (trimmed). */
  lastBody: string;
  /** Wall-clock ms of the last flush, for throttling. */
  lastFlushAt: number;
}

/**
 * Trim a body for streaming. Mid-stream we expect trailing whitespace as
 * the model emits tokens; users shouldn't see jittery trailing spaces.
 * Mirrors the trim() in closed-block dispatch.
 */
function trimStreamBody(s: string): string {
  return s.trim();
}

/**
 * Open a new trailing-stream slot, or update an existing one with a
 * throttled stream_edit. Returns the (possibly mutated) state.
 *
 * Three cases:
 * - `trailing` is null → close out any prior state (caller handles the
 *   close path on `newlyClosed`); return null.
 * - No prior state → open: write the initial messages_out row and
 *   record the id for subsequent edits.
 * - Prior state exists → check destination match and throttle, then
 *   write a stream_edit row targeting the initial row's id.
 *
 * If the destination is unknown (findByName misses), nothing is written
 * and state is cleared — the closed-block dispatch path will log it as
 * an unknown destination once the block closes.
 */
function advanceTrailingStream(
  prev: TrailingStreamState | null,
  trailing: TrailingBlock | null,
  routing: RoutingContext,
): TrailingStreamState | null {
  if (!trailing) return null;
  const body = trimStreamBody(trailing.partialBody);

  // No prior streaming → try to open.
  if (!prev || prev.index !== trailing.index || prev.to !== trailing.to) {
    if (!body) return prev ?? null; // nothing to send yet
    const dest = findByName(trailing.to);
    if (!dest) {
      log(`Stream-partial: unknown destination "${trailing.to}", deferring to result-event path`);
      return null;
    }
    const id = generateId();
    const destRouting = resolveDestinationThread(
      dest.type === 'channel' ? dest.channelType! : 'agent',
      dest.type === 'channel' ? dest.platformId! : dest.agentGroupId!,
    );
    writeMessageOut({
      id,
      in_reply_to: destRouting?.inReplyTo ?? routing.inReplyTo,
      kind: 'chat',
      platform_id: dest.type === 'channel' ? dest.platformId! : dest.agentGroupId!,
      channel_type: dest.type === 'channel' ? dest.channelType! : 'agent',
      thread_id: destRouting?.threadId ?? null,
      content: JSON.stringify({ text: body }),
    });
    log(`Stream-partial: opened block ${trailing.index} → ${trailing.to} (${body.length} chars)`);
    return { index: trailing.index, to: trailing.to, messageOutId: id, lastBody: body, lastFlushAt: Date.now() };
  }

  // Same block continues. Throttle + dedup.
  if (body === prev.lastBody) return prev;
  const now = Date.now();
  if (now - prev.lastFlushAt < STREAM_THROTTLE_MS) return prev;

  const dest = findByName(prev.to);
  if (!dest) {
    log(`Stream-partial: destination "${prev.to}" disappeared mid-stream — abandoning`);
    return null;
  }
  const platformId = dest.type === 'channel' ? dest.platformId! : dest.agentGroupId!;
  const channelType = dest.type === 'channel' ? dest.channelType! : 'agent';
  const destRouting = resolveDestinationThread(channelType, platformId);
  writeMessageOut({
    id: generateId(),
    kind: 'chat',
    platform_id: platformId,
    channel_type: channelType,
    thread_id: destRouting?.threadId ?? null,
    content: JSON.stringify({ operation: 'stream_edit', targetMessageOutId: prev.messageOutId, text: body }),
  });
  log(`Stream-partial: edit block ${prev.index} → ${prev.to} (${body.length} chars)`);
  return { ...prev, lastBody: body, lastFlushAt: now };
}

/**
 * Write a final stream_edit for a streamed block with its closed body.
 * Mirrors mid-stream edits but always fires regardless of throttle since
 * this is the user-visible final text.
 */
function finalizeTrailingStream(state: TrailingStreamState, finalBody: string): void {
  const body = trimStreamBody(finalBody);
  if (body === state.lastBody) {
    log(`Stream-partial: closed block ${state.index} → ${state.to} (no diff, skipping final edit)`);
    return;
  }
  // We don't have routing handy here; the host edits by platform_message_id
  // which it resolves from `delivered`, so channel_type/platform_id on this
  // row aren't used for routing the edit — only for permission checks
  // (which match the original row's destination). We re-use the original
  // row's destination via a fresh writeMessageOut that omits routing fields;
  // delivery will look them up from the resolved target.
  // For simplicity and to preserve existing permission checks, callers pass
  // routing-bearing dests through advanceTrailingStream first, so by the
  // time we finalize, the destination is known to be valid.
  const dest = findByName(state.to);
  if (!dest) {
    log(`Stream-partial: destination "${state.to}" disappeared between open and close — skipping final edit`);
    return;
  }
  const platformId = dest.type === 'channel' ? dest.platformId! : dest.agentGroupId!;
  const channelType = dest.type === 'channel' ? dest.channelType! : 'agent';
  const destRouting = resolveDestinationThread(channelType, platformId);
  writeMessageOut({
    id: generateId(),
    kind: 'chat',
    platform_id: platformId,
    channel_type: channelType,
    thread_id: destRouting?.threadId ?? null,
    content: JSON.stringify({ operation: 'stream_edit', targetMessageOutId: state.messageOutId, text: body }),
  });
  log(`Stream-partial: closed block ${state.index} → ${state.to} (final ${body.length} chars)`);
}

/**
 * Find the body of the Nth closed <message> block in `text` (zero-indexed).
 * Returns null if there are fewer than N+1 closed blocks. Used to reconcile
 * trailing-stream state against the authoritative `result` text.
 */
function findClosedBlockBody(text: string, index: number): string | null {
  const re = /<message\s+to="[^"]+"\s*>([\s\S]*?)<\/message>/g;
  let i = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (i === index) return m[1].trim();
    i++;
  }
  return null;
}

/**
 * Dispatch a single extracted block from the streaming path. Returns true
 * iff the block was actually sent. Unknown destinations are deferred so
 * the result-event pass can scratchpad-log them and (if no blocks at all
 * were resolved) emit the unwrapped-output nudge.
 */
function dispatchBlock(block: ExtractedBlock, routing: RoutingContext): boolean {
  const dest = findByName(block.to);
  if (!dest) {
    log(`Stream: unknown destination "${block.to}", deferring to result-event path`);
    return false;
  }
  sendToDestination(dest, block.body, routing);
  log(`Stream-dispatched <message to="${block.to}"> (${block.body.length} chars)`);
  return true;
}

function sendToDestination(dest: DestinationEntry, body: string, routing: RoutingContext): void {
  const platformId = dest.type === 'channel' ? dest.platformId! : dest.agentGroupId!;
  const channelType = dest.type === 'channel' ? dest.channelType! : 'agent';
  // Resolve thread_id per-destination from the most recent inbound message
  // that came from this same channel+platform. In agent-shared sessions,
  // different destinations have different thread contexts — using a single
  // routing.threadId would stamp one channel's thread onto another.
  const destRouting = resolveDestinationThread(channelType, platformId);
  writeMessageOut({
    id: generateId(),
    in_reply_to: destRouting?.inReplyTo ?? routing.inReplyTo,
    kind: 'chat',
    platform_id: platformId,
    channel_type: channelType,
    thread_id: destRouting?.threadId ?? null,
    content: JSON.stringify({ text: body }),
  });
}

/**
 * Find the thread_id and message id from the most recent inbound message
 * matching the given channel+platform. Returns null if no match found.
 */
function resolveDestinationThread(
  channelType: string,
  platformId: string,
): { threadId: string | null; inReplyTo: string | null } | null {
  try {
    const db = getInboundDb();
    const row = db
      .prepare(
        `SELECT thread_id, id FROM messages_in
         WHERE channel_type = ? AND platform_id = ?
         ORDER BY seq DESC LIMIT 1`,
      )
      .get(channelType, platformId) as { thread_id: string | null; id: string } | undefined;
    if (row) return { threadId: row.thread_id, inReplyTo: row.id };
  } catch (err) {
    log(`resolveDestinationThread error: ${err instanceof Error ? err.message : String(err)}`);
  }
  return null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
