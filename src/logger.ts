import type { LogLevel } from "./config.js";

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

export interface Logger {
  info(msg: string, ctx?: Record<string, unknown>): void;
  warn(msg: string, ctx?: Record<string, unknown>): void;
  error(msg: string, ctx?: Record<string, unknown>): void;
  redact(input: string): string;
  debug(msg: string, fields?: Record<string, unknown>): void;
}

export function createLogger(level: LogLevel, secrets: string[]): Logger {
  const min = LEVEL_ORDER[level] ?? LEVEL_ORDER.info;
  const patterns = secrets.filter((s) => s && s.length >= 4);

  const redact = (input: string): string => {
    let out = input;
    for (const secret of patterns) {
      out = out.split(secret).join("***");
    }
    out = out.replace(
      /(accessToken|refreshToken|password|authorization)=[^;,\s"]+/gi,
      "$1=***",
    );
    return out;
  };

  const emit = (
    lvl: LogLevel,
    msg: string,
    fields?: Record<string, unknown>,
  ) => {
    if (LEVEL_ORDER[lvl] < min) return;
    const line: Record<string, unknown> = {
      ts: new Date().toISOString(),
      level: lvl,
      msg: redact(msg),
    };
    if (fields) {
      for (const [k, v] of Object.entries(fields)) {
        line[k] = typeof v === "string" ? redact(v) : v;
      }
    }
    process.stderr.write(JSON.stringify(line) + "\n");
  };

  return {
    debug: (m, f) => emit("debug", m, f),
    info: (m, f) => emit("info", m, f),
    warn: (m, f) => emit("warn", m, f),
    error: (m, f) => emit("error", m, f),
    redact,
  };
}
