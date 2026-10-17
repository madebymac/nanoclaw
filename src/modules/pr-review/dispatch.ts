/**
 * Hand a single PR to the reviewer agent by injecting a `task` instruction
 * into one of its sessions and waking the container. This mirrors how a
 * user-scheduled task fires (kind='task' with a `prompt`) — the agent reads
 * the instruction and performs the review with its own GitHub access. The
 * host does NOT review; it only delegates.
 */
import { wakeContainer } from '../../container-runner.js';
import { getSession } from '../../db/sessions.js';
import { log } from '../../log.js';
import { resolveSession, writeSessionMessage } from '../../session-manager.js';

export interface PullToReview {
  fullName: string; // owner/repo
  number: number;
  title: string;
  author: string;
  htmlUrl: string;
  /** Raised by a bot / coding agent — it has no physical device to test on. */
  authoredByBot?: boolean;
}

function buildPrompt(pr: PullToReview): string {
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
  if (pr.authoredByBot) {
    lines.push(
      `This PR was raised by a bot / coding agent, not a person. It has no access to a`,
      `phone, simulator or any physical device, so it cannot produce on-device`,
      `screenshots, screen recordings or manual testing evidence:`,
      `- Do NOT ask for any of these, and do NOT withhold approval or REQUEST_CHANGES`,
      `  because they are missing.`,
      `- Judge testing from what an agent can produce: automated tests, CI results,`,
      `  build output, and the code itself. Ask for missing automated tests instead.`,
      `- If you believe a change genuinely needs a check on a real device, say so once`,
      `  as a non-blocking note addressed to the human maintainer who will merge it.`,
      ``,
    );
  }
  lines.push(
    `This is an automated request from the periodic PR-review job. You don't need`,
    `to reply in chat unless something needs the owner's attention.`,
  );
  return lines.join('\n');
}

/**
 * Resolve the reviewer agent's shared session, inject the review task, and
 * wake. Status updates are the agent's own business — the host posts nothing.
 */
export async function dispatchReview(agentGroupId: string, pr: PullToReview): Promise<void> {
  const { session } = resolveSession(agentGroupId, null, null, 'agent-shared');

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
