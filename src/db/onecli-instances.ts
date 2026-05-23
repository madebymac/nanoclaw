import type { OneCLIInstance } from '../types.js';
import { getDb } from './connection.js';

export function createOneCLIInstance(instance: OneCLIInstance): void {
  getDb()
    .prepare(
      `INSERT INTO onecli_instances (
         id, name, app_port, gateway_port, postgres_port, install_dir,
         api_url, api_key, ca_cert_path, version, health_status, last_checked, created_at
       ) VALUES (
         @id, @name, @app_port, @gateway_port, @postgres_port, @install_dir,
         @api_url, @api_key, @ca_cert_path, @version, @health_status, @last_checked, @created_at
       )`,
    )
    .run(instance);
}

export function getOneCLIInstance(id: string): OneCLIInstance | undefined {
  return getDb().prepare('SELECT * FROM onecli_instances WHERE id = ?').get(id) as OneCLIInstance | undefined;
}

export function getAllOneCLIInstances(): OneCLIInstance[] {
  return getDb().prepare('SELECT * FROM onecli_instances ORDER BY id').all() as OneCLIInstance[];
}

export function updateOneCLIInstance(
  id: string,
  updates: Partial<
    Pick<OneCLIInstance, 'name' | 'api_key' | 'ca_cert_path' | 'version' | 'health_status' | 'last_checked'>
  >,
): void {
  const fields: string[] = [];
  const values: Record<string, unknown> = { id };
  for (const [key, value] of Object.entries(updates)) {
    if (value !== undefined) {
      fields.push(`${key} = @${key}`);
      values[key] = value;
    }
  }
  if (fields.length === 0) return;
  getDb()
    .prepare(`UPDATE onecli_instances SET ${fields.join(', ')} WHERE id = @id`)
    .run(values);
}

export function deleteOneCLIInstance(id: string): void {
  getDb().prepare('DELETE FROM onecli_instances WHERE id = ?').run(id);
}

/** Count agent groups bound to an instance — used to refuse deletion. */
export function countAgentGroupsForInstance(instanceId: string): number {
  const row = getDb()
    .prepare('SELECT COUNT(*) AS n FROM agent_groups WHERE onecli_instance_id = ?')
    .get(instanceId) as { n: number };
  return row.n;
}

/** Smallest free triple of ports starting at the given base. Steps in 10s. */
export function allocatePortTriple(basePort = 10256): { app: number; gateway: number; postgres: number } {
  const used = getDb().prepare('SELECT app_port, gateway_port, postgres_port FROM onecli_instances').all() as {
    app_port: number;
    gateway_port: number;
    postgres_port: number;
  }[];
  const taken = new Set<number>();
  for (const r of used) {
    taken.add(r.app_port);
    taken.add(r.gateway_port);
    taken.add(r.postgres_port);
  }
  for (let base = basePort; base < 65000; base += 10) {
    const app = base;
    const gateway = base + 1;
    const postgres = base + 2;
    if (!taken.has(app) && !taken.has(gateway) && !taken.has(postgres)) {
      return { app, gateway, postgres };
    }
  }
  throw new Error('Could not allocate a free OneCLI port triple');
}
