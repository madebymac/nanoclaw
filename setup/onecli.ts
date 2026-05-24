/**
 * Step: onecli — Install + configure the OneCLI gateway and CLI.
 *
 * Two modes:
 *   (default) run the OneCLI installer, configure api-host, write .env.
 *   --reuse   skip the installer; reuse the onecli instance already running
 *             on the host. Required for users who have other apps bound to
 *             an existing gateway, since re-running the installer rebinds
 *             the listener and breaks those consumers.
 *
 * Emits ONECLI_URL and polls /health so downstream steps (auth, service)
 * get a ready gateway.
 */
import { execFileSync, execSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { readInstanceName } from '../src/instance-name.js';
import { log } from '../src/log.js';
import { emitStatus } from './status.js';

const LOCAL_BIN = path.join(os.homedir(), '.local', 'bin');

/**
 * Multi-instance support: when NCL_INSTANCE is set, OneCLI lives under its
 * own compose project + install dir + port triple. Without it, behaviour is
 * unchanged — single-install at the default compose project name "onecli".
 */
function instanceContext(): {
  name: string;
  composeProject: string;
  envFile: string;
  installDir: string;
  appPort: number | null;
  gatewayPort: number | null;
  postgresPort: number | null;
} {
  // Validated at ingestion — throws on '..', shell metachars, etc. so
  // installDir below (which becomes ~/.onecli-${name} and is exported
  // to a curl|sh installer via ONECLI_HOME) is always path-safe.
  const name = readInstanceName();
  const projectRoot = process.cwd();
  if (!name) {
    return {
      name: '',
      composeProject: 'onecli',
      envFile: path.join(projectRoot, '.env'),
      installDir: path.join(os.homedir(), '.onecli'),
      appPort: null,
      gatewayPort: null,
      postgresPort: null,
    };
  }
  const envFile = path.join(projectRoot, 'instances', name, '.env');
  // Port triple is already written into instances/<name>/.env by
  // scripts/render-instance-env.sh — parse it back out so the upstream
  // installer (and the legacy-cleanup probe) see the right numbers.
  const appPort = parseEnvPort(envFile, 'ONECLI_URL');
  return {
    name,
    composeProject: `onecli-${name}`,
    envFile,
    installDir: path.join(os.homedir(), `.onecli-${name}`),
    appPort,
    gatewayPort: appPort !== null ? appPort + 1 : null,
    postgresPort: appPort !== null ? appPort + 2 : null,
  };
}

function parseEnvPort(envFile: string, key: string): number | null {
  try {
    const content = fs.readFileSync(envFile, 'utf-8');
    const re = new RegExp(`^${key}=(.+)$`, 'm');
    const m = re.exec(content);
    if (!m) return null;
    const url = m[1].trim().replace(/^["']|["']$/g, '');
    const portMatch = url.match(/:(\d+)(?:\/|$)/);
    return portMatch ? parseInt(portMatch[1], 10) : null;
  } catch {
    return null;
  }
}

function childEnv(): NodeJS.ProcessEnv {
  const parts = [LOCAL_BIN];
  if (process.env.PATH) parts.push(process.env.PATH);
  return { ...process.env, PATH: parts.join(path.delimiter) };
}

function onecliVersion(): string | null {
  try {
    return execFileSync('onecli', ['version'], {
      encoding: 'utf-8',
      env: childEnv(),
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return null;
  }
}

/**
 * Ask the installed onecli CLI for its configured api-host. Returns null if
 * onecli isn't on PATH, errors, or has no api-host configured.
 *
 * Tolerates both JSON output (onecli 1.3+) and older raw-text output.
 */
export function getOnecliApiHost(): string | null {
  try {
    const out = execFileSync('onecli', ['config', 'get', 'api-host'], {
      encoding: 'utf-8',
      env: childEnv(),
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    try {
      const parsed = JSON.parse(out) as { data?: unknown; value?: unknown };
      const val = parsed.data ?? parsed.value;
      if (typeof val === 'string' && val.trim()) return val.trim();
    } catch {
      // not JSON — fall through to URL extraction
    }
    return extractUrlFromOutput(out);
  } catch {
    return null;
  }
}

function extractUrlFromOutput(output: string): string | null {
  const match = output.match(/https?:\/\/[\w.\-]+(?::\d+)?/);
  return match ? match[0] : null;
}

function ensureShellProfilePath(): void {
  const home = os.homedir();
  const line = 'export PATH="$HOME/.local/bin:$PATH"';
  for (const profile of [path.join(home, '.bashrc'), path.join(home, '.zshrc')]) {
    try {
      const content = fs.existsSync(profile) ? fs.readFileSync(profile, 'utf-8') : '';
      if (!content.includes('.local/bin')) {
        fs.appendFileSync(profile, `\n${line}\n`);
        log.info('Added ~/.local/bin to PATH in shell profile', { profile });
      }
    } catch (err) {
      log.warn('Could not update shell profile', { profile, err });
    }
  }
}

function writeEnvVar(name: string, value: string, envFile: string = path.join(process.cwd(), '.env')): void {
  fs.mkdirSync(path.dirname(envFile), { recursive: true });
  let content = fs.existsSync(envFile) ? fs.readFileSync(envFile, 'utf-8') : '';
  const re = new RegExp(`^${name}=.*$`, 'm');
  if (re.test(content)) {
    content = content.replace(re, `${name}=${value}`);
  } else {
    content = content.trimEnd() + (content ? '\n' : '') + `${name}=${value}\n`;
  }
  fs.writeFileSync(envFile, content);
}

function writeEnvOnecliUrl(url: string, envFile?: string): void {
  writeEnvVar('ONECLI_URL', url, envFile ?? path.join(process.cwd(), '.env'));
}

// Last-known-good CLI release. Used only if BOTH the upstream installer
// and the redirect-based version probe fail. Bump deliberately when a
// new CLI release ships.
const ONECLI_GATEWAY_VERSION = '1.23.0';
const ONECLI_CLI_FALLBACK_VERSION = '1.3.0';
const ONECLI_CLI_REPO = 'onecli/onecli-cli';

function installOnecliCliOnly(): { stdout: string; ok: boolean } {
  const upstream = runInstall('curl -fsSL onecli.sh/cli/install | sh');
  if (upstream.ok) return { stdout: upstream.stdout, ok: true };
  const fallback = installOnecliCliDirect();
  return { stdout: upstream.stdout + (upstream.stderr ?? '') + '\n' + fallback.stdout, ok: fallback.ok };
}

function installOnecli(ctx: ReturnType<typeof instanceContext>): { stdout: string; ok: boolean } {
  let stdout = '';

  // Gateway install — bypass the upstream onecli.sh installer entirely.
  //
  // Why bypass: the upstream installer ships a compose file with hardcoded
  // `name: onecli` + `container_name: onecli`. Compose treats `name:` as
  // authoritative over the `-p` flag, so two installs on one host always
  // collide on a single project. We need one gateway per nanoclaw instance
  // (strong credential + failure isolation), so we ship our own compose
  // template (setup/onecli/docker-compose.yml.template) with those fields
  // removed and bring it up directly under -p onecli-<inst>.
  //
  // Per-instance compose dir at ctx.installDir (e.g. ~/.onecli-review/):
  //   docker-compose.yml  — rendered from the template
  //   .env                — port triple, bind host, version, NEXTAUTH_SECRET
  // pgdata + app-data live in named volumes scoped to project onecli-<inst>.
  const gw = installInstanceGateway(ctx);
  stdout += gw.stdout;
  if (!gw.ok) {
    log.error('OneCLI gateway compose-up failed', { stderr: gw.stderr });
    return { stdout: stdout + (gw.stderr ?? ''), ok: false };
  }

  // CLI binary install. Host-global, not per-instance — once it's on
  // PATH, every instance uses the same binary. Skip if already present.
  if (onecliVersion()) {
    stdout += `OneCLI CLI already installed (${onecliVersion()}); skipping\n`;
    return { stdout, ok: true };
  }

  // The upstream CLI installer calls api.github.com to resolve the latest
  // tag — 403s anonymous callers after 60 requests/hour. Try upstream first;
  // on failure resolve the version ourselves via HTTP redirect (not API-
  // throttled) and download the release archive directly.
  const upstream = runInstall('curl -fsSL onecli.sh/cli/install | sh');
  stdout += upstream.stdout;
  if (upstream.ok) return { stdout, ok: true };

  log.warn('Upstream CLI installer failed — falling back to direct download', {
    stderr: upstream.stderr,
  });
  stdout += (upstream.stderr ?? '') + '\n';

  const fallback = installOnecliCliDirect();
  stdout += fallback.stdout;
  if (!fallback.ok) {
    log.error('OneCLI CLI install failed (both upstream and direct fallback)');
    return { stdout, ok: false };
  }
  return { stdout, ok: true };
}

/**
 * Default docker bridge gateway IP on Linux. Used as the bind host so
 * containers spawned by nanoclaw can reach the gateway (`127.0.0.1` from
 * inside a child container would be the container itself, not the host).
 * Operators with a non-default docker network can override by setting
 * ONECLI_BIND_HOST in their instance .env before first install.
 */
const DEFAULT_BIND_HOST = '172.17.0.1';

/**
 * Render the per-instance compose file + .env into ctx.installDir, then
 * `docker compose -p <project> up -d`. Idempotent: existing volumes /
 * containers are reused; subsequent runs are effectively a no-op when
 * everything is already running.
 *
 * NEXTAUTH_SECRET is generated once and persisted in the per-instance .env
 * so restarts don't invalidate sessions. POSTGRES_PASSWORD stays default
 * — postgres is project-scoped (volume + network), so the default
 * credential isn't shared across instances.
 */
function installInstanceGateway(
  ctx: ReturnType<typeof instanceContext>,
): { stdout: string; stderr?: string; ok: boolean } {
  if (!ctx.name || ctx.appPort === null || ctx.gatewayPort === null || ctx.postgresPort === null) {
    return {
      stdout: '',
      stderr: 'installInstanceGateway requires NCL_INSTANCE + a parsable per-instance .env',
      ok: false,
    };
  }

  fs.mkdirSync(ctx.installDir, { recursive: true });

  // Copy the template into the per-instance dir. Done unconditionally so
  // template fixes propagate on the next deploy tick.
  const templatePath = path.join(process.cwd(), 'setup', 'onecli', 'docker-compose.yml.template');
  const composePath = path.join(ctx.installDir, 'docker-compose.yml');
  fs.copyFileSync(templatePath, composePath);

  // Per-instance .env. NEXTAUTH_SECRET persists across runs — only
  // generated on first install.
  const envPath = path.join(ctx.installDir, '.env');
  const existing = fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf-8') : '';
  const persistedSecret = /^NEXTAUTH_SECRET=(.+)$/m.exec(existing)?.[1];
  const nextauthSecret = persistedSecret || randomSecret();
  const bindHost = /^ONECLI_BIND_HOST=(.+)$/m.exec(existing)?.[1] || DEFAULT_BIND_HOST;

  const envLines = [
    `# Auto-generated by setup/onecli.ts. Edit at your own risk; the deploy`,
    `# step re-renders this file on every tick except for the values below`,
    `# (NEXTAUTH_SECRET, ONECLI_BIND_HOST) which are persisted.`,
    `ONECLI_VERSION=${ONECLI_GATEWAY_VERSION}`,
    `ONECLI_BIND_HOST=${bindHost}`,
    `ONECLI_APP_PORT=${ctx.appPort}`,
    `ONECLI_GATEWAY_PORT=${ctx.gatewayPort}`,
    `POSTGRES_PORT=${ctx.postgresPort}`,
    `NEXTAUTH_SECRET=${nextauthSecret}`,
    '',
  ];
  fs.writeFileSync(envPath, envLines.join('\n'), { mode: 0o600 });

  const cmd = `docker compose --project-directory ${JSON.stringify(ctx.installDir)} -p ${JSON.stringify(ctx.composeProject)} up -d`;
  return runInstall(cmd);
}

function randomSecret(): string {
  // 32 random bytes, base64url-encoded. Enough entropy for NextAuth's
  // signing secret; matches the upstream installer's openssl rand approach.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { randomBytes } = require('crypto') as typeof import('crypto');
  return randomBytes(32).toString('base64url');
}

function runInstall(cmd: string): { stdout: string; stderr?: string; ok: boolean } {
  try {
    const stdout = execSync(cmd, {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { stdout, ok: true };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string };
    return { stdout: e.stdout ?? '', stderr: e.stderr, ok: false };
  }
}

/**
 * Reinstate the OneCLI CLI install without hitting GitHub's rate-limited
 * releases API. Resolves the version via the HTTP redirect from
 * /releases/latest → /releases/tag/vX.Y.Z, then downloads the archive
 * directly. Falls back to ONECLI_CLI_FALLBACK_VERSION if the redirect
 * probe also fails.
 */
function installOnecliCliDirect(): { stdout: string; ok: boolean } {
  const lines: string[] = [];
  const append = (s: string): void => {
    lines.push(s);
  };

  const osName = process.platform === 'darwin' ? 'darwin' : process.platform === 'linux' ? 'linux' : null;
  if (!osName) {
    append(`Unsupported platform: ${process.platform}`);
    return { stdout: lines.join('\n'), ok: false };
  }
  const arch = process.arch === 'x64' ? 'amd64' : process.arch === 'arm64' ? 'arm64' : null;
  if (!arch) {
    append(`Unsupported arch: ${process.arch}`);
    return { stdout: lines.join('\n'), ok: false };
  }

  let version: string | null = null;
  try {
    const redirect = execSync(
      `curl -fsSL -o /dev/null -w '%{url_effective}' https://github.com/${ONECLI_CLI_REPO}/releases/latest`,
      { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] },
    ).trim();
    const m = redirect.match(/\/tag\/v?([^/]+)$/);
    if (m) version = m[1];
  } catch {
    // redirect probe failed — we'll pin the fallback
  }
  if (!version) {
    version = ONECLI_CLI_FALLBACK_VERSION;
    append(`Version probe failed; installing pinned fallback ${version}.`);
  } else {
    append(`Resolved onecli CLI ${version} via release redirect.`);
  }

  const archive = `onecli_${version}_${osName}_${arch}.tar.gz`;
  const url = `https://github.com/${ONECLI_CLI_REPO}/releases/download/v${version}/${archive}`;
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'onecli-'));
  const archivePath = path.join(tmpDir, archive);

  try {
    append(`Downloading ${url}`);
    execSync(`curl -fsSL -o ${JSON.stringify(archivePath)} ${JSON.stringify(url)}`, {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    execSync(`tar -xzf ${JSON.stringify(archivePath)} -C ${JSON.stringify(tmpDir)}`, {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let installDir = '/usr/local/bin';
    try {
      fs.accessSync(installDir, fs.constants.W_OK);
    } catch {
      installDir = LOCAL_BIN;
      fs.mkdirSync(installDir, { recursive: true });
    }
    const binSrc = path.join(tmpDir, 'onecli');
    const binDest = path.join(installDir, 'onecli');
    fs.copyFileSync(binSrc, binDest);
    fs.chmodSync(binDest, 0o755);
    append(`onecli ${version} installed to ${binDest}.`);
    return { stdout: lines.join('\n'), ok: true };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; message?: string };
    append(`Direct install failed: ${e.stderr ?? e.message ?? String(err)}`);
    return { stdout: lines.join('\n'), ok: false };
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

export async function pollHealth(url: string, timeoutMs: number): Promise<boolean> {
  // `/api/health` matches the path probe.sh uses — keep them aligned.
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${url}/api/health`);
      if (res.ok) return true;
    } catch {
      // not ready yet
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  return false;
}

export async function run(args: string[]): Promise<void> {
  const reuse = args.includes('--reuse');
  const remoteUrlIdx = args.indexOf('--remote-url');
  const remoteUrl = remoteUrlIdx !== -1 ? args[remoteUrlIdx + 1] : null;
  const ctx = instanceContext();
  if (ctx.name) {
    log.info('OneCLI setup for instance', {
      instance: ctx.name,
      composeProject: ctx.composeProject,
      installDir: ctx.installDir,
      appPort: ctx.appPort,
    });
    // appPort is only needed for the local-install path (installOnecli).
    // --reuse and --remote-url legitimately point at gateways without a
    // port in the URL (e.g. https://onecli.example.com), so parseEnvPort
    // returns null — don't abort those flows here. The local-install
    // branch below re-checks and bails with the same message if missing.
    if (ctx.appPort === null && !reuse && !remoteUrl) {
      log.error(
        `Could not parse ONECLI_URL port from ${ctx.envFile}. ` +
          `Run \`scripts/render-instance-env.sh ${ctx.name}\` to generate the per-instance .env, then re-run \`make install\`.`,
      );
      process.exit(1);
    }
  }
  ensureShellProfilePath();

  if (remoteUrl) {
    // Remote-mode: install only the CLI, point it at the remote gateway, and
    // record the URL in .env. No local gateway is started.
    log.info('Installing OneCLI CLI for remote gateway', { remoteUrl });
    const res = installOnecliCliOnly();
    if (!res.ok || !onecliVersion()) {
      emitStatus('ONECLI', {
        INSTALLED: false,
        STATUS: 'failed',
        ERROR: 'cli_install_failed',
        HINT: 'CLI binary install failed. Make sure curl is installed and ~/.local/bin is writable.',
        LOG: 'logs/setup.log',
      });
      process.exit(1);
    }
    try {
      execFileSync('onecli', ['config', 'set', 'api-host', remoteUrl], {
        stdio: 'ignore',
        env: childEnv(),
      });
    } catch (err) {
      log.warn('onecli config set api-host failed', { err });
    }
    writeEnvOnecliUrl(remoteUrl, ctx.envFile);
    log.info('Wrote ONECLI_URL to .env', { url: remoteUrl });
    const remoteToken = process.env.NANOCLAW_ONECLI_API_TOKEN?.trim();
    if (remoteToken) {
      // Two auth surfaces: `onecli auth login` persists the key for CLI
      // calls during setup itself (e.g. detecting an existing Anthropic
      // secret via `onecli secrets list`), and ONECLI_API_KEY in .env is
      // read by the runtime SDK at request time. Both are needed.
      try {
        execFileSync('onecli', ['auth', 'login', '--api-key', remoteToken], {
          stdio: 'ignore',
          env: childEnv(),
        });
      } catch (err) {
        log.warn('onecli auth login failed', { err });
      }
      writeEnvVar('ONECLI_API_KEY', remoteToken, ctx.envFile);
      log.info('Wrote ONECLI_API_KEY to .env', { envFile: ctx.envFile });
    }
    const healthy = await pollHealth(remoteUrl, 5000);
    emitStatus('ONECLI', {
      INSTALLED: true,
      REMOTE: true,
      ONECLI_URL: remoteUrl,
      HEALTHY: healthy,
      STATUS: 'success',
      LOG: 'logs/setup.log',
    });
    return;
  }

  if (reuse) {
    // Reuse-mode: don't touch the running gateway at all. Just verify it
    // exists, read its api-host, write ONECLI_URL to .env, and move on.
    const version = onecliVersion();
    if (!version) {
      emitStatus('ONECLI', {
        INSTALLED: false,
        STATUS: 'failed',
        ERROR: 'onecli_not_found_for_reuse',
        HINT: 'onecli not on PATH. Re-run setup and choose "install fresh".',
        LOG: 'logs/setup.log',
      });
      process.exit(1);
    }
    const url = getOnecliApiHost();
    if (!url) {
      emitStatus('ONECLI', {
        INSTALLED: true,
        STATUS: 'failed',
        ERROR: 'onecli_api_host_not_configured',
        HINT: 'Existing onecli has no api-host set. Run `onecli config set api-host <url>` or re-run setup with install-fresh.',
        LOG: 'logs/setup.log',
      });
      process.exit(1);
    }
    writeEnvOnecliUrl(url, ctx.envFile);
    log.info('Reusing existing OneCLI', { url, envFile: ctx.envFile });
    const healthy = await pollHealth(url, 5000);
    emitStatus('ONECLI', {
      INSTALLED: true,
      REUSED: true,
      ONECLI_URL: url,
      HEALTHY: healthy,
      STATUS: 'success',
      LOG: 'logs/setup.log',
    });
    return;
  }

  // Local-install path: per-instance ports are required. The earlier
  // precheck skips this case when --reuse/--remote-url is set; here it's
  // genuinely missing config.
  if (ctx.name && ctx.appPort === null) {
    // Distinguish "file missing entirely" from "file present but
    // ONECLI_URL has no port" — different fix in each case.
    if (!fs.existsSync(ctx.envFile)) {
      log.error(
        `Per-instance .env not found at ${ctx.envFile}. ` +
          `Add "${ctx.name}" to INSTANCES in instances.conf and run \`make install\`, ` +
          `or generate just this one with \`scripts/render-instance-env.sh ${ctx.name}\`.`,
      );
    } else {
      log.error(
        `ONECLI_URL in ${ctx.envFile} has no port — local install needs a localhost URL with an explicit port (e.g. http://127.0.0.1:10354). ` +
          `If you meant to target a hosted remote gateway, re-run with \`--reuse\` or \`--remote-url ${process.env.ONECLI_URL || '<url>'}\` instead.`,
      );
    }
    process.exit(1);
  }
  log.info('Installing OneCLI gateway and CLI');
  const res = installOnecli(ctx);
  if (!res.ok) {
    emitStatus('ONECLI', {
      INSTALLED: false,
      STATUS: 'failed',
      ERROR: 'install_failed',
      LOG: 'logs/setup.log',
    });
    process.exit(1);
  }
  if (!onecliVersion()) {
    emitStatus('ONECLI', {
      INSTALLED: false,
      STATUS: 'failed',
      ERROR: 'onecli_not_on_path_after_install',
      HINT: 'Open a new shell or run `export PATH="$HOME/.local/bin:$PATH"` and retry.',
      LOG: 'logs/setup.log',
    });
    process.exit(1);
  }

  // For multi-instance: trust the configured port from instances/<name>/.env
  // rather than whatever the installer printed (which might be the default
  // even when the gateway honored our override). For single-install: parse
  // the URL out of the installer output, as before.
  let url: string | null;
  if (ctx.name && ctx.appPort !== null) {
    url = `http://127.0.0.1:${ctx.appPort}`;
    log.info('Using configured instance OneCLI URL', { url, instance: ctx.name });
  } else {
    url = extractUrlFromOutput(res.stdout);
  }
  if (!url) {
    emitStatus('ONECLI', {
      INSTALLED: true,
      STATUS: 'failed',
      ERROR: 'could_not_resolve_api_host',
      HINT: 'Inspect logs/setup.log for the install output.',
      LOG: 'logs/setup.log',
    });
    process.exit(1);
  }

  try {
    execFileSync('onecli', ['config', 'set', 'api-host', url], {
      stdio: 'ignore',
      env: childEnv(),
    });
  } catch (err) {
    log.warn('onecli config set api-host failed', { err });
  }

  writeEnvOnecliUrl(url, ctx.envFile);
  log.info('Wrote ONECLI_URL to .env', { url, envFile: ctx.envFile });

  const healthy = await pollHealth(url, 15000);
  if (ctx.name && !healthy) {
    log.error(
      `OneCLI gateway for instance "${ctx.name}" is not responding at ${url}. ` +
        `Check 'docker compose --project-directory ${ctx.installDir} -p ${ctx.composeProject} ps' ` +
        `and 'docker compose --project-directory ${ctx.installDir} -p ${ctx.composeProject} logs' on the host.`,
    );
  }

  emitStatus('ONECLI', {
    INSTALLED: true,
    ONECLI_URL: url,
    HEALTHY: healthy,
    // Install succeeded regardless — a failed health poll often just means
    // the endpoint is auth-gated or the gateway hasn't finished warming up.
    // The next step (auth) will surface a genuinely broken gateway via
    // `onecli secrets list`, so don't trigger rescue attempts from here.
    STATUS: 'success',
    ...(healthy
      ? {}
      : {
          HEALTH_HINT:
            'Health poll returned non-ok within 15s — likely auth-gated. Proceed to the auth step; it will surface a real outage.',
        }),
    LOG: 'logs/setup.log',
  });
}
