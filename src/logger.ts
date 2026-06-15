import type { LogLevel } from "./config.js";

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export interface Logger {
  info(msg: string, ctx?: Record<string, unknown>): void;
  warn(msg: string, ctx?: Record<string, unknown>): void;
  error(msg: string, ctx?: Record<string, unknown>): void;
  redact(input: string): string;
  debug(msg: string, fields?: Record<string, unknown>): void;
}

export function createLogger(level: LogLevel, secrets: string[]): Logger {
  const levels = { debug: 0, info: 1, warn: 2, error: 3 };
  const minLevel = levels[level] ?? 1;
  const patterns = secrets.filter((s) => s && s.length >= 4);

  function log(l: LogLevel, msg: string, ctx?: Record<string, unknown>) {
    if (levels[l] < minLevel) return;
    const out = { level: l, msg, ...ctx };
    process.stdout.write(JSON.stringify(out) + "\n");
  }

  const redact = (input: string): string => {
    let out = input;
    for (const secret of patterns) {
      out = out.split(secret).join("***");
    }
    out = out.replace(/(accessToken|refreshToken|password|authorization)=[^;,\s"]+/gi, "$1=***");
    return out;
  };

  return {
    info: (msg, ctx) => log("info", msg, ctx),
    warn: (msg, ctx) => log("warn", msg, ctx),
    error: (msg, ctx) => log("error", msg, ctx),
    debug: (m, f) => log("debug", m, f),
    redact,
  };
}
