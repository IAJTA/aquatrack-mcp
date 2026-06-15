export type LogLevel = "debug" | "info" | "warn" | "error";

export interface Config {
  port: number;
  logLevel: LogLevel;
  aquatrackUrl: string;
}

export function loadConfig(): Config {
  return {
    port: Number(process.env.PORT) || 3000,
    logLevel: (process.env.LOG_LEVEL as LogLevel) ?? "info",
    aquatrackUrl: (
      process.env.AQUATRACK_URL ?? "https://api.aquatrack.net"
    ).replace(/\/+$/, ""),
  };
}
