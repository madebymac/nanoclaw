import {
  countAgentGroupsForInstance,
  deleteOneCLIInstance,
  getAllOneCLIInstances,
  getOneCLIInstance,
} from '../../db/onecli-instances.js';
import { registerResource } from '../crud.js';

registerResource({
  name: 'onecli-instance',
  plural: 'onecli-instances',
  table: 'onecli_instances',
  description:
    "OneCLI gateway instance — one self-contained credential vault + gateway. Each instance holds one GitHub App (sidestepping OneCLI's one-App-per-project constraint). Agent groups are pinned to an instance via agent_groups.onecli_instance_id; NULL falls back to the legacy env-var singleton.",
  idColumn: 'id',
  columns: [
    {
      name: 'id',
      type: 'string',
      description: 'Slug — e.g. "review-bot". Stable; cannot be renamed (would invalidate ports + install dir).',
      required: true,
    },
    { name: 'name', type: 'string', description: 'Display name.', required: true },
    { name: 'app_port', type: 'number', description: 'Web UI port.', generated: true },
    {
      name: 'gateway_port',
      type: 'number',
      description: 'Proxy/gateway port containers route through.',
      generated: true,
    },
    {
      name: 'postgres_port',
      type: 'number',
      description: 'Postgres port for direct reads (phase 2).',
      generated: true,
    },
    {
      name: 'install_dir',
      type: 'string',
      description: "Filesystem dir holding this instance's state.",
      generated: true,
    },
    {
      name: 'api_url',
      type: 'string',
      description: 'Base URL for the SDK (http://127.0.0.1:<app_port>).',
      generated: true,
    },
    { name: 'api_key', type: 'string', description: 'API key for SDK calls. Set during install.', generated: true },
    {
      name: 'ca_cert_path',
      type: 'string',
      description: "Path to the instance's CA cert (mounted into containers).",
      generated: true,
    },
    { name: 'version', type: 'string', description: 'Pinned gateway version.', generated: true },
    {
      name: 'health_status',
      type: 'string',
      description: '"healthy" / "unhealthy" / "unknown". Updated by the health-check loop (phase 2).',
      enum: ['healthy', 'unhealthy', 'unknown'],
      generated: true,
    },
    { name: 'last_checked', type: 'string', description: 'Last health-check timestamp.', generated: true },
    { name: 'created_at', type: 'string', description: 'Auto-set.', generated: true },
  ],
  operations: { list: 'open', get: 'open' },
  customOperations: {
    install: {
      access: 'approval',
      description:
        'Provision a new OneCLI instance on the next free port triple. Pending phase-1 spike on upstream install-script overrides — this verb is stubbed and will throw until the wrapper lands.',
      handler: async () => {
        throw new Error(
          'onecli-instances install is not implemented yet. See docs/plans/multi-onecli-spikes.md for the 5-min diagnostic that unblocks the install wrapper.',
        );
      },
    },
    remove: {
      access: 'approval',
      description:
        'Tear down a OneCLI instance. Refuses if any agent groups still reference it — detach them first via `ncl groups update --id <group> --onecli-instance-id ""`. Phase 1 only drops the DB row; requires --force until compose teardown lands so operators don\'t silently orphan running containers + bound ports.',
      handler: async (args) => {
        const id = args.id as string;
        if (!id) throw new Error('--id is required');
        const instance = getOneCLIInstance(id);
        if (!instance) throw new Error(`OneCLI instance not found: ${id}`);
        const bound = countAgentGroupsForInstance(id);
        if (bound > 0) {
          throw new Error(
            `Refusing to remove instance ${id} — ${bound} agent group(s) still reference it. Detach them first.`,
          );
        }
        // Until the install wrapper ships compose teardown alongside, `remove`
        // would silently orphan the running containers + leave the host ports
        // bound while the DB forgets about them — a future `install` could
        // reallocate the same triple and collide. Gate behind --force so the
        // operator confirms they know they're cleaning up containers by hand.
        if (!args.force) {
          throw new Error(
            `Refusing to remove instance ${id} — compose teardown is not implemented yet. Re-run with --force to drop the DB row only (you must then docker-compose down the orphaned containers manually).`,
          );
        }
        deleteOneCLIInstance(id);
        return {
          removed: id,
          note: 'DB row deleted. Compose containers (if any) must be torn down manually — see multi-onecli-spikes.md.',
        };
      },
    },
    status: {
      access: 'open',
      description: 'Read health for one or all instances. Use --id <slug> to scope.',
      handler: async (args) => {
        const id = args.id as string | undefined;
        if (id) {
          const i = getOneCLIInstance(id);
          if (!i) throw new Error(`OneCLI instance not found: ${id}`);
          return { id: i.id, health_status: i.health_status, last_checked: i.last_checked };
        }
        return getAllOneCLIInstances().map((i) => ({
          id: i.id,
          health_status: i.health_status,
          last_checked: i.last_checked,
        }));
      },
    },
  },
});
