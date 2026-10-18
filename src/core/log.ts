/** 日志（design.md §2 core/log）：级别过滤、stderr 输出。main/tools 之外禁止 console。 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'silent';

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3, silent: 4 };

let current: LogLevel = 'info';

export function setLogLevel(level: LogLevel): void {
  current = level;
}

export function getLogLevel(): LogLevel {
  return current;
}

function emit(level: Exclude<LogLevel, 'silent'>, prefix: string, msg: string): void {
  if (LEVEL_ORDER[level] < LEVEL_ORDER[current]) return;
  const ts = new Date().toISOString().slice(11, 23);
  const out = level === 'debug' || level === 'info' ? console.log : console.error;
  out(`${ts} [${level.toUpperCase()}]${prefix ? ' ' + prefix : ''} ${msg}`);
}

export interface Logger {
  debug(msg: string): void;
  info(msg: string): void;
  warn(msg: string): void;
  error(msg: string): void;
  child(prefix: string): Logger;
}

export function logger(prefix = ''): Logger {
  return {
    debug: (m) => emit('debug', prefix, m),
    info: (m) => emit('info', prefix, m),
    warn: (m) => emit('warn', prefix, m),
    error: (m) => emit('error', prefix, m),
    child: (p) => logger(prefix ? `${prefix}:${p}` : p),
  };
}
