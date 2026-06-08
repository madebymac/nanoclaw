/**
 * Hand a single PR to the reviewer agent by injecting a `task` instruction
 * into one of its sessions and waking the container. This mirrors how a
 * user-scheduled task fires (kind='task' with a `prompt`) — the agent reads
 * the instruction and performs the review with its own GitHub access. The
 * host does NOT review; it only delegates.
 *
 * Status updates (when PR_REVIEW_STATUS_MESSAGING_GROUP_ID is set):
 *   1. "Review requested" — posted host-side via the channel adapter at
 *      dispatch time, so the operator sees a ping even before the container
 *      wakes.
 *   2. "Review complete" — the agent posts this itself as its natural reply.
 *      To make that work, the session is anchored to the configured messaging
 *      group ('shared' mode) so the bot's reply flows back to the group chat
 *      instead of disappearing into an agent-shared session with no
 *      destination.
 */
import { getChannelAdapter } from '../../channels/channel-registry.js';
import { wakeContainer } from '../../container-runner.js';
import { getMessagingGroup } from '../../db/messaging-groups.js';
import { getSession } from '../../db/sessions.js';
import { log } from '../../log.js';
import { resolveSession, writeSessionMessage } from '../../session-manager.js';

export interface PullToReview {
  fullName: string; // owner/repo
  number: number;
  title: string;
  author: string;
  htmlUrl: string;
}

function buildPrompt(pr: PullToReview, replyInChat: boolean): string {
  const lines = [
    `A pull request needs review.`,
    ``,
    `- Repository: ${pr.fullName}`,
    `- PR #${pr.number}: ${pr.title}`,
    `- Author: ${pr.author}`,
    `- URL: ${pr.htmlUrl}`,
    ``,
    `Conduct a thorough code review using your GitHub access:`,
    `- Leave inline review comments on the specific lines you have feedback on.`,
    `- Submit the review with a verdict: APPROVE if it's ready to merge, otherwise`,
    `  REQUEST_CHANGES (or COMMENT) with your findings.`,
    ``,
  ];
  if (replyInChat) {
    lines.push(
      `When you're done, post a single chat message announcing completion with:`,
      `  - the verdict (APPROVED / CHANGES_REQUESTED / COMMENTED),`,
      `  - the PR (${pr.fullName}#${pr.number}) and a link,`,
      `  - a one-paragraph summary of the main findings (or "no issues found").`,
      `This is the only chat reply you should send; everything else belongs as`,
      `inline review comments on the PR itself.`,
    );
  } else {
    lines.push(
      `This is an automated request from the periodic PR-review job. You don't need`,
      `to reply in chat unless something needs the owner's attention.`,
    );
  }
  return lines.join('\n');
}

function buildRequestedStatus(pr: PullToReview): string {
  return [
    `Review requested: ${pr.fullName}#${pr.number}`,
    `Title: ${pr.title}`,
    `Author: @${pr.author}`,
    pr.htmlUrl,
  ].join('\n');
}

/**
 * Resolve a session for the reviewer agent, inject the review task, and wake.
 * When `statusMessagingGroupId` is supplied, also post a "review requested"
 * status message to that chat and anchor the session there so the agent's
 * completion reply flows back as the "review complete" status. Without it,
 * uses agent-shared resolution and the silent prompt (original behaviour).
 */
export async function dispatchReview(
  agentGroupId: string,
  pr: PullToReview,
  statusMessagingGroupId?: string | null,
): Promise<void> {
  const statusMg = statusMessagingGroupId ? getMessagingGroup(statusMessagingGroupId) : undefined;
  if (statusMessagingGroupId && !statusMg) {
    log.warn(
      'pr-review: PR_REVIEW_STATUS_MESSAGING_GROUP_ID does not match any messaging_group — falling back to agent-shared silent dispatch',
      {
        statusMessagingGroupId,
      },
    );
  }

  const { session } = statusMg
    ? resolveSession(agentGroupId, statusMg.id, null, 'shared')
    : resolveSession(agentGroupId, null, null, 'agent-shared');

  const id = `prr-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  writeSessionMessage(agentGroupId, session.id, {
    id,
    kind: 'task',
    timestamp: new Date().toISOString(),
    platformId: null,
    channelType: null,
    threadId: null,
    content: JSON.stringify({ prompt: buildPrompt(pr, Boolean(statusMg)), source: 'pr-review-cron' }),
    trigger: 1,
  });

  log.info('pr-review: dispatched review task', {
    agentGroupId,
    sessionId: session.id,
    repo: pr.fullName,
    pr: pr.number,
    taskId: id,
    statusMessagingGroupId: statusMg?.id ?? null,
  });

  if (statusMg) {
    const adapter = getChannelAdapter(statusMg.channel_type);
    if (!adapter) {
      log.warn('pr-review: no live channel adapter for status messaging group — skipping requested-status post', {
        channelType: statusMg.channel_type,
      });
    } else {
      try {
        await adapter.deliver(statusMg.platform_id, null, {
          kind: 'chat',
          content: { text: buildRequestedStatus(pr) },
        });
      } catch (err) {
        log.error('pr-review: failed to post requested-status', { err, repo: pr.fullName, pr: pr.number });
      }
    }
  }

  const fresh = getSession(session.id);
  if (fresh) await wakeContainer(fresh);
}
