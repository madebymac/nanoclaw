/**
 * Multi-instance OneCLI resolver.
 *
 * Architecturally-load-bearing contract: agent group in, SDK client out,
 * default-singleton fallback preserved.
 *
 * - When an agent group has a non-null `onecli_instance_id`, return a client
 *   pointed at that instance's app/gateway URLs and API key.
 * - When NULL, fall back to the legacy env-var singleton built from
 *   `ONECLI_URL` + `ONECLI_API_KEY` — that's the back-compat path for installs
 *   that predate multi-instance support.
 *
 * Clients are memoized per-instance so we don't churn approval long-polls etc.
 */
import { OneCLI } from '@onecli-sh/sdk';

import { ONECLI_API_KEY, ONECLI_URL } from './config.js';
import { getAgentGroup } from './db/agent-groups.js';
import { getOneCLIInstance } from './db/onecli-instances.js';
import type { AgentGroup, OneCLIInstance } from './types.js';

const SINGLETON_KEY = '__singleton__';
const clients = new Map<string, OneCLI>();

function clientForInstance(instance: OneCLIInstance): OneCLI {
  const existing = clients.get(instance.id);
  if (existing) return existing;
  const client = new OneCLI({
    url: instance.api_url,
    apiKey: instance.api_key ?? undefined,
  });
  clients.set(instance.id, client);
  return client;
}

function singletonClient(): OneCLI {
  const existing = clients.get(SINGLETON_KEY);
  if (existing) return existing;
  const client = new OneCLI({ url: ONECLI_URL, apiKey: ONECLI_API_KEY });
  clients.set(SINGLETON_KEY, client);
  return client;
}

/**
 * Return the OneCLI SDK client for the given agent group. NULL
 * `onecli_instance_id` → env-var singleton. Throws if the group references an
 * instance row that no longer exists (shouldn't happen — instance deletion
 * refuses while agent groups still reference it).
 */
export function getOneCLIForAgentGroup(agentGroup: AgentGroup): OneCLI {
  if (!agentGroup.onecli_instance_id) return singletonClient();
  const instance = getOneCLIInstance(agentGroup.onecli_instance_id);
  if (!instance) {
    throw new Error(
      `Agent group ${agentGroup.id} references onecli_instance ${agentGroup.onecli_instance_id} but no such instance exists`,
    );
  }
  return clientForInstance(instance);
}

/** Convenience for callers that only have the agent group id. */
export function getOneCLIForAgentGroupId(agentGroupId: string): OneCLI {
  const group = getAgentGroup(agentGroupId);
  if (!group) throw new Error(`Agent group not found: ${agentGroupId}`);
  return getOneCLIForAgentGroup(group);
}
