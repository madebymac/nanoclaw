import { randomUUID } from 'crypto';

import { createGithubAppIdentity, getGithubAppForAgentGroup } from '../../db/github-apps.js';
import { getAgentGroup } from '../../db/agent-groups.js';
import { registerResource } from '../crud.js';

/**
 * `github-apps` — the "second secrets store" for self-hosted GitHub App bot
 * identities (a OneCLI Pro feature, so brokered here instead). One identity per
 * agent group. The DB holds only the App/installation ids and a filesystem
 * **path** to a chmod-600 private key — never the key itself. At container spawn
 * the host mints a short-lived installation token from that key and injects it
 * as GH_TOKEN/GITHUB_TOKEN (src/container-runner.ts → src/github-app-broker.ts).
 *
 * The private key file must be readable by the host process and should live
 * OUTSIDE the repo with mode 600.
 */
registerResource({
  name: 'github-app',
  plural: 'github-apps',
  table: 'github_app_identities',
  description:
    'Self-hosted GitHub App bot identity bound to an agent group (one per group). Stores App id, installation id, and a path to a chmod-600 private key (never the key). The host mints short-lived installation tokens at spawn and injects them as GH_TOKEN/GITHUB_TOKEN.',
  idColumn: 'id',
  scopeField: 'agent_group_id',
  columns: [
    { name: 'id', type: 'string', description: 'Auto-set UUID.', generated: true },
    {
      name: 'agent_group_id',
      type: 'string',
      description: 'Agent group this identity is bound to (one per group).',
      required: true,
    },
    { name: 'app_id', type: 'string', description: "GitHub App's numeric App ID.", required: true },
    {
      name: 'installation_id',
      type: 'string',
      description: 'Installation ID (from the github.com/settings/installations URL).',
      required: true,
    },
    {
      name: 'private_key_path',
      type: 'string',
      description: 'Absolute path to a chmod-600 .pem on the host, outside the repo.',
      required: true,
    },
    {
      name: 'api_url',
      type: 'string',
      description: 'GitHub API base URL. Defaults to https://api.github.com at mint time.',
      updatable: true,
    },
    { name: 'created_at', type: 'string', description: 'Auto-set.', generated: true },
  ],
  // create is custom so we can pre-check the one-per-group UNIQUE constraint and
  // the agent group's existence, and return friendly errors instead of a raw
  // SQLITE_CONSTRAINT.
  operations: { list: 'open', get: 'open', delete: 'approval' },
  customOperations: {
    create: {
      access: 'approval',
      description:
        'Bind a GitHub App identity to an agent group. --agent-group-id <id> --app-id <n> --installation-id <n> --private-key-path </abs/key.pem> [--api-url <url>].',
      handler: async (args) => {
        const agentGroupId = args.agent_group_id as string;
        const appId = args.app_id as string;
        const installationId = args.installation_id as string;
        const privateKeyPath = args.private_key_path as string;
        const apiUrl = (args.api_url as string) ?? null;
        if (!agentGroupId) throw new Error('--agent-group-id is required');
        if (!appId) throw new Error('--app-id is required');
        if (!installationId) throw new Error('--installation-id is required');
        if (!privateKeyPath) throw new Error('--private-key-path is required');
        if (!getAgentGroup(agentGroupId)) throw new Error(`agent group not found: ${agentGroupId}`);
        if (getGithubAppForAgentGroup(agentGroupId)) {
          throw new Error(
            `agent group ${agentGroupId} already has a GitHub App identity — delete it first (ncl github-apps delete --id <id>)`,
          );
        }
        const id = randomUUID();
        createGithubAppIdentity({
          id,
          agent_group_id: agentGroupId,
          app_id: appId,
          installation_id: installationId,
          private_key_path: privateKeyPath,
          api_url: apiUrl,
          created_at: new Date().toISOString(),
        });
        return { id, agent_group_id: agentGroupId, app_id: appId, installation_id: installationId };
      },
    },
  },
});
