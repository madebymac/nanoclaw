/**
 * Hand a single PR to the reviewer agent by injecting a `task` instruction
 * into one of its sessions and waking the container. This mirrors how a
 * user-scheduled task fires (kind='task' with a `prompt`) — the agent reads
 * the instruction and performs the review with its own GitHub access. The
 * host does NOT review; it only delegates.
 */
import { wakeContainer } from '../../container-runner.js';
import { findSessionByAgentGroup, getSession } from '../../db/sessions.js';
import { log } from '../../log.js';
import { resolveSession, writeSessionMessage } from '../../session-manager.js';

export interface PullToReview {
  fullName: string; // owner/repo
  number: number;
  title: string;
  author: string;
  htmlUrl: string;
}

function buildPrompt(pr: PullToReview): string {
  return [
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
    `This is an automated request from the periodic PR-review job. You don't need`,
    `to reply in chat unless something needs the owner's attention.`,
  ].join('\n');
}

/**
 * Resolve a session for the reviewer agent (its most-recent active session, or
 * a fresh agent-shared one if none exists), inject the review task, and wake.
 */
export async function dispatchReview(agentGroupId: string, pr: PullToReview): Promise<void> {
  const session = findSessionByAgentGroup(agentGroupId) ?? resolveSession(agentGroupId, null, null, 'agent-shared').session;

  const id = `prr-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  writeSessionMessage(agentGroupId, session.id, {
    id,
    kind: 'task',
    timestamp: new Date().toISOString(),
    platformId: null,
    channelType: null,
    threadId: null,
    content: JSON.stringify({ prompt: buildPrompt(pr), source: 'pr-review-cron' }),
    trigger: 1,
  });

  log.info('pr-review: dispatched review task', {
    agentGroupId,
    sessionId: session.id,
    repo: pr.fullName,
    pr: pr.number,
    taskId: id,
  });

  const fresh = getSession(session.id);
  if (fresh) await wakeContainer(fresh);
}
