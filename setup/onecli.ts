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
import { randomBytes } from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { readInstanceName } from '../src/instance-name.js';
import { log } from '../src/log.js';
import { emitStatus } from './status.js';

const LOCAL_BIN = path.join(os.homedir(), '.local', 'bin');

/**
 * Default docker bridge gateway IP on Linux. Used as the bind host so
 * containers spawned by nanoclaw can reach the gateway — `127.0.0.1`
 * from inside a child container is the container itself, not the host.
 * Operators with a non-default docker network can override by setting
 * ONECLI_BIND_HOST in their per-instance OneCLI .env before first install.
 *
 * Linux-only default. Docker Desktop on macOS/WSL doesn't expose a host
 * IP at 172.17.0.1 (host-gateway lives at host.docker.internal there), so
 * dev-mode operators running the instance flow off-Pi must override
 * ONECLI_BIND_HOST themselves.
 */
const DEFAULT_BIND_HOST = '172.17.0.1';

function readPersistedBindHost(installDir: string): string {
  try {
    const content = fs.readFileSync(path.join(installDir, '.env'), 'utf-8');
    // Allow optional surrounding quotes and a trailing `# comment`; stop
    // at whitespace. Previously matched `.+` which captured the quotes
    // and any trailing comment as part of the host string.
    const m = /^ONECLI_BIND_HOST=["']?([^"'#\s]+)/m.exec(content);
    if (m) return m[1].trim();
  } catch {
    // File doesn't exist yet (first install) — fall through to default.
  }
  return DEFAULT_BIND_HOST;
}

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
  bindHost: string;
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
      bindHost: DEFAULT_BIND_HOST,
    };
  }
  const envFile = path.join(projectRoot, 'instances', name, '.env');
  // Port triple is already written into instances/<name>/.env by
  // scripts/render-instance-env.sh — parse it back out so the upstream
  // installer (and the legacy-cleanup probe) see the right numbers.
  const appPort = parseEnvPort(envFile, 'ONECLI_URL');
  const installDir = path.join(os.homedir(), `.onecli-${name}`);
  return {
    name,
    composeProject: `onecli-${name}`,
    envFile,
    installDir,
    appPort,
    gatewayPort: appPort !== null ? appPort + 1 : null,
    postgresPort: appPort !== null ? appPort + 2 : null,
    // Bind host the gateway is (or will be) bound to. Read from the
    // per-instance OneCLI .env if it exists (so operator overrides
    // persist across deploys); otherwise the same default we use when
    // we render that file in installInstanceGateway().
    bindHost: readPersistedBindHost(installDir),
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
  //   .env                — port triple, bind host, version, (optional NEXTAUTH_SECRET)
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

  // Render the template into the per-instance dir. Done unconditionally so
  // template fixes propagate on the next deploy tick. The NEXTAUTH_SECRET
  // line is conditionally emitted below — see the comment near
  // hasGoogleOAuth for why we can't just leave it interpolating to "".
  const templatePath = path.join(process.cwd(), 'setup', 'onecli', 'docker-compose.yml.template');
  const composePath = path.join(ctx.installDir, 'docker-compose.yml');
  const template = fs.readFileSync(templatePath, 'utf-8');

  // Per-instance .env. NEXTAUTH_SECRET is only meaningful in OAuth mode —
  // recent OneCLI versions refuse to start when it's set (even to "")
  // without GOOGLE_CLIENT_ID/SECRET. Default installs run in local mode,
  // so we omit the secret unless the user has manually added Google OAuth
  // creds to the existing .env. Any previously-persisted secret without
  // matching OAuth creds is stripped to unblock the gateway. The compose
  // template's NEXTAUTH_SECRET line is also conditionally rendered below,
  // because `NEXTAUTH_SECRET: ${NEXTAUTH_SECRET:-}` still injects the var
  // as an empty string into the container, which OneCLI treats as "set".
  //
  // Google OAuth env vars and any other user-added lines are preserved
  // across redeploys — the writeback only owns the keys it explicitly sets.
  const envPath = path.join(ctx.installDir, '.env');
  const existing = fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf-8') : '';
  const hasGoogleOAuth =
    /^GOOGLE_CLIENT_ID=.+$/m.test(existing) && /^GOOGLE_CLIENT_SECRET=.+$/m.test(existing);
  const persistedSecret = /^NEXTAUTH_SECRET=(.+)$/m.exec(existing)?.[1];
  const nextauthSecret = hasGoogleOAuth ? persistedSecret || randomSecret() : null;
  // ctx.bindHost was already resolved from the same file (or
  // DEFAULT_BIND_HOST). Re-using it here keeps the gateway bind and the
  // ONECLI_URL written into instances/<name>/.env in lock-step.
  const bindHost = ctx.bindHost;

  const managedKeys = new Set([
    'ONECLI_VERSION',
    'ONECLI_BIND_HOST',
    'ONECLI_APP_PORT',
    'ONECLI_GATEWAY_PORT',
    'POSTGRES_PORT',
    'NEXTAUTH_SECRET',
  ]);
  // Skip the previous auto-generated header (leading comment + blank
  // lines) so it doesn't accumulate on each redeploy. After that, drop
  // only managed KEY=VALUE lines; user comments, blank lines, and
  // unknown keys are preserved verbatim.
  const allLines = existing.split('\n');
  let bodyStart = 0;
  while (bodyStart < allLines.length) {
    const line = allLines[bodyStart];
    if (line.startsWith('#') || line.trim() === '') bodyStart++;
    else break;
  }
  const preserved = allLines.slice(bodyStart).filter((line) => {
    const m = /^([A-Z_][A-Z0-9_]*)=/.exec(line);
    return m ? !managedKeys.has(m[1]) : true;
  });
  // Trim trailing blank lines — the writeback adds its own.
  while (preserved.length > 0 && preserved[preserved.length - 1].trim() === '') {
    preserved.pop();
  }

  const envLines = [
    `# Auto-generated by setup/onecli.ts. Managed keys (rewritten every`,
    `# deploy tick): ONECLI_VERSION, ONECLI_BIND_HOST, ONECLI_*_PORT,`,
    `# POSTGRES_PORT, NEXTAUTH_SECRET. Anything else you add here is`,
    `# preserved across redeploys.`,
    `ONECLI_VERSION=${ONECLI_GATEWAY_VERSION}`,
    `ONECLI_BIND_HOST=${bindHost}`,
    `ONECLI_APP_PORT=${ctx.appPort}`,
    `ONECLI_GATEWAY_PORT=${ctx.gatewayPort}`,
    `POSTGRES_PORT=${ctx.postgresPort}`,
    ...(nextauthSecret ? [`NEXTAUTH_SECRET=${nextauthSecret}`] : []),
    ...preserved,
    '',
  ];
  fs.writeFileSync(envPath, envLines.join('\n'), { mode: 0o600 });

  // Render the compose file: emit the NEXTAUTH_SECRET environment line
  // only when we actually have a secret to pass. Otherwise the var would
  // land in the container as "" and the gateway would refuse to boot.
  const nextauthLine = nextauthSecret ? 'NEXTAUTH_SECRET: ${NEXTAUTH_SECRET}' : '';
  const rendered = template
    .split('\n')
    .flatMap((line) => {
      if (!line.includes('__NEXTAUTH_SECRET_LINE__')) return [line];
      if (!nextauthLine) return [];
      return [line.replace(/#\s*__NEXTAUTH_SECRET_LINE__.*$/, nextauthLine)];
    })
    .join('\n');
  fs.writeFileSync(composePath, rendered);

  const cmd = `docker compose --project-directory ${JSON.stringify(ctx.installDir)} -p ${JSON.stringify(ctx.composeProject)} up -d`;
  return runInstall(cmd);
}

function randomSecret(): string {
  // 32 random bytes, base64url-encoded. Enough entropy for NextAuth's
  // signing secret; matches the upstream installer's openssl rand approach.
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
    // bindHost matches what installInstanceGateway wrote into
    // ~/.onecli-<name>/.env, so the URL we hand to the instance host
    // resolves to the actual gateway's bind address. Previously hardcoded
    // 127.0.0.1, which failed when the gateway binds to 172.17.0.1
    // (default — so child containers can reach it via docker bridge).
    url = `http://${ctx.bindHost}:${ctx.appPort}`;
    log.info('Using configured instance OneCLI URL', { url, instance: ctx.name, bindHost: ctx.bindHost });
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
