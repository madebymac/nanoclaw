import { format as utilFormat } from 'node:util';

const LEVELS = { debug: 20, info: 30, warn: 40, error: 50, fatal: 60 } as const;
type Level = keyof typeof LEVELS;

const COLORS: Record<Level, string> = {
  debug: '\x1b[34m',
  info: '\x1b[32m',
  warn: '\x1b[33m',
  error: '\x1b[31m',
  fatal: '\x1b[41m\x1b[37m',
};
const KEY_COLOR = '\x1b[35m';
const MSG_COLOR = '\x1b[36m';
const RESET = '\x1b[39m';
const FULL_RESET = '\x1b[0m';

const threshold = LEVELS[(process.env.LOG_LEVEL as Level) || 'info'] ?? LEVELS.info;

function formatErr(err: unknown): string {
  if (err instanceof Error) {
    return `{ type: "${err.constructor.name}", message: "${err.message}", stack: ${err.stack} }`;
  }
  return JSON.stringify(err);
}

function formatData(data: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const [k, v] of Object.entries(data)) {
    parts.push(`${KEY_COLOR}${k}${RESET}=${k === 'err' ? formatErr(v) : JSON.stringify(v)}`);
  }
  return parts.length ? ' ' + parts.join(' ') : '';
}

function ts(): string {
  return new Date().toISOString();
}

function emit(level: Level, msg: string, data?: Record<string, unknown>): void {
  if (LEVELS[level] < threshold) return;
  const tag = `${COLORS[level]}${level.toUpperCase()}${level === 'fatal' ? FULL_RESET : RESET}`;
  const stream = LEVELS[level] >= LEVELS.warn ? process.stderr : process.stdout;
  stream.write(`[${ts()}] ${tag} ${MSG_COLOR}${msg}${RESET}${data ? formatData(data) : ''}\n`);
}

export const log = {
  debug: (msg: string, data?: Record<string, unknown>) => emit('debug', msg, data),
  info: (msg: string, data?: Record<string, unknown>) => emit('info', msg, data),
  warn: (msg: string, data?: Record<string, unknown>) => emit('warn', msg, data),
  error: (msg: string, data?: Record<string, unknown>) => emit('error', msg, data),
  fatal: (msg: string, data?: Record<string, unknown>) => emit('fatal', msg, data),
};

// Third-party deps (e.g. @chat-adapter/telegram) write directly to
// console.{log,warn,error}, bypassing our logger and producing un-timestamped
// lines. installConsoleCapture() routes them through emit() so every line
// lands with the same prefix. Opt-in — call once from the entry point so
// importing { log } from tests does not silently rewrite console.
export function installConsoleCapture(): void {
  const formatArg = (a: unknown): unknown => (a instanceof Error ? formatErr(a) : a);

  const write = (level: Level, args: unknown[]) => {
    if (LEVELS[level] < threshold) return;
    const tag = `${COLORS[level]}${level.toUpperCase()}${level === 'fatal' ? FULL_RESET : RESET}`;
    const stream = LEVELS[level] >= LEVELS.warn ? process.stderr : process.stdout;
    const prefix = `[${ts()}] ${tag} `;
    const body = utilFormat(...args.map(formatArg)).replace(/\n/g, '\n' + prefix);
    stream.write(prefix + body + '\n');
  };

  // console.log → debug: chatty deps tend to use log() for verbose output;
  // routing it to info would spam nanoclaw.log. Explicit console.info still
  // lands at info.
  const c = console as Console & Record<string, unknown>;
  c.log = (...args: unknown[]) => write('debug', args);
  c.info = (...args: unknown[]) => write('info', args);
  c.warn = (...args: unknown[]) => write('warn', args);
  c.error = (...args: unknown[]) => write('error', args);
  c.debug = (...args: unknown[]) => write('debug', args);
}

process.on('uncaughtException', (err) => {
  log.fatal('Uncaught exception', { err });
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  log.error('Unhandled rejection', { err: reason });
});
