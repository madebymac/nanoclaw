/**
 * Shared-group bridging for co-resident agents.
 *
 * Most chat platforms (Telegram especially) never deliver a bot's message to
 * another bot in the same chat. So when two agents share one group chat —
 * modelled as two `messaging_groups` rows with the SAME `platform_id` but each
 * agent's own per-bot `channel_type` (e.g. `telegram#general` /
 * `telegram#review`) — an agent posting in the group is invisible to its peer.
 * The peer only ever sees messages from humans, never from the other bot.
 *
 * This bridges that gap. After the host delivers an agent's group post to the
 * platform (so the human still sees it), it injects a copy into every
 * co-resident agent's inbound DB, attributed to the sender and addressed
 * `from` that peer's own view of the shared group. Because the copy looks like
 * it arrived in the group, the peer's reply goes back to the group (delivered
 * to the platform → visible to humans → bridged onward), so the whole
 * exchange stays watchable in the chat.
 *
 * Engagement is delegated to the router's `evaluateEngage`, the SAME predicate
 * used for human messages: the peer is woken only when the post matches its
 * wiring (e.g. `engage_mode='pattern'` with `@peerbot|@all`). That respects the
 * operator's config and is the natural loop-damper — a plain "thanks" with no
 * mention engages no one. When the peer doesn't engage, the copy is stored as
 * silent context (`trigger=0`) for `accumulate` wirings and skipped entirely
 * otherwise.
 *
 * Only genuine group chats (`is_group = 1`) are bridged. Per-bot DMs collide on
 * `platform_id` (it's the user's id, identical across both bots) but are
 * distinct private chats and must never cross-feed — the `is_group` gate is
 * what separates the two cases.
 */
import { getAgentGroup } from '../../db/agent-groups.js';
import {
  getMessagingGroupAgents,
  getMessagingGroupByPlatform,
  getSiblingMessagingGroups,
} from '../../db/messaging-groups.js';
import { getSession } from '../../db/sessions.js';
import { wakeContainer } from '../../container-runner.js';
import { log } from '../../log.js';
import { evaluateEngage } from '../../router.js';
import { resolveSession, writeSessionMessage } from '../../session-manager.js';
import type { Session } from '../../types.js';
import { getDestinationByTarget } from './db/agent-destinations.js';

export interface BridgeableMessage {
  id: string;
  kind: string;
  channel_type: string | null;
  platform_id: string | null;
  content: string;
}

/**
 * Mirror a just-delivered group post into every other agent sharing the same
 * physical group chat. Best-effort and side-effecting; the caller has already
 * delivered the message to the platform, so any failure here must not bubble
 * up and fail that delivery (the caller wraps this in try/catch).
 */
export async function bridgeGroupMessageToCoResidentAgents(
  msg: BridgeableMessage,
  senderSession: Session,
): Promise<void> {
  if (msg.kind !== 'chat' || !msg.channel_type || !msg.platform_id) return;

  // Plain-text chat only. Skip stream/edit operations and interactive cards —
  // those are platform-presentation concerns, not conversational turns a peer
  // should react to.
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(msg.content) as Record<string, unknown>;
  } catch {
    return;
  }
  if (parsed.operation || parsed.type === 'ask_question') return;
  const text = typeof parsed.text === 'string' ? parsed.text : '';
  if (!text.trim()) return;

  const senderMg = getMessagingGroupByPlatform(msg.channel_type, msg.platform_id);
  if (!senderMg || senderMg.is_group !== 1) return;

  // Sibling messaging groups = the same physical chat, seen through other bots.
  const siblings = getSiblingMessagingGroups(msg.platform_id, senderMg.id);
  if (siblings.length === 0) return;

  const senderName = getAgentGroup(senderSession.agent_group_id)?.name ?? senderSession.agent_group_id;

  for (const sib of siblings) {
    for (const wiring of getMessagingGroupAgents(sib.id)) {
      // Never bridge a message back to the agent that sent it.
      if (wiring.agent_group_id === senderSession.agent_group_id) continue;
      if (!getAgentGroup(wiring.agent_group_id)) continue;

      // Same engagement predicate as a human message in this chat. Bridged
      // posts carry no platform-resolved mention, so isMention=false — pattern
      // wirings (the intended config for multi-agent groups) match on text and
      // are unaffected; pure 'mention' wirings won't wake, which is the safe
      // default since the mention can't be resolved host-side.
      const engages = evaluateEngage(wiring, text, false, sib, null);
      if (!engages && wiring.ignored_message_policy !== 'accumulate') continue;

      // Reached only when the peer engages OR its wiring is `accumulate`.
      // resolveSession may materialise a session here even for a non-engaging
      // accumulate message (trigger=0, no wake below) — that's intentional:
      // `accumulate` operators want silent context to build up so it's present
      // when the agent does later engage. `drop` wirings already `continue`d
      // above, so a session is never created just to throw the message away.
      const { session: target } = resolveSession(wiring.agent_group_id, sib.id, null, wiring.session_mode);

      // Prefer what the receiver already calls the sender (its destination
      // local name), falling back to the sender agent group's name.
      const senderLabel =
        getDestinationByTarget(wiring.agent_group_id, 'agent', senderSession.agent_group_id)?.local_name ?? senderName;

      const bridgedId = `grp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      writeSessionMessage(wiring.agent_group_id, target.id, {
        id: bridgedId,
        kind: 'chat',
        timestamp: new Date().toISOString(),
        // Address the copy from the peer's OWN view of the shared group so a
        // reply routes straight back to the group (and re-bridges naturally),
        // keeping the conversation visible to humans in the chat.
        channelType: sib.channel_type,
        platformId: sib.platform_id,
        threadId: null,
        content: JSON.stringify({ text, sender: senderLabel }),
        trigger: engages ? 1 : 0,
        sourceSessionId: senderSession.id,
      });

      log.info('Group message bridged to co-resident agent', {
        from: senderSession.agent_group_id,
        to: wiring.agent_group_id,
        group: sib.id,
        bridgedId,
        engaged: engages,
      });

      if (engages) {
        const fresh = getSession(target.id);
        if (fresh) await wakeContainer(fresh);
      }
    }
  }
}
