export type LogLevel = "debug" | "info" | "warn" | "error";

export interface Config {
  port: number;
  logLevel: LogLevel;
  aquatrackUrl: string;
  maxRetries: number;
  requestTimeoutMs: number;
}

function optional(name: string): string | undefined {
  const v = process.env[name];
  return v && v.trim() !== "" ? v.trim() : undefined;
}

function intEnv(name: string, fallback: number): number {
  const raw = optional(name);
  if (raw === undefined) return fallback;
  const n = Number.parseInt(raw, 10);
  if (Number.isNaN(n) || n <= 0) {
    throw new Error(`${name} must be a positive integer (got "${raw}")`);
  }
  return n;
}

export function loadConfig(): Config {
  return {
    port: Number(process.env.PORT) || 3000,
    logLevel: (process.env.LOG_LEVEL as LogLevel) ?? "info",
    aquatrackUrl: (
      process.env.AQUATRACK_URL ?? "https://api.aquatrack.net"
    ).replace(/\/+$/, ""),
    maxRetries: intEnv("AQUATRACK_MAX_RETRIES", 2),
    requestTimeoutMs: intEnv("AQUATRACK_TIMEOUT_MS", 15_000),
  };
}
