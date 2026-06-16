export type LogLevel = "debug" | "info" | "warn" | "error";

export interface Config {
  publicUrl: string;
  port: number;
  aquatrackUrl: string;

  oauthEnabled: boolean;
  evalToken?: string;
  serviceEmail?: string;
  servicePassword?: string;

  allowedOrigins: string[];
  allowedHosts: string[];
  dnsRebindingProtection: boolean;

  trustProxy: number;
  scopesSupported: string[];
  resourceName: string;
  serverName: string;
  serverVersion: string;
  logLevel: LogLevel;
  accessTokenTtlMs: number;
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

function list(name: string): string[] {
  const raw = optional(name);
  if (!raw) return [];
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

export function loadConfig(): Config {
  const aquatrackUrl = (
    optional("AQUATRACK_URL") ?? "https://api.aquatrack.net"
  ).replace(/\/+$/, "");

  const oauthEnabled =
    (optional("OAUTH_ENABLED") ?? "true").toLowerCase() !== "false";
  const evalToken = optional("MCP_EVAL_TOKEN");
  const serviceEmail = optional("AQUATRACK_SERVICE_EMAIL");
  const servicePassword = optional("AQUATRACK_SERVICE_PASSWORD");

  const publicUrlRaw =
    optional("PUBLIC_URL") ?? optional("RENDER_EXTERNAL_URL");

  // Validation
  if (!oauthEnabled && !evalToken) {
    throw new Error(
      "No inbound auth path enabled. Set PUBLIC_URL (OAuth, default on) and/or MCP_EVAL_TOKEN (static bearer).",
    );
  }
  if (oauthEnabled && !publicUrlRaw) {
    throw new Error(
      "PUBLIC_URL is required when OAuth is enabled (it is the OAuth issuer + resource identifier). " +
        "Set it to the public HTTPS URL of this server, e.g. https://aquatrack-mcp.fly.dev. " +
        "To run without OAuth, set OAUTH_ENABLED=false and provide MCP_EVAL_TOKEN.",
    );
  }
  if (evalToken && (!serviceEmail || !servicePassword)) {
    throw new Error(
      "MCP_EVAL_TOKEN is set but AQUATRACK_SERVICE_EMAIL / AQUATRACK_SERVICE_PASSWORD are missing. " +
        "The static bearer token maps to this AquaTrack service account.",
    );
  }
  if (evalToken && evalToken.length < 24) {
    throw new Error(
      "MCP_EVAL_TOKEN must be at least 24 characters of high-entropy secret.",
    );
  }

  const port = intEnv("PORT", 3000);
  const publicUrl = (publicUrlRaw ?? `http://localhost:${port}`).replace(
    /\/+$/,
    "",
  );
  let publicHostPort = `localhost:${port}`;
  try {
    const u = new URL(publicUrl);
    publicHostPort = u.host;
    if (
      oauthEnabled &&
      u.protocol !== "https:" &&
      u.hostname !== "localhost" &&
      u.hostname !== "127.0.0.1"
    ) {
      throw new Error(
        `PUBLIC_URL must use https (got ${u.protocol}//). OAuth clients reject non-TLS issuers.`,
      );
    }
  } catch (e) {
    if (e instanceof Error && e.message.startsWith("PUBLIC_URL must use https"))
      throw e;
    throw new Error(`PUBLIC_URL is not a valid URL: "${publicUrl}"`);
  }

  const allowedHosts = list("ALLOWED_HOSTS");
  if (allowedHosts.length === 0) {
    allowedHosts.push(
      publicHostPort,
      `localhost:${port}`,
      `127.0.0.1:${port}`,
      "localhost",
      "127.0.0.1",
    );
  }

  return {
    aquatrackUrl,
    publicUrl,
    port: intEnv("PORT", 3000),
    oauthEnabled,
    evalToken,
    serviceEmail,
    servicePassword,
    requestTimeoutMs: intEnv("AQUATRACK_TIMEOUT_MS", 15_000),
    maxRetries: intEnv("AQUATRACK_MAX_RETRIES", 2),
    allowedOrigins: list("ALLOWED_ORIGINS"),
    allowedHosts,
    dnsRebindingProtection:
      (optional("ENABLE_DNS_REBINDING_PROTECTION") ?? "true").toLowerCase() !==
      "false",
    trustProxy: intEnv("TRUST_PROXY", 1),
    scopesSupported: ["aquatrack:read", "aquatrack:recalculate"],
    resourceName: optional("MCP_RESOURCE_NAME") ?? "AquaTrack",
    serverName: "aquatrack-mcp",
    serverVersion: "2.0.0",
    logLevel: (optional("LOG_LEVEL") as LogLevel) ?? "info",
    accessTokenTtlMs: intEnv("MCP_ACCESS_TOKEN_TTL_MS", 60 * 60 * 1000),
  };
}

export function secretsOf(cfg: Config): string[] {
  return [cfg.servicePassword, cfg.evalToken].filter((s): s is string =>
    Boolean(s),
  );
}
