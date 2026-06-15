import type { LogLevel } from "./config.js";

export interface Logger {
  info(msg: string, ctx?: Record<string, unknown>): void;
  warn(msg: string, ctx?: Record<string, unknown>): void;
  error(msg: string, ctx?: Record<string, unknown>): void;
}

export function createLogger(level: LogLevel): Logger {
  const levels = { debug: 0, info: 1, warn: 2, error: 3 };
  const minLevel = levels[level] ?? 1;

  function log(l: LogLevel, msg: string, ctx?: Record<string, unknown>) {
    if (levels[l] < minLevel) return;
    const out = { level: l, msg, ...ctx };
    process.stdout.write(JSON.stringify(out) + "\n");
  }

  return {
    info: (msg, ctx) => log("info", msg, ctx),
    warn: (msg, ctx) => log("warn", msg, ctx),
    error: (msg, ctx) => log("error", msg, ctx),
  };
}
