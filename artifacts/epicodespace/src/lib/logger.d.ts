export interface LogEntry {
  level: 'debug' | 'info' | 'warn' | 'error';
  scope: string;
  message: string;
  data?: unknown;
  ts: number;
}

export interface Logger {
  debug(scope: string, msg: string, data?: unknown): void;
  info(scope: string, msg: string, data?: unknown): void;
  warn(scope: string, msg: string, data?: unknown): void;
  error(scope: string, msg: string, data?: unknown): void;
  getBuffer(): LogEntry[];
  subscribe(fn: (entry: LogEntry) => void): () => boolean;
  clear(): void;
}

export const logger: Logger;
export default logger;