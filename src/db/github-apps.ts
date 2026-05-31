import { getDb, hasTable } from './connection.js';

/**
 * A self-hosted GitHub App bot identity bound to an agent group. Only ids and
 * the filesystem PATH to a chmod-600 private key live here — never the key
 * itself. The host mints short-lived installation tokens at spawn time via
 * src/github-app-broker.ts.
 */
export interface GithubAppIdentity {
  id: string;
  agent_group_id: string;
  app_id: string;
  installation_id: string;
  private_key_path: string;
  api_url: string | null;
  created_at: string;
}

function tableReady(): boolean {
  return hasTable(getDb(), 'github_app_identities');
}

export function createGithubAppIdentity(identity: GithubAppIdentity): void {
  getDb()
    .prepare(
      `INSERT INTO github_app_identities
         (id, agent_group_id, app_id, installation_id, private_key_path, api_url, created_at)
       VALUES (@id, @agent_group_id, @app_id, @installation_id, @private_key_path, @api_url, @created_at)`,
    )
    .run(identity);
}

export function getGithubAppIdentity(id: string): GithubAppIdentity | undefined {
  if (!tableReady()) return undefined;
  return getDb().prepare('SELECT * FROM github_app_identities WHERE id = ?').get(id) as GithubAppIdentity | undefined;
}

/** The GitHub App identity bound to an agent group, if any. */
export function getGithubAppForAgentGroup(agentGroupId: string): GithubAppIdentity | undefined {
  if (!tableReady()) return undefined;
  return getDb().prepare('SELECT * FROM github_app_identities WHERE agent_group_id = ?').get(agentGroupId) as
    | GithubAppIdentity
    | undefined;
}

export function getAllGithubAppIdentities(): GithubAppIdentity[] {
  if (!tableReady()) return [];
  return getDb().prepare('SELECT * FROM github_app_identities ORDER BY created_at').all() as GithubAppIdentity[];
}

export function deleteGithubAppIdentity(id: string): void {
  getDb().prepare('DELETE FROM github_app_identities WHERE id = ?').run(id);
}
