/**
 * Step: set-env — Write or update a KEY=VALUE in .env, with optional sync to
 * data/env/env (the container-mounted copy).
 *
 * Usage:
 *   pnpm exec tsx setup/index.ts --step set-env -- \
 *     --key TELEGRAM_BOT_TOKEN --value "<token>" [--sync-container]
 *
 * Exists so channel-install flows don't have to invent grep/sed/rm pipelines
 * (which can't be allowlisted tightly — sed can read any file, and each
 * segment of an && chain is matched separately).
 *
 * Logs the key but never the value.
 */
import fs from 'fs';
import path from 'path';

import { log } from '../src/log.js';
import { emitStatus } from './status.js';

export async function run(args: string[]): Promise<void> {
  const keyIdx = args.indexOf('--key');
  const valueIdx = args.indexOf('--value');
  const syncContainer = args.includes('--sync-container');

  if (keyIdx === -1 || !args[keyIdx + 1]) {
    throw new Error('--key <KEY> is required');
  }
  if (valueIdx === -1 || args[valueIdx + 1] === undefined) {
    throw new Error('--value <VALUE> is required');
  }

  const key = args[keyIdx + 1];
  const value = args[valueIdx + 1];

  if (!/^[A-Z][A-Z0-9_]*$/.test(key)) {
    throw new Error(`Invalid env key: ${key} (must be UPPER_SNAKE_CASE)`);
  }

  const projectRoot = process.cwd();
  // Multi-instance: route writes to instances/<name>/.env when NCL_INSTANCE
  // is set, so channel-install flows land tokens in the per-instance file
  // that the host actually reads (matches src/config.ts ENV_FILE_PATH).
  const instance = (process.env.NCL_INSTANCE || '').trim();
  const stateDir = instance ? path.join(projectRoot, 'instances', instance) : projectRoot;
  const envFile = path.join(stateDir, '.env');
  fs.mkdirSync(stateDir, { recursive: true });

  let content = '';
  if (fs.existsSync(envFile)) {
    content = fs.readFileSync(envFile, 'utf-8');
  }

  const lineRegex = new RegExp(`^${key}=.*$`, 'm');
  const newLine = `${key}=${value}`;
  const existed = lineRegex.test(content);

  if (existed) {
    content = content.replace(lineRegex, newLine);
  } else {
    const sep = content && !content.endsWith('\n') ? '\n' : '';
    content = content + sep + newLine + '\n';
  }

  fs.writeFileSync(envFile, content);
  log.info('Updated .env', { key, existed });

  let synced = false;
  if (syncContainer) {
    // Container mount path is also instance-scoped — instances/<name>/data/env/env.
    const dataEnvDir = path.join(stateDir, 'data', 'env');
    fs.mkdirSync(dataEnvDir, { recursive: true });
    fs.copyFileSync(envFile, path.join(dataEnvDir, 'env'));
    synced = true;
    log.info('Synced .env to container mount', { path: path.relative(projectRoot, path.join(dataEnvDir, 'env')) });
  }

  emitStatus('SET_ENV', {
    KEY: key,
    EXISTED: existed,
    SYNCED_TO_CONTAINER: synced,
    STATUS: 'success',
  });
}
