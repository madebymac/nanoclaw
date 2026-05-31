import { registerResource } from '../crud.js';

/**
 * `github-apps` — the "second secrets store" for self-hosted GitHub App bot
 * identities (a OneCLI Pro feature, so brokered here instead). One identity per
 * agent group. The DB holds only the App/installation ids and the filesystem
 * PATH to a chmod-600 private key — never the key itself. At container spawn the
 * host mints a short-lived installation token from that key and injects it as
 * GH_TOKEN/GITHUB_TOKEN (src/container-runner.ts → src/github-app-broker.ts).
 *
 * The private key file must be readable by the host process and should live
 * OUTSIDE the repo with mode 600.
 */
registerResource({
  name: 'github-app',
  plural: 'github-apps',
  table: 'github_app_identities',
  description:
    'Self-hosted GitHub App bot identity bound to an agent group. Stores App id, installation id, and a path to a chmod-600 private key (never the key). The host mints short-lived installation tokens at spawn and injects them as GH_TOKEN/GITHUB_TOKEN.',
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
  operations: { list: 'open', get: 'open', create: 'approval', delete: 'approval' },
});
