export type LogLevel = "debug" | "info" | "warn" | "error";

export interface Config {
  port: number;
  logLevel: LogLevel;
}

export function loadConfig(): Config {
  return {
    port: Number(process.env.PORT) || 3000,
    logLevel: (process.env.LOG_LEVEL as LogLevel) ?? "info",
  };
}
