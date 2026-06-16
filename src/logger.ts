import type { LogLevel } from "./config.js";

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

const LEVEL_LABEL: Record<LogLevel, string> = {
  debug: "DEBUG",
  info: " INFO",
  warn: " WARN",
  error: "ERROR",
};

const LEVEL_COLOR: Record<LogLevel, string> = {
  debug: "\x1b[90m",
  info: "\x1b[34m",
  warn: "\x1b[33m",
  error: "\x1b[31m",
};

const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";

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

  const ts = () => {
    const d = new Date();
    return d.toISOString().slice(0, 19).replace("T", " ");
  };

  const formatCtx = (fields?: Record<string, unknown>): string => {
    if (!fields || Object.keys(fields).length === 0) return "";
    const entries = Object.entries(fields).map(
      ([k, v]) => `  ${DIM}${k}:${RESET} ${String(v)}`,
    );
    return "\n" + entries.join("\n");
  };

  const emit = (
    lvl: LogLevel,
    msg: string,
    fields?: Record<string, unknown>,
  ) => {
    if (LEVEL_ORDER[lvl] < min) return;
    const color = LEVEL_COLOR[lvl];
    const label = LEVEL_LABEL[lvl];
    const line = `${DIM}${ts()}${RESET} ${color}${BOLD}${label}${RESET}  ${redact(msg)}${formatCtx(fields)}`;
    process.stderr.write(line + "\n");
  };

  return {
    debug: (m, f) => emit("debug", m, f),
    info: (m, f) => emit("info", m, f),
    warn: (m, f) => emit("warn", m, f),
    error: (m, f) => emit("error", m, f),
    redact,
  };
}
