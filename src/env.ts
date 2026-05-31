import fs from 'fs';
import { log } from './log.js';

/**
 * Parse the .env file and return values for the requested keys.
 * Does NOT load anything into process.env — callers decide what to
 * do with the values. This keeps secrets out of the process environment
 * so they don't leak to child processes.
 *
 * `envFilePath` is required (no process.cwd() fallback) so callers always
 * resolve the project-root .env explicitly. Pass `ENV_FILE_PATH` from
 * src/config.ts.
 */
export function readEnvFile(keys: string[], envFilePath: string): Record<string, string> {
  let content: string;
  try {
    content = fs.readFileSync(envFilePath, 'utf-8');
  } catch (err) {
    log.debug('.env file not found, using defaults', { err });
    return {};
  }

  const result: Record<string, string> = {};
  const wanted = new Set(keys);

  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    if (!wanted.has(key)) continue;
    let value = trimmed.slice(eqIdx + 1).trim();
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    }
    if (value) result[key] = value;
  }

  return result;
}
