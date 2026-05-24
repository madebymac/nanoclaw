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

// Remove containers in the configured compose project whose service name
// isn't in the v2 set. Pre-v2 OneCLI used service "app" (container
// onecli-app-1); v2 uses "onecli". Compose flags the old container as an
// orphan but won't stop it without --remove-orphans, leaving the app port
// bound and crashing the new bring-up. Filed upstream; this is the
// downstream workaround.
function removeLegacyOnecliContainers(composeProject: string): string {
  const out: string[] = [];
  let list = '';
  try {
    list = execSync(
      `docker ps -a --filter "label=com.docker.compose.project=${composeProject}" --format '{{.Names}}|{{.Label "com.docker.compose.service"}}'`,
      { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] },
    ).trim();
  } catch {
    return '';
  }
  if (!list) return '';
  const v2Services = new Set(['onecli', 'postgres']);
  for (const line of list.split('\n')) {
    const [name, service] = line.split('|');
    if (!name || !service || v2Services.has(service)) continue;
    out.push(`Removing legacy OneCLI container: ${name} (service=${service})`);
    try {
      execSync(`docker rm -f ${JSON.stringify(name)}`, { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) {
      out.push(`  rm failed (continuing): ${(err as Error).message}`);
    }
  }
  return out.join('\n');
}

function installOnecli(ctx: ReturnType<typeof instanceContext>): { stdout: string; ok: boolean } {
  let stdout = '';

  const cleanup = removeLegacyOnecliContainers(ctx.composeProject);
  if (cleanup) stdout += cleanup + '\n';

  // Gateway install (docker-compose based, no rate-limit concerns).
  // For multi-instance: set COMPOSE_PROJECT_NAME so the upstream installer's
  // `docker compose up` lands under our per-instance project, and pass a
  // speculative bundle of port/dir override env vars in case the installer
  // honors them. Single-install path (NCL_INSTANCE unset) omits the exports
  // entirely so behavior is bit-identical to before.
  const overrideExports = buildInstallerExports(ctx);
  const gw = runInstall(
    `${overrideExports}export ONECLI_VERSION=${ONECLI_GATEWAY_VERSION} && curl -fsSL onecli.sh/install | sh`,
  );
  stdout += gw.stdout;
  if (!gw.ok) {
    log.error('OneCLI gateway install failed', { stderr: gw.stderr });
    return { stdout: stdout + (gw.stderr ?? ''), ok: false };
  }

  // CLI install. The upstream script calls the GitHub releases API
  // (api.github.com) to resolve the latest tag — which 403s anonymous
  // callers after 60 requests/hour per IP. Try upstream first; on failure
  // resolve the version ourselves (via HTTP redirect, which isn't
  // API-throttled) and download the release archive directly.
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
 * Build the `export FOO=bar && ` prefix for the upstream installer invocation.
 * For single-install (ctx.name === '') returns '' so the curl-piped sh sees
 * exactly the environment it always saw. For per-instance installs, exports
 * COMPOSE_PROJECT_NAME (standard docker-compose env — almost certainly
 * honored) plus a best-effort bundle of port/dir override names. If the
 * upstream installer ignores the port overrides, the gateway will land on
 * its default port and the subsequent health/URL check will fail visibly
 * rather than silently misbehave.
 */
function buildInstallerExports(ctx: ReturnType<typeof instanceContext>): string {
  if (!ctx.name) return '';
  const parts: string[] = [`COMPOSE_PROJECT_NAME=${ctx.composeProject}`, `ONECLI_HOME=${ctx.installDir}`];
  if (ctx.appPort !== null) {
    parts.push(`ONECLI_APP_PORT=${ctx.appPort}`);
    parts.push(`ONECLI_PORT=${ctx.appPort}`);
  }
  if (ctx.gatewayPort !== null) parts.push(`ONECLI_GATEWAY_PORT=${ctx.gatewayPort}`);
  if (ctx.postgresPort !== null) parts.push(`ONECLI_POSTGRES_PORT=${ctx.postgresPort}`);
  return parts.map((p) => `export ${p}`).join(' && ') + ' && ';
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
          `Run \`make new-instance NAME=${ctx.name}\` first to generate the per-instance .env.`,
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
    log.error(
      `Could not parse ONECLI_URL port from ${ctx.envFile}. ` +
        `Run \`make new-instance NAME=${ctx.name}\` first to generate the per-instance .env.`,
    );
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
        `The upstream installer may have ignored ONECLI_APP_PORT/ONECLI_PORT overrides. ` +
        `Check 'docker compose -p ${ctx.composeProject} ps' and 'docker compose -p ${ctx.composeProject} logs' on the host.`,
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
